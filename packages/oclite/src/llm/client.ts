// LlmGateway (ARCHITECTURE §3, §5, §9, §10): model resolution, capability-driven request shaping, the vLLM
// `delta.reasoning` fetch shim, usage estimation, the process-wide per-server queue and the <think> splitter.
import { Effect, Layer, Option, Schema, Semaphore, Stream } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/unstable/http"
import { Auth, LLM, LLMClient, LLMError, type LLMEvent, type LLMRequest, Message, ProviderInternalReason, TransportReason, Usage } from "@opencode-ai/llm"
import { RequestExecutor } from "@opencode-ai/llm/route"
import type { Provider } from "opencode/provider/provider"
import { AppConfig, ConfigError, LlmGateway, type ModelHandle, type ResolvedConfig, type TokenUsage, type TurnRequest } from "../contract"
import type { LoadedConfig } from "../config/config"
import { isLoopback } from "../util/paths"
import { redactUrl, registerSecret } from "../util/redact"
import { type CatalogProvider, catalog } from "./catalog"
import { credential, login, remoteConfig } from "./opencode-auth"
import { type CapabilityRecord, OPTIONAL, persist, probe, staticRecord } from "./probe"
import { splitThink } from "./think"

type Queue = { semaphore: Semaphore.Semaphore; size: number; holders: string[] }

// Process-wide on purpose: every gateway instance (main, sub-agents, side calls, probe) shares one queue per server.
const queues = new Map<string, Queue>()
const notices = new Set<string>()
const COMPATIBLE = "openai-compatible-chat"

const make = Effect.gen(function* () {
  const cfg = yield* AppConfig
  const client = yield* LLMClient.Service
  const handles = new Map<string, ModelHandle>()

  const resolve = (ref: string, opts?: { reprobe?: boolean }) =>
    Effect.gen(function* () {
      const cached = handles.get(ref)
      if (cached && !opts?.reprobe) return cached
      const handle = yield* resolveModel(cfg, ref, opts?.reprobe ?? false)
      handles.set(ref, handle)
      return handle
    })

  const attempt = (handle: ModelHandle, req: TurnRequest, retry: boolean): Stream.Stream<LLMEvent, LLMError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const caps = handle.capabilities
        const request = build(handle, req, effort(cfg, handle.ref))
        const input = caps.usage_in_stream ? 0 : yield* estimateInput(handle, request)
        const seen = { finish: false, out: 0 }
        const limits = streamTimeouts(cfg, handle)
        const fired: { kind?: "header" | "chunk" } = {}
        const timed = withTimeouts(globalThis.fetch, limits, (kind) => (fired.kind = kind))
        const base = client.stream(request).pipe(
          Stream.provideService(FetchHttpClient.Fetch, caps.reasoning_field === "reasoning" ? renameReasoning(timed) : timed),
        )
        return (caps.think_tags && caps.reasoning_field === "none" ? splitThink(base) : base).pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              if (event.type === "finish") seen.finish = true
              if (event.type === "text-delta" || event.type === "reasoning-delta" || event.type === "tool-input-delta") seen.out += event.text.length
            }),
          ),
          Stream.map((event): LLMEvent => {
            if (caps.usage_in_stream || (event.type !== "finish" && event.type !== "step-finish")) return event
            const output = Math.ceil(seen.out / 4)
            return { ...event, usage: new Usage({ inputTokens: input, outputTokens: output, totalTokens: input + output, providerMetadata: { oclite: { estimated: true } } }) }
          }),
          // Bun.serve fakes and some proxies end a dropped stream with a clean EOF: treat "no finish" as a retryable drop.
          Stream.concat(Stream.suspend(() => (seen.finish ? Stream.empty : Stream.fail(new LLMError({ module: "oclite/llm", method: "stream",
            reason: new ProviderInternalReason({ status: 0, message: `stream from ${redactUrl(handle.baseURL)} ended without finish_reason (connection dropped)` }) }))))),
          Stream.catch((error: LLMError) => {
            const params = retry ? rejectedParams(error, request) : []
            if (!params.length) return Stream.fail(error)
            params.forEach((param) => (caps.accepts[param] = false))
            const patch = { accepts: Object.fromEntries(params.map((param) => [param, false])) }
            return Stream.unwrap(persist(handle.baseURL, handle.model.id, patch, "error-400").pipe(Effect.as(attempt(handle, req, false))))
          }),
          // Whatever the aborted fetch or body surfaced as, a fired timer is reported as a Timeout transport error.
          Stream.catchCause((cause) => (fired.kind ? Stream.fail(timeoutError(handle, fired.kind, limits)) : Stream.failCause(cause))),
        )
      }),
    )

  return LlmGateway.of({
    resolve,
    stream: (handle, req) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* permit(queueFor(handle.baseURL, cfg.servers[handle.baseURL]?.concurrency ?? handle.capabilities.concurrency), req.label, req.onQueued)
          return attempt(handle, req, true)
        }),
      ),
    notice: (key) => Effect.sync(() => !notices.has(key) && Boolean(notices.add(key))),
  })

  function estimateInput(handle: ModelHandle, request: LLMRequest) {
    return Effect.gen(function* () {
      const prepared = yield* client.prepare(request).pipe(Effect.option)
      const text = Option.match(prepared, { onNone: () => request.system.map((part) => part.text).join("\n"), onSome: (value) => render(value.body) })
      if (!handle.capabilities.tokenize) return Math.ceil(text.length / 4)
      return yield* Effect.promise(() => tokenize(handle.baseURL, text).catch(() => Math.ceil(text.length / 4)))
    })
  }
})

/** `http` is FetchHttpClient.layer in production; tests may pass another HttpClient layer. */
export function layerWith(http: Layer.Layer<HttpClient.HttpClient>) {
  return Layer.effect(LlmGateway, make).pipe(
    Layer.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer), Layer.provide(http))),
  )
}

export const layer = layerWith(FetchHttpClient.layer)

function resolveModel(cfg: ResolvedConfig, ref: string, reprobe: boolean) {
  return Effect.gen(function* () {
    const [providerID, modelID] = [ref.slice(0, Math.max(0, ref.indexOf("/"))), ref.slice(ref.indexOf("/") + 1)]
    if (!providerID) return yield* new ConfigError({ message: `model "${ref}" must be provider/model` })
    const entry = cfg.provider[providerID] ?? {}
    const options = entry.options ?? {}
    const limits = entry.models?.[modelID]
    const base = options.baseURL?.replace(/\/+$/, "")
    const stock = (yield* Effect.promise(() => catalog()))[providerID]
    // A login for integration `opencode` (no config apiKey or env key beating it) asks /api/config what applies to it.
    const signedIn = providerID === "opencode" && !options.apiKey && !(stock?.env ?? []).some((item) => process.env[item]) ? yield* login() : undefined
    const remote = signedIn ? yield* remoteConfig(signedIn) : undefined
    const item = remote?.providers?.[providerID]
    const patch = item?.models?.[modelID]
    const known = item ? { ...stock, npm: item.npm ?? stock?.npm, api: item.api ?? stock?.api, models: { ...stock?.models } } satisfies CatalogProvider : stock
    const listed = patch ? { ...known?.models?.[modelID], id: patch.id ?? known?.models?.[modelID]?.id, limit: patch.limit ?? known?.models?.[modelID]?.limit, cost: patch.cost ?? known?.models?.[modelID]?.cost,
      reasoning: known?.models?.[modelID]?.reasoning ?? patch.reasoning, provider: patch.provider ? { npm: patch.provider.npm ?? item?.npm, api: patch.provider.api ?? item?.api } : known?.models?.[modelID]?.provider } : known?.models?.[modelID]
    const api = (listed?.provider?.api ?? known?.api)?.replace(/\/+$/, "")
    // The catalog picks npm and limits only while requests go to its own URL; another baseURL is a server you set up.
    const listedURL = Boolean(known) && (!base || base === api)
    const anthropic = providerID === "anthropic" || entry.npm === "@ai-sdk/anthropic"
    // A loopback server you configured keeps today's behaviour: probed openai-compatible, only its own apiKey.
    const loopback = Boolean(base) && !listedURL && !anthropic && isLoopback(base ?? "")
    const npm = loopback ? COMPATIBLE_NPM : entry.npm ?? (listedURL ? listed?.provider?.npm ?? known?.npm : undefined)
      ?? (anthropic ? "@ai-sdk/anthropic" : providerID === "openai" && !base ? "@ai-sdk/openai" : base ? COMPATIBLE_NPM : undefined)
    if (!npm) return yield* new ConfigError({ message: `provider "${providerID}" has no options.baseURL, is not anthropic/openai and is not in opencode's models.dev catalog` })
    if (!NPM.includes(npm)) return yield* new ConfigError({ message: `provider "${providerID}": npm package "${npm}" is not supported by oclite (supported: ${NPM.join(", ")})` })
    const target = base ?? api
    if (npm === COMPATIBLE_NPM && !target) return yield* new ConfigError({ message: `provider "${providerID}" has no options.baseURL` })
    const probed = npm === COMPATIBLE_NPM && !listedURL
    const found = loopback ? undefined : yield* credential(providerID, [...(known?.env ?? []), ...(ENV[npm] ?? [])], options.apiKey)
    // A looked-up credential goes only to the catalog's own URL or a baseURL from the user config, never a project one.
    if (found?.stored && !listedURL && base && base !== (cfg as Partial<LoadedConfig>).userBaseURL?.[providerID])
      return yield* new ConfigError({ message: `provider "${providerID}": not sending your ${found.source} credential to ${redactUrl(base)}, a baseURL from project config; set it in user config or set options.apiKey` })
    if (found?.stored && target && !target.startsWith("https://") && !isLoopback(target))
      return yield* new ConfigError({ message: `provider "${providerID}": not sending your ${found.source} credential over plain http to ${redactUrl(target)}; use an https URL` })
    // What /api/config declared for this URL (opencode: provider and model headers; body options without credentials).
    const declared = listedURL && item ? { ...item.options?.headers as Record<string, string> | undefined, ...patch?.headers } : {}
    Object.values(declared).forEach(registerSecret)
    const headers = { ...declared, ...options.headers }
    const body = listedURL && item ? Object.fromEntries(Object.entries({ ...item.options, ...patch?.options }).filter((entry) => entry[0] !== "apiKey" && entry[0] !== "headers")) : {}
    const apiKey = found?.key ?? (loopback ? options.apiKey : providerID === "opencode" ? "public" : undefined)
    const pins = target ? cfg.servers[target] : undefined
    const context = pins?.context_window ?? limits?.limit?.context ?? (listedURL ? listed?.limit?.context : undefined)
    // opencode caps requested output at 32k whatever the catalog says.
    const output = limits?.limit?.output ?? (listedURL && listed?.limit?.output ? Math.min(listed.limit.output, 32_000) : undefined)
    const model = yield* Effect.promise(() => modelFor(npm, probed, { baseURL: target, apiKey, headers, provider: providerID, id: listedURL ? listed?.id ?? modelID : modelID, context, output }))
    const baseURL = target ?? (anthropic ? "https://api.anthropic.com/v1" : npm === "@ai-sdk/openai" ? "https://api.openai.com/v1" : model.route.endpoint?.baseURL ?? `npm:${npm}`)
    const record = probed ? undefined : staticRecord(baseURL, modelID, { ...pins, context_window: context })
    const capabilities: CapabilityRecord = record
      ? { ...record, npm, auth: found ? found.source + (remote?.label ?? "") : apiKey === "public" ? "public" : "none", ...(Object.keys(headers).length ? { headers: Object.keys(headers) } : {}),
          accepts: npm === COMPATIBLE_NPM && record.sources.accepts === "static" ? { ...record.accepts, chat_template_kwargs: false } : record.accepts }
      : yield* Effect.scoped(
          permit(queueFor(baseURL, pins?.concurrency ?? pins?.capabilities?.concurrency ?? (isLoopback(baseURL) ? 1 : 8)), "probe", () => Effect.void).pipe(
            Effect.andThen(probe({ baseURL, model: modelID, apiKey, headers, reprobe, pins: { ...pins, context_window: context } })),
          ),
        )
    const reasoning = limits?.reasoning ?? (probed ? capabilities.reasoning_field !== "none" || capabilities.think_tags : listedURL && listed?.reasoning === true)
    return {
      ref, model, baseURL, capabilities, reasoning, body,
      local: probed && isLoopback(baseURL),
      contextWindow: capabilities.context_window,
      maxTokens: pins?.max_tokens ?? Math.max(reasoning ? 8192 : 0, output ?? 4096),
    } satisfies ModelHandle
  })
}

const COMPATIBLE_NPM = "@ai-sdk/openai-compatible"
// What LLMNative.model maps (opencode's session/llm/native-request.ts), plus the default env key per package.
const NPM = [COMPATIBLE_NPM, "@ai-sdk/openai", "@ai-sdk/azure", "@ai-sdk/anthropic", "@ai-sdk/google", "@ai-sdk/amazon-bedrock", "@openrouter/ai-sdk-provider"]
const ENV: Record<string, string[]> = { "@ai-sdk/anthropic": ["ANTHROPIC_API_KEY"], "@ai-sdk/openai": ["OPENAI_API_KEY"] }

type ModelInput = { baseURL?: string; apiKey?: string; headers?: Record<string, string>; provider: string; id: string; context?: number; output?: number }

async function modelFor(npm: string, probed: boolean, input: ModelInput) {
  if (!probed) {
    // Lazy: opencode's session code is loaded only for hosted models (startup stays fast for local servers).
    const native = await import("opencode/session/llm/native-request")
    const model = { providerID: input.provider, id: input.id, api: { id: input.id, npm, url: input.baseURL ?? "" }, headers: {}, limit: { context: input.context ?? 0, output: input.output ?? 0 } }
    return native.LLMNative.model({ model: model as unknown as Provider.Model, apiKey: input.apiKey, baseURL: input.baseURL, messages: [] }, input.headers)
  }
  const { configure } = await import("@opencode-ai/llm/providers/openai-compatible")
  // Local servers rarely need a key; without one send no Authorization header instead of failing on a missing credential.
  const auth = input.apiKey ? { apiKey: input.apiKey } : { auth: Auth.none }
  return configure({ baseURL: input.baseURL ?? "", headers: input.headers, provider: input.provider, ...auth }).model(input.id)
}

/** Optional params are sent only when the capability record says the server accepts them (openai-compatible only). */
// reasoning_effort: opt-in per model (provider.<id>.models.<model>.options.reasoning_effort); by ref, so handle copies keep it.
function effort(cfg: ResolvedConfig, ref: string) {
  const model = cfg.provider[ref.slice(0, Math.max(0, ref.indexOf("/")))]?.models?.[ref.slice(ref.indexOf("/") + 1)]
  const value = (model as { options?: { reasoning_effort?: unknown } } | undefined)?.options?.reasoning_effort
  return typeof value === "string" ? value : undefined
}

function build(handle: ModelHandle, req: TurnRequest, reasoningEffort: string | undefined) {
  const caps = handle.capabilities
  const compatible = handle.model.route.id === COMPATIBLE
  const thinking = req.thinking
  const body: Record<string, unknown> = { ...handle.body, ...(compatible ? {
    ...(caps.accepts.chat_template_kwargs && thinking !== undefined ? { chat_template_kwargs: { enable_thinking: thinking } } : {}),
    ...(caps.accepts.prompt_cache_key ? { prompt_cache_key: req.session_id } : {}),
    ...(caps.accepts.reasoning_effort && reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(caps.accepts.parallel_tool_calls && req.tools.length > 0 ? { parallel_tool_calls: false } : {}),
  } : {}) }
  // `/no_think` is model-specific (Qwen templates): only when pinned, and only when enable_thinking can't be sent.
  const suffix = compatible && caps.no_think_suffix && thinking === false && !caps.accepts.chat_template_kwargs
  return LLM.request({
    model: handle.model,
    system: req.system === "" ? undefined : req.system,
    messages: suffix ? noThink(req.messages) : [...req.messages],
    tools: [...req.tools],
    generation: { maxTokens: req.maxTokens ?? handle.maxTokens },
    http: Object.keys(body).length ? { body } : undefined,
  })
}

function noThink(messages: readonly Message[]) {
  const last = messages.findLastIndex((message) => message.role === "user")
  return messages.map((message, index) =>
    index === last ? new Message({ ...message, content: [...message.content, Message.text("\n/no_think")] }) : message,
  )
}

/** Optional params a 400 names (strip them all, retry once: never a blind retry loop). */
function rejectedParams(error: LLMError, request: LLMRequest) {
  if (error.reason._tag !== "InvalidRequest") return []
  const text = error.reason.http?.body ?? error.reason.message
  return OPTIONAL.filter((param) => request.http?.body?.[param] !== undefined && text.includes(param))
}

function queueFor(baseURL: string, size: number) {
  const queue = queues.get(baseURL) ?? { semaphore: Semaphore.makeUnsafe(size), size, holders: [] as string[] }
  queues.set(baseURL, queue)
  return queue
}

/** Holds one permit for the enclosing scope; reports the first holder's label when it has to wait. */
function permit(queue: Queue, label: string, onQueued: (behind: string) => Effect.Effect<void>) {
  return Effect.gen(function* () {
    if (queue.holders.length >= queue.size) yield* onQueued(queue.holders[0] ?? "another request")
    yield* Effect.acquireRelease(
      queue.semaphore.take(1).pipe(Effect.tap(() => Effect.sync(() => queue.holders.push(label)))),
      () => Effect.sync(() => queue.holders.splice(queue.holders.indexOf(label), 1)).pipe(Effect.andThen(queue.semaphore.release(1))),
      { interruptible: true },
    )
  })
}

type Limits = { header: number | false; chunk: number | false }

/**
 * opencode's `provider.<id>.options.headerTimeout` / `chunkTimeout` (ms, false = off). Hosted: 300 s each, as in
 * opencode. Loopback: 30 min to the first byte (llama.cpp sends headers only after prefill, which takes minutes
 * for a large prompt on a slow model) and 10 min between chunks (a thinking model can go quiet that long).
 */
export function streamTimeouts(cfg: ResolvedConfig, handle: Pick<ModelHandle, "ref" | "baseURL">): Limits {
  const options = cfg.provider[handle.ref.slice(0, Math.max(0, handle.ref.indexOf("/")))]?.options
  const local = isLoopback(handle.baseURL)
  return { header: options?.headerTimeout ?? (local ? 1_800_000 : 300_000), chunk: options?.chunkTimeout ?? (local ? 600_000 : 300_000) }
}

function timeoutError(handle: ModelHandle, kind: "header" | "chunk", limits: Limits) {
  const provider = handle.ref.slice(0, Math.max(0, handle.ref.indexOf("/")))
  const url = redactUrl(handle.baseURL)
  const hint = handle.local ? "prefill of a large prompt on a slow local model can take minutes" : "the server may be overloaded"
  const message = kind === "header"
    ? `no response from ${url} within ${Number(limits.header) / 1000} s (${hint}; raise provider.${provider}.options.headerTimeout)`
    : `stream from ${url} stalled: no data for ${Number(limits.chunk) / 1000} s (raise provider.${provider}.options.chunkTimeout)`
  return new LLMError({ module: "oclite/llm", method: "stream", reason: new TransportReason({ message, kind: "Timeout", url }) })
}

/** Header timer until the response arrives, then a chunk timer per body read: any SSE bytes (reasoning too) reset it. */
function withTimeouts(base: typeof fetch, limits: Limits, fired: (kind: "header" | "chunk") => void): typeof fetch {
  return Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const abort = new AbortController()
    const signal = init?.signal ? AbortSignal.any([init.signal, abort.signal]) : abort.signal
    const header = limits.header === false ? undefined : setTimeout(() => {
      fired("header")
      abort.abort()
    }, limits.header)
    // `timeout: false` turns off Bun's own 300 s fetch timeout; these timers replace it.
    const res = await base(input, { ...init, signal, timeout: false } as RequestInit).finally(() => clearTimeout(header))
    const ms = limits.chunk
    if (ms === false || !res.body) return res
    const reader = res.body.getReader()
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
          const timer = setTimeout(() => {
            fired("chunk")
            reject(new Error(`no data for ${ms} ms`))
            abort.abort()
            void reader.cancel().catch(() => undefined)
          }, ms)
          reader.read().then(resolve, reject).finally(() => clearTimeout(timer))
        })
        if (part.done) return controller.close()
        controller.enqueue(part.value)
      },
      cancel: (reason) => reader.cancel(reason),
    })
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
  }, { preconnect: base.preconnect })
}

// vLLM streams `delta.reasoning`; @opencode-ai/llm decodes only `reasoning_content` (ADR). Rename inside SSE lines.
function renameReasoning(base: typeof fetch): typeof fetch {
  return Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await base(input, init)
    if (!res.body || !res.headers.get("content-type")?.includes("event-stream")) return res
    const state = { rest: "" }
    const lines = new TransformStream<string, string>({
      transform: (chunk, controller) => {
        const parts = (state.rest + chunk).split("\n")
        state.rest = parts.pop() ?? ""
        parts.forEach((line) => controller.enqueue(renameLine(line) + "\n"))
      },
      flush: (controller) => controller.enqueue(renameLine(state.rest)),
    })
    const body = res.body.pipeThrough(new TextDecoderStream()).pipeThrough(lines).pipeThrough(new TextEncoderStream())
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
  }, { preconnect: base.preconnect })
}

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

function renameLine(line: string) {
  if (!line.startsWith("data:") || !line.includes('"reasoning"')) return line
  return Option.match(decodeJson(line.slice(5).trim()), {
    onNone: () => line,
    onSome: (value) => {
      const chunk = value as { choices?: Array<{ delta?: Record<string, unknown> }> }
      const choices = (chunk.choices ?? []).map((choice) => {
        if (!choice.delta || choice.delta.reasoning === undefined || choice.delta.reasoning_content !== undefined) return choice
        const { reasoning, ...delta } = choice.delta
        return { ...choice, delta: { ...delta, reasoning_content: reasoning } }
      })
      return `data: ${JSON.stringify({ ...chunk, choices })}`
    },
  })
}

/** Same layout the servers tokenize: system text, tools JSON, then every other message as JSON. */
function render(body: unknown) {
  const value = body as { messages?: Array<{ role: string; content?: unknown }>; tools?: unknown[] }
  const messages = value.messages ?? []
  return [
    ...messages.filter((item) => item.role === "system").map((item) => (typeof item.content === "string" ? item.content : JSON.stringify(item.content))),
    JSON.stringify(value.tools ?? []),
    ...messages.filter((item) => item.role !== "system").map((item) => JSON.stringify(item)),
  ].join("\n")
}

async function tokenize(baseURL: string, content: string) {
  const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }), signal: AbortSignal.timeout(5_000) }
  const body: { tokens?: unknown[] } = await (await fetch(`${new URL(baseURL).origin}/tokenize`, init)).json()
  if (!Array.isArray(body.tokens)) throw new Error("no tokens")
  return body.tokens.length
}

/** LLM Usage → contract TokenUsage; `estimated` when the gateway had to estimate (usage_in_stream=false) or none came. */
export function tokenUsage(usage: Usage | undefined): TokenUsage {
  return {
    input: usage?.inputTokens ?? 0,
    output: usage?.outputTokens ?? 0,
    reasoning: usage?.reasoningTokens,
    cache_read: usage?.cacheReadInputTokens,
    estimated: usage === undefined || usage.providerMetadata?.oclite?.estimated === true,
  }
}

/** One-line notices for the fallbacks this handle engages; print each when `gateway.notice(key)` returns true. */
export function fallbackNotices(handle: ModelHandle) {
  const caps = handle.capabilities
  const compatible = handle.model.route.id === COMPATIBLE
  const notes = "notes" in caps && Array.isArray(caps.notes) ? (caps.notes as string[]) : []
  const items: Array<[string, string] | false> = [
    !caps.tools_native && ["tools_native", "tool calls: text protocol (server has no tool-call parser)"],
    caps.reasoning_field === "reasoning" && ["reasoning_field", "reasoning: reading vLLM delta.reasoning as reasoning_content"],
    caps.reasoning_field === "none" && caps.think_tags && ["think_tags", "reasoning: splitting <think> tags out of the text"],
    !caps.usage_in_stream && ["usage_in_stream", `token counts: estimated (${caps.tokenize ? "/tokenize" : "chars/4"}), marked est.`],
    handle.local && !caps.prefix_cache && ["prefix_cache", "prefix cache: none detected; auto profile is local-min"],
    ...OPTIONAL.map((param): [string, string] | false => compatible && !caps.accepts[param] && [`accepts.${param}`, `request: ${param} not accepted by the server, not sent`]),
    ...notes.map((note): [string, string] => [note, note]),
  ]
  return items.filter((item) => item !== false).map((item) => ({ key: `${redactUrl(handle.baseURL)} ${item[0]}`, message: item[1] }))
}

// The agent loop (ARCHITECTURE §5): one gateway.stream per provider turn; every part is streamed to the sink
// and persisted to JSONL as it completes; the conversation for each turn is rebuilt from JSONL by replay().
import { Effect, Stream } from "effect"
import { isContextOverflow, LLMError, ToolRuntime, type LLMEvent, type Usage } from "@opencode-ai/llm"
import type {
  AgentDef,
  EventSink,
  HooksShape,
  LlmGatewayShape,
  ModelHandle,
  Profile,
  RenderEvent,
  RunResult,
  SessionStoreShape,
  SubagentInfo,
  Thinking,
  TokenUsage,
  ToolSet,
} from "../contract"
import { replay } from "../session/store"
import { notice, type Manager } from "../subagent/manager"
import { outcome } from "../tools/registry"
import { maybe } from "./compaction"
import { reminders } from "./context"

export interface LoopDeps {
  gateway: LlmGatewayShape
  store: SessionStoreShape
  hooks: HooksShape
  subagents: Manager
  /** tools/text-protocol.ts `parse`: at most one call per assistant text. */
  parse: (text: string) => { call?: { name: string; input: unknown }; error?: string }
  /** Persist a context window learned from a 400 (probe cache, source "error-400"). */
  persistContext: (handle: ModelHandle, tokens: number) => Effect.Effect<void>
  /** Backoff before retry n (ms); 2/4/8 s in production, scaled down in tests. */
  retryDelays: readonly number[]
  /** `-p` runs: a call denied DOOM times ends the run at once; the REPL first gets a reminder. */
  headless: boolean
}

export interface LoopInput {
  session_id: string
  agent_path: string[]
  agent: AgentDef
  handle: ModelHandle
  profile: Profile
  system: string
  tools: ToolSet
  cwd: string
  maxTurns: number
  thinking: Thinking
  sink: EventSink
  /** Messages sent with RunHandle.send, drained at each turn boundary. */
  steers: () => Effect.Effect<string[]>
  /** Mirrors step/tokens into RunHandle.status. */
  progress: { step: number; tokens: TokenUsage }
  /** opencode's `doom_loop` permission (default ask) for a call identical to the two before it; false = rejected. */
  doomLoop: (name: string, input: unknown) => Effect.Effect<boolean>
}

/** `protocolFailures` counts like a denial (headless exit 3): the text-protocol run gave up on malformed calls. */
export type LoopResult = Pick<RunResult, "reason" | "text" | "turns" | "usage" | "error"> & { protocolFailures?: number }

type Call = { id: string; name: string; input: unknown }
type Attempt = { text: string; reasoning: string; calls: Call[]; reason: string; usage: TokenUsage }

/** Identical calls before the doom_loop ask, and identical denials before the run stops (REPL: reminder first). */
const DOOM = 3

/** A stream that ended without a finish event: treated like a transport drop and retried. */
class Dropped extends Error {}

export const run = Effect.fn("loop.run")(function* (deps: LoopDeps, input: LoopInput) {
  const emit = (event: DistributiveOmit<RenderEvent, "session_id" | "agent_path">) =>
    input.sink({ ...event, session_id: input.session_id, agent_path: input.agent_path } as RenderEvent)
  const append = deps.store.append.bind(undefined, input.session_id)
  const textProtocol = input.tools.textProtocolPrompt !== undefined
  const initial = replay(yield* deps.store.read(input.session_id), { textProtocol })
  const usage: TokenUsage = { input: 0, output: 0, estimated: false }
  const state = {
    turn: initial.turn,
    steps: 0,
    text: "",
    handle: input.handle,
    todos: JSON.stringify(initial.todos),
    stop: [] as string[],
    finished: [] as SubagentInfo[],
    fresh: true,
    malformed: false,
    overflowed: false,
    unthought: false,
    /** `<key>|ran` or `<key>|denied` per executed call; denials per key; the guard's reminders and stop message. */
    recent: [] as string[],
    denials: new Map<string, number>(),
    notes: [] as string[],
    doomed: undefined as string | undefined,
  }

  const end = (reason: LoopResult["reason"], error?: string, protocolFailures?: number) =>
    Effect.gen(function* () {
      if (error) yield* append({ type: "error", message: error, retryable: false })
      if (error) yield* emit({ type: "error", message: error, retryable: false })
      // Children end with their parent, and their `subagent` rows land before its `end` record.
      yield* deps.subagents.cancelAll(input.session_id)
      yield* append({ type: "end", reason, turns: state.steps, usage })
      return { reason, text: state.text, turns: state.steps, usage, error, protocolFailures } satisfies LoopResult
    })

  const body = Effect.gen(function* () {
    while (true) {
      if (state.steps >= input.maxTurns) return yield* end("max_turns")
      yield* maybe({ ...compactInput(), turn: state.turn }).pipe(
        Effect.catch((error) => emit({ type: "status", phase: "compact", message: `compaction failed: ${error.reason.message}` })),
      )
      const before = replay(yield* deps.store.read(input.session_id), { textProtocol })
      const todos = JSON.stringify(before.todos)
      const envelopes = [...state.finished.splice(0), ...(yield* deps.subagents.takeFinished(input.session_id))].map(notice)
      const reminder = reminders({
        steers: yield* input.steers(),
        envelopes,
        stop: state.stop.splice(0),
        notes: state.notes.splice(0),
        todos: todos !== state.todos ? before.todos : undefined,
      })
      state.todos = todos
      if (reminder) yield* append({ type: "reminder", turn: state.turn, text: reminder })
      const thinking = input.thinking === "auto" ? (state.handle.reasoning ? state.fresh : undefined) : input.thinking === "on"
      const attempt = yield* turnWithRecovery(thinking)
      if (attempt === "retry") continue
      if ("ended" in attempt) return attempt.ended
      state.steps++
      state.fresh = false
      // One overflow recovery per provider turn, not per run: a later turn can overflow again (e.g. a re-run tool).
      state.overflowed = false
      input.progress.step = state.steps
      const calls = textProtocol ? yield* textCall(attempt) : attempt.calls
      if (calls === "malformed") continue
      if (calls === "give-up") return yield* end("error", "model produced a malformed tool call twice", 1)
      if (attempt.text) state.text = attempt.text
      state.turn++
      if (calls.length === 0) {
        // Idle with background children still running: wait for the next finish, then continue with it.
        const waited = yield* nextFinished()
        if (waited.length) {
          state.finished.push(...waited)
          state.fresh = true
          continue
        }
        const outcome = yield* deps.hooks.run("Stop", { session_id: input.session_id, cwd: input.cwd })
        if (outcome.kind !== "block") return yield* end("stop")
        state.stop.push(outcome.message)
        state.fresh = true
        continue
      }
      yield* dispatch(calls, state.turn - 1)
      if (state.doomed) return yield* end("error", state.doomed)
    }
  })

  return yield* body.pipe(
    Effect.onInterrupt(() =>
      deps.subagents.cancelAll(input.session_id).pipe(
        Effect.andThen(append({ type: "end", reason: "cancelled", turns: state.steps, usage })),
        Effect.ignore,
      ),
    ),
  )

  function nextFinished(): Effect.Effect<SubagentInfo[]> {
    return Effect.gen(function* () {
      const taken = yield* deps.subagents.takeFinished(input.session_id)
      if (taken.length || (yield* deps.subagents.running(input.session_id)) === 0) return taken
      yield* Effect.sleep(50)
      return yield* nextFinished()
    })
  }

  function compactInput() {
    return {
      session_id: input.session_id,
      agent_path: input.agent_path,
      agent: input.agent,
      handle: state.handle,
      profile: input.profile,
      system: input.system,
      tools: input.tools.definitions,
      textProtocol,
      gateway: deps.gateway,
      store: deps.store,
      sink: input.sink,
    }
  }

  /**
   * One provider turn plus its recoveries: transport/5xx/drop retries with backoff, one forced compaction on
   * context overflow, one retry with thinking off when a thinking turn ended inside reasoning.
   */
  function turnWithRecovery(thinking: boolean | undefined): Effect.Effect<Attempt | "retry" | { ended: LoopResult }> {
    const attempt = (n: number): Effect.Effect<Attempt | "retry" | { ended: LoopResult }> =>
      stream(thinking).pipe(
        Effect.flatMap((result) => {
          if (thinking !== true || state.unthought || result.text || result.calls.length || !result.reasoning)
            return Effect.succeed(result)
          // Ended inside reasoning (e.g. an unclosed <think> hit max_tokens): retry once with thinking off.
          state.unthought = true
          state.turn++
          return turnWithRecovery(false)
        }),
        Effect.catch((error) => {
          const message = error instanceof LLMError ? error.reason.message : error.message
          state.turn++ // the failed attempt's parts have no step record, so replay drops them
          if (error instanceof LLMError && overflow(error) && !state.overflowed) {
            state.overflowed = true
            return recoverOverflow(message)
          }
          // A timeout is retried once at most: re-sending the same huge prompt mostly repeats the wait.
          const timedOut = error instanceof LLMError && error.reason._tag === "Transport" && error.reason.kind === "Timeout"
          if (!retryable(error) || n >= deps.retryDelays.length || (timedOut && n >= 1))
            return end("error", message).pipe(Effect.map((ended) => ({ ended })))
          const wait = deps.retryDelays[n]!
          return emit({ type: "status", phase: "retry", message: `retrying: ${message}`, attempt: n + 1, wait_ms: wait }).pipe(
            Effect.andThen(Effect.sleep(wait)),
            Effect.andThen(attempt(n + 1)),
          )
        }),
      )
    return attempt(0)
  }

  function recoverOverflow(message: string) {
    return Effect.gen(function* () {
      // OpenAI/vLLM: "maximum context length is N"; llama.cpp: "available context size (N tokens)", "n_ctx":N.
      const found = message.match(/maximum context length is (\d+)|available context size \((\d+) tokens\)|"n_ctx":\s*(\d+)/i)
      const tokens = Number(found?.slice(1).find(Boolean) ?? 0)
      if (tokens > 0) {
        state.handle = { ...state.handle, contextWindow: tokens }
        input.tools.context.tokens = Math.min(input.tools.context.tokens, tokens)
        yield* deps.persistContext(state.handle, tokens)
      }
      const compacted = yield* maybe({ ...compactInput(), turn: state.turn }, true).pipe(Effect.result)
      if (compacted._tag === "Success") return "retry" as const
      return { ended: yield* end("error", `${message} (compaction failed: ${compacted.failure.reason.message})`) }
    })
  }

  function stream(thinking: boolean | undefined) {
    return Effect.gen(function* () {
      const messages = replay(yield* deps.store.read(input.session_id), { textProtocol }).messages
      const turn = state.turn
      const parts = new Map<string, { kind: "text" | "reasoning"; text: string }>()
      const result: Attempt & { finished: boolean } = { text: "", reasoning: "", calls: [], reason: "", usage, finished: false }
      const flush = (id: string) =>
        Effect.gen(function* () {
          const part = parts.get(id)
          parts.delete(id)
          if (part?.text) yield* append({ type: part.kind, turn, text: part.text })
        })
      yield* deps.gateway
        .stream(state.handle, {
          session_id: input.session_id,
          label: input.agent_path.length ? input.agent_path.join("/") : "main agent",
          system: input.system,
          messages,
          tools: input.tools.definitions,
          thinking,
          onQueued: (behind) => emit({ type: "status", phase: "queued", message: `queued behind ${behind}` }),
        })
        .pipe(Stream.runForEach((event) => fold(event)))
      if (!result.finished) return yield* Effect.fail(new Dropped("stream ended before finish"))
      yield* Effect.forEach([...parts.keys()], flush, { discard: true })
      return result

      function fold(event: LLMEvent): Effect.Effect<void> {
        if (event.type === "text-delta" || event.type === "reasoning-delta") {
          const kind = event.type === "text-delta" ? "text" : "reasoning"
          const part = parts.get(event.id) ?? { kind, text: "" }
          parts.set(event.id, { kind, text: part.text + event.text })
          if (kind === "text") result.text += event.text
          if (kind === "reasoning") result.reasoning += event.text
          return emit({ type: kind === "text" ? "text_delta" : "reasoning_delta", text: event.text })
        }
        if (event.type === "text-end" || event.type === "reasoning-end") return flush(event.id)
        if (event.type === "tool-call") {
          result.calls.push({ id: event.id, name: event.name, input: event.input })
          return append({ type: "tool_call", turn, call_id: event.id, name: event.name, input: event.input })
        }
        if (event.type === "provider-error") return Effect.die(new Dropped(event.message))
        if (event.type !== "finish") return Effect.void
        return Effect.gen(function* () {
          yield* Effect.forEach([...parts.keys()], flush, { discard: true })
          const step = tokens(event.usage, messages)
          Object.assign(usage, add(usage, step))
          input.progress.tokens = { ...usage }
          result.reason = event.reason
          result.finished = true
          yield* append({ type: "step", turn, reason: event.reason, usage: step })
          yield* emit({ type: "step_finish", step: state.steps + 1, usage: step })
        })
      }
    }).pipe(Effect.catchDefect((defect) => (defect instanceof Dropped ? Effect.fail(defect) : Effect.die(defect))))
  }

  /** Text protocol: ≤ 1 call parsed from the text; one malformed reply is fed back, a second ends the run. */
  function textCall(attempt: Attempt) {
    return Effect.gen(function* () {
      const parsed = deps.parse(attempt.text)
      if (parsed.call) {
        const call = { id: `call_${state.turn}`, name: parsed.call.name, input: parsed.call.input }
        yield* append({ type: "tool_call", turn: state.turn, call_id: call.id, name: call.name, input: call.input })
        return [call]
      }
      if (!parsed.error) return []
      if (state.malformed) return "give-up" as const
      state.malformed = true
      state.turn++
      yield* append({
        type: "user",
        turn: state.turn,
        synthetic: true,
        text: `Your tool call could not be parsed: ${parsed.error}\nReply with exactly one tool call in the format described in the system prompt, or answer in plain text.`,
      })
      return "malformed" as const
    })
  }

  /** Consecutive read-only calls run concurrently; any other call runs alone, in order. */
  function dispatch(calls: readonly Call[], turn: number) {
    const batches = calls.reduce<Call[][]>((groups, call) => {
      const last = groups.at(-1)
      const parallel = input.tools.readOnly.has(call.name)
      if (last && parallel && input.tools.readOnly.has(last[0]!.name)) last.push(call)
      else groups.push([call])
      return groups
    }, [])
    return Effect.forEach(batches, (batch) => Effect.forEach(batch, (call) => execute(call, turn), { concurrency: "unbounded" }), {
      discard: true,
    })
  }

  function execute(call: Call, turn: number) {
    return Effect.gen(function* () {
      const summary = summarize(call)
      const started = Date.now()
      const key = `${call.name} ${JSON.stringify(call.input)}`
      yield* emit({ type: "tool_start", call_id: call.id, name: call.name, summary })
      // A rule-denied call isn't asked about: the denial guard below handles it.
      const looping = state.recent.length >= DOOM - 1 && state.recent.slice(1 - DOOM).every((item) => item === `${key}|ran`)
      const stopped = looping && !(yield* input.doomLoop(call.name, call.input))
      const text = `doom_loop: ${summary} repeated ${DOOM} times with identical input; running it again was denied. Do not repeat it.`
      const settled = stopped
        ? { status: "denied" as const, text, overflow_path: undefined, bytes: Buffer.byteLength(text) }
        : outcome(yield* ToolRuntime.dispatch(input.tools.tools, { type: "tool-call", ...call }))
      state.recent.push(`${key}|${settled.status === "denied" && !stopped ? "denied" : "ran"}`)
      if (settled.status === "denied") guard(key, call, summary)
      const duration_ms = Date.now() - started
      const status = settled.status
      yield* append({ type: "tool_result", turn, call_id: call.id, name: call.name, status, output: settled.text,
        overflow_path: settled.overflow_path, duration_ms, bytes: settled.bytes })
      yield* emit({ type: "tool_end", call_id: call.id, name: call.name, status, summary, duration_ms, bytes: settled.bytes })
    })
  }

  /** The same call denied DOOM times: headless stops; the REPL is told not to retry and stops after DOOM more. */
  function guard(key: string, call: Call, summary: string) {
    const count = (state.denials.get(key) ?? 0) + 1
    state.denials.set(key, count)
    const stop = `${summary} was denied ${count} times with identical input. To allow it: --allowed-tools "${allowHint(call)}" or a permission rule`
    if (count >= DOOM * 2 || (count === DOOM && deps.headless)) state.doomed = stop
    if (count === DOOM && !deps.headless)
      state.notes.push(`The call ${summary} was denied ${DOOM} times. It is denied and must not be retried; take another approach or ask the user.`)
  }
})

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

function overflow(error: LLMError) {
  return (
    (error.reason._tag === "InvalidRequest" && error.reason.classification === "context-overflow") ||
    isContextOverflow(error.reason.message)
  )
}

function retryable(error: LLMError | Dropped) {
  if (error instanceof Dropped) return true
  return ["Transport", "ProviderInternal", "RateLimit", "InvalidProviderOutput"].includes(error.reason._tag)
}

function tokens(usage: Usage | undefined, messages: unknown): TokenUsage {
  const estimated = usage === undefined || usage.providerMetadata?.oclite?.estimated === true
  return {
    input: usage?.inputTokens ?? Math.ceil(JSON.stringify(messages).length / 4),
    output: usage?.outputTokens ?? 0,
    ...(usage?.reasoningTokens !== undefined ? { reasoning: usage.reasoningTokens } : {}),
    ...(usage?.cacheReadInputTokens !== undefined ? { cache_read: usage.cacheReadInputTokens } : {}),
    estimated,
  }
}

function add(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    ...(a.reasoning !== undefined || b.reasoning !== undefined ? { reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0) } : {}),
    ...(a.cache_read !== undefined || b.cache_read !== undefined ? { cache_read: (a.cache_read ?? 0) + (b.cache_read ?? 0) } : {}),
    estimated: a.estimated || b.estimated,
  }
}

/** `bash(git log*)` for `git log -1 --pretty=%B`; other tools by name. */
function allowHint(call: Call) {
  const command = call.input && typeof call.input === "object" ? (call.input as Record<string, unknown>).command : undefined
  if (call.name !== "bash" || typeof command !== "string") return call.name
  const words = command.trim().split(/\s+/)
  return `bash(${words.slice(0, words.length > 1 && !words[1]!.startsWith("-") ? 2 : 1).join(" ")}*)`
}

function summarize(call: Call) {
  const input = call.input && typeof call.input === "object" ? (call.input as Record<string, unknown>) : {}
  const arg = ["filePath", "path", "pattern", "command", "url", "description", "query"].map((key) => input[key]).find((v) => typeof v === "string")
  return arg ? `${call.name} ${String(arg).split("\n")[0]!.slice(0, 80)}` : call.name
}

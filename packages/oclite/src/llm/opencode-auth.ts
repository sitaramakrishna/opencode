// Credentials for hosted providers: config apiKey, then the catalog's env vars, then opencode's store, read-only
// (opencode.db `credential` → auth.json → OPENCODE_AUTH_CONTENT). Never refreshed or written: OpenCode refresh
// tokens rotate, so a refresh here would sign opencode out. Every value found is registered for redaction.
import { existsSync } from "fs"
import path from "path"
import { Effect, Option } from "effect"
import { ConfigError } from "../contract"
import { isLoopback } from "../util/paths"
import { redactUrl, registerSecret } from "../util/redact"
import { decodeJson, opencodeDb, opencodeDir } from "./catalog"

type Stored = { type?: unknown; key?: unknown; token?: unknown; access?: unknown; expires?: unknown; metadata?: { server?: unknown; orgID?: unknown } }
export type Credential = { key: string; source: string; stored: boolean }

export function credential(id: string, env: readonly string[], configKey?: string) {
  return Effect.gen(function* () {
    if (configKey) return { key: configKey, source: "config apiKey", stored: false } satisfies Credential
    const name = env.find((item) => process.env[item])
    if (name) return { key: registered(process.env[name] ?? ""), source: `env ${name}`, stored: true } satisfies Credential
    const found = yield* Effect.promise(() => stored(id))
    if (!found) return undefined
    return { key: registered(yield* secret(id, found.value)), source: `${found.source} ${String(found.value.type)}`, stored: true } satisfies Credential
  })
}

function registered(key: string) {
  registerSecret(key)
  return key
}

// Newest row per integration first, the order opencode's Integration.connection.active uses.
async function stored(id: string) {
  const row = opencodeDb<{ value: string }>("select value from credential where integration_id = ? order by time_created desc, rowid desc limit 1", id)[0]
  if (row) return { value: Option.getOrElse(decodeJson(row.value), () => ({})) as Stored, source: "opencode.db" }
  const file = path.join(opencodeDir(), "auth.json")
  const read = (text: string, source: string) => Object.entries(Option.getOrElse(decodeJson(text), () => ({})) as Record<string, Stored>).map(([key, value]) => [key, { value, source }] as const)
  const files = Object.fromEntries([...read(process.env.OPENCODE_AUTH_CONTENT ?? "{}", "OPENCODE_AUTH_CONTENT"), ...read(existsSync(file) ? await Bun.file(file).text() : "{}", "auth.json")])
  return files[id]
}

function secret(id: string, value: Stored) {
  if ((value.type === "key" || value.type === "api") && typeof value.key === "string") return Effect.succeed(value.key)
  if (value.type === "wellknown" && typeof value.token === "string") return Effect.succeed(value.token)
  if (value.type === "oauth" && typeof value.access === "string" && typeof value.expires === "number" && value.expires > Date.now() + 60_000) return Effect.succeed(value.access)
  if (value.type === "oauth") return Effect.fail(new ConfigError({ message: `opencode login for "${id}" expired — run opencode once to refresh it, then retry` }))
  return Effect.fail(new ConfigError({ message: `opencode credential for "${id}" has type "${String(value.type)}", which oclite can't use; set provider.${id}.options.apiKey or its env var` }))
}

// opencode's `/api/config` step (core/src/plugin/provider/opencode.ts fetchProviders): an OAuth or service-account login for
// integration `opencode` asks `${metadata.server}/api/config` which providers, urls, packages and headers apply to it.
export type RemoteModel = { id?: string; reasoning?: boolean; limit?: { context?: number; output?: number }; cost?: { input?: number; output?: number }
  provider?: { npm?: string; api?: string }; headers?: Record<string, string>; options?: Record<string, unknown> }
export type RemoteProvider = { npm?: string; api?: string; options?: Record<string, unknown>; models?: Record<string, RemoteModel> }
export type Login = { token: string; server: string; orgID?: string }
type Fetched = { status: number; providers?: Record<string, RemoteProvider> }

// One request per process and server; the credential is only read, never refreshed or written.
const fetched = new Map<string, Promise<Fetched>>()

/** The `opencode` integration login in opencode.db (oauth, or a service-account key); undefined without one. */
export function login() {
  return Effect.gen(function* () {
    const found = yield* Effect.promise(() => stored("opencode"))
    if (!found || found.source !== "opencode.db" || (found.value.type !== "oauth" && found.value.type !== "key")) return undefined
    const server = typeof found.value.metadata?.server === "string" ? found.value.metadata.server : "https://opencode.ai/console"
    if (!server.startsWith("https://") && !isLoopback(server))
      return yield* new ConfigError({ message: `opencode login: not sending your credential to ${redactUrl(server)}; its server must be https` })
    const orgID = typeof found.value.metadata?.orgID === "string" ? found.value.metadata.orgID : undefined
    if (orgID) registerSecret(orgID)
    return { token: registered(yield* secret("opencode", found.value)), server: server.replace(/\/+$/, ""), orgID } satisfies Login
  })
}

/** `providers` from /api/config; `label` extends the auth label. 404: catalog defaults (as opencode); 401/403: error. */
export function remoteConfig(login: Login) {
  return Effect.gen(function* () {
    const key = `${login.server}\n${login.orgID ?? ""}`
    const request = fetched.get(key) ?? fetch(`${login.server}/api/config`, {
      headers: { accept: "application/json", authorization: `Bearer ${login.token}`, ...(login.orgID ? { "x-org-id": login.orgID } : {}) },
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    }).then(async (res) => ({ status: res.status, providers: res.ok ? ((await res.json()) as { config?: { provider?: Record<string, RemoteProvider> } }).config?.provider : undefined }))
      .catch((): Fetched => ({ status: 0 }))
    fetched.set(key, request)
    const response = yield* Effect.promise(() => request)
    if (response.status === 401 || response.status === 403)
      return yield* new ConfigError({ message: `opencode login rejected by ${redactUrl(login.server)}/api/config (HTTP ${response.status}) — run opencode once to refresh the login, then retry` })
    if (response.providers) return { providers: response.providers, label: " + api/config" }
    if (response.status === 404) return { providers: undefined, label: "" }
    return { providers: undefined, label: ` (api/config unavailable: ${response.status ? `HTTP ${response.status}` : "no response"}, catalog defaults)` }
  })
}

// Hosted models via opencode: catalog + credential reuse against fixture stores (temp XDG dirs) and test/lib/local-server.ts.
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdirSync } from "fs"
import path from "path"
import { oclite } from "../lib/cli"
import { startLocalServer } from "../lib/local-server"
import { tmpdir } from "../lib/tmp"

const TOKEN = "zen-test-token-0123456789"
const MODEL = "opencode/free-model"
const ORG = "org-test-0123456789"
const LIMITS = { context: 123_456, output: 20_000 }

type Row = { id: string; integration: string; time: number; value: Record<string, unknown> }
const oauth = (access: string, expires: number) => ({ type: "oauth", methodID: "device", refresh: "refresh-secret-0123456789", access, expires, metadata: {} })

type Setup = { rows?: Row[]; authJson?: Record<string, unknown>; npm?: string; provider?: Record<string, unknown>; user?: Record<string, unknown>
  /** Sign in as opencode would (oauth row, metadata.server = the fake) and answer /api/config; `catalogAPI` replaces the catalog url. */
  remote?: { status: number; body?: (url: string) => unknown }; catalogAPI?: string }

async function setup(input: Setup = {}) {
  const server = await startLocalServer()
  if (input.remote) server.set({ api_config: { status: input.remote.status, body: input.remote.body?.(server.url) } })
  // Rows without a server would make oclite ask the real opencode.ai: point them at the fake (it answers 404 unless api_config is set).
  const origin = server.url.replace(/\/v1$/, "")
  const point = (row: Row) => (row.integration === "opencode" ? { ...row, value: { ...row.value, metadata: { server: origin, ...(row.value.metadata as object) } } } : row)
  const rows = [...(input.rows ?? []).map(point), ...(input.remote ? [{ id: "r1", integration: "opencode", time: 1, value: { ...oauth(TOKEN, Date.now() + 3_600_000), metadata: { server: origin, orgID: ORG } } }] : [])]
  const project = await tmpdir({ git: true })
  const home = await tmpdir()
  const dir = path.join(home.path, ".local/share/opencode")
  mkdirSync(dir, { recursive: true })
  const catalog = { opencode: { npm: input.npm ?? "@ai-sdk/openai-compatible", api: input.catalogAPI ?? server.url, env: ["ZEN_TEST_KEY"], models: { "free-model": { id: "free-model", reasoning: true, limit: LIMITS, cost: { input: 0, output: 0 } } } } }
  const db = new Database(path.join(dir, "opencode.db"))
  db.run("create table kv (key text primary key, value text not null, time_created integer not null, time_updated integer not null)")
  db.run("create table credential (id text primary key, integration_id text, label text not null, value text not null, connector_id text, method_id text, active integer, time_created integer not null, time_updated integer not null)")
  db.run("insert into kv values (?, ?, 0, 0)", ["models-dev:catalog", JSON.stringify({ body: JSON.stringify(catalog), digest: "x", updatedAt: 0 })])
  rows.forEach((row) => db.run("insert into credential values (?, ?, 'x', ?, null, null, 0, ?, ?)", [row.id, row.integration, JSON.stringify(row.value), row.time, row.time]))
  db.close()
  if (input.authJson) await Bun.write(path.join(dir, "auth.json"), JSON.stringify(input.authJson))
  if (input.user) await Bun.write(path.join(home.path, ".config/oclite/config.json"), JSON.stringify(input.user))
  await project.write(".oclite/config.json", JSON.stringify({ model: MODEL, ...(input.provider ? { provider: input.provider } : {}) }).replaceAll("$URL", server.url))
  return {
    server,
    run: (args: string[], env: Record<string, string> = {}) => oclite(args, { cwd: project.path, home: home.path, env: { OCLITE_TRUST_PROJECT: "1", ...env } }),
    [Symbol.asyncDispose]: async () => {
      await server.stop()
      await project[Symbol.asyncDispose]()
      await home[Symbol.asyncDispose]()
    },
  }
}

const live = [{ id: "c1", integration: "opencode", time: 1, value: oauth(TOKEN, Date.now() + 3_600_000) }]
const ask = ["-p", "Reply with: ok", "--max-turns", "1"]

describe("hosted catalog providers", () => {
  test("opencode.db oauth: bearer header arrives, nothing is probed, the token never reaches output", async () => {
    await using env = await setup({ rows: live })
    const result = await env.run(ask)
    expect(result.code).toBe(0)
    expect(env.server.chats()[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(env.server.requests.map((item) => item.path)).toEqual(["/api/config", "/v1/chat/completions"])
    expect(result.stdout + result.stderr).not.toContain(TOKEN)
  })

  test("the newest credential row wins", async () => {
    await using env = await setup({ rows: [{ id: "a", integration: "opencode", time: 5, value: oauth("older-token-0123456789", Date.now() + 3_600_000) }, { id: "b", integration: "opencode", time: 9, value: oauth(TOKEN, Date.now() + 3_600_000) }] })
    await env.run(ask)
    expect(env.server.chats()[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`)
  })

  test("env var from the catalog beats the store; config apiKey beats both", async () => {
    await using env = await setup({ rows: live })
    await env.run(ask, { ZEN_TEST_KEY: "env-key-0123456789" })
    expect(env.server.chats()[0]?.headers.authorization).toBe("Bearer env-key-0123456789")
    await using configured = await setup({ rows: live, provider: { opencode: { options: { apiKey: "config-key-0123456789" } } } })
    await configured.run(ask, { ZEN_TEST_KEY: "env-key-0123456789" })
    expect(configured.server.chats()[0]?.headers.authorization).toBe("Bearer config-key-0123456789")
  })

  test("auth.json (v1 store) is the fallback when the database has no row", async () => {
    await using env = await setup({ authJson: { opencode: { type: "api", key: "file-key-0123456789" } } })
    await env.run(ask)
    expect(env.server.chats()[0]?.headers.authorization).toBe("Bearer file-key-0123456789")
  })

  test("expired oauth fails with the run-opencode hint and sends nothing", async () => {
    await using env = await setup({ rows: [{ id: "c1", integration: "opencode", time: 1, value: oauth(TOKEN, Date.now() - 1000) }] })
    const result = await env.run(ask)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('opencode login for "opencode" expired — run opencode once to refresh it, then retry')
    expect(result.stdout + result.stderr).not.toContain(TOKEN)
    expect(env.server.requests.length).toBe(0)
  })

  test('zen without any login sends "public"', async () => {
    await using env = await setup()
    await env.run(ask)
    expect(env.server.chats()[0]?.headers.authorization).toBe("Bearer public")
  })

  test("catalog limits drive context and max tokens; the label says where the credential came from", async () => {
    await using env = await setup({ rows: live })
    const result = await env.run(["debug", "server", "--model", MODEL])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`auth opencode.db oauth · context ${LIMITS.context} · max_tokens ${LIMITS.output}`)
    expect(result.stdout).toContain("@ai-sdk/openai-compatible")
    expect(result.stdout).not.toContain(TOKEN)
    expect(env.server.requests.map((item) => item.path)).toEqual(["/api/config"])
    const json = await env.run(["debug", "server", "--model", MODEL, "--output-format", "json"])
    expect(json.stdout).not.toContain(TOKEN)
    expect(JSON.parse(json.stdout)).toMatchObject({ context_window: LIMITS.context, auth: "opencode.db oauth" })
  })

  test("a config limit still wins over the catalog", async () => {
    await using env = await setup({ rows: live, provider: { opencode: { models: { "free-model": { limit: { context: 5000, output: 9000 } } } } } })
    const result = await env.run(["debug", "server", "--model", MODEL])
    expect(result.stdout).toContain("context 5000 · max_tokens 9000")
  })

  test("a project baseURL override never gets the credential", async () => {
    await using env = await setup({ rows: live, provider: { opencode: { options: { baseURL: "https://proxy.invalid/v1" } } } })
    const result = await env.run(["debug", "server", "--model", MODEL])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("not sending your opencode.db oauth credential")
    expect(result.stderr).toContain("project config")
    expect(result.stdout + result.stderr).not.toContain(TOKEN)
  })

  test("the same override from the user config does get it", async () => {
    await using env = await setup({ rows: live, user: { provider: { opencode: { npm: "@ai-sdk/openai", options: { baseURL: "https://proxy.invalid/v1" } } } } })
    const result = await env.run(["debug", "server", "--model", MODEL])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("auth opencode.db oauth")
    expect(result.stdout).not.toContain(TOKEN)
  })

  test("an npm package oclite can't build is a clear config error", async () => {
    await using env = await setup({ npm: "@ai-sdk/github-copilot", rows: live })
    const result = await env.run(["debug", "server", "--model", MODEL])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('npm package "@ai-sdk/github-copilot" is not supported')
  })

  test("loopback servers keep today's behaviour: probed, local, no looked-up credential", async () => {
    await using other = await setup({
      rows: [{ id: "l", integration: "local", time: 2, value: oauth("local-token-0123456789", Date.now() + 3_600_000) }],
      provider: { local: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "$URL" }, models: { "test-model": { reasoning: true } } } },
    })
    const result = await other.run(["debug", "server", "--model", "local/test-model"])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("(loopback)")
    expect(result.stdout).not.toContain("hosted")
    expect(other.server.requests.length).toBeGreaterThan(0)
    expect(other.server.requests.every((item) => item.headers.authorization === undefined)).toBe(true)
  })
})

// opencode's `/api/config` step: the login asks its server which url, package and headers apply to the provider.
describe("opencode /api/config", () => {
  const CATALOG = "https://catalog.invalid/v1"
  const remote = (url: string) => ({ config: { provider: { opencode: {
    npm: "@ai-sdk/openai-compatible", api: url,
    options: { apiKey: "remote-key-0123456789", headers: { "x-remote-org": "remote-org-0123456789" }, custom_flag: true },
    models: { "free-model": { id: "real-model", headers: { "x-model-header": "m1" }, options: { model_flag: 7 }, limit: { context: 77_777, output: 9000 } } },
  } } } })

  test("the login's bearer and x-org-id go to /api/config; its url, npm, headers and body options reach the model request", async () => {
    await using env = await setup({ npm: "@ai-sdk/github-copilot", catalogAPI: CATALOG, remote: { status: 200, body: remote } })
    const result = await env.run(ask)
    expect(result.code).toBe(0)
    const config = env.server.requests.filter((item) => item.path === "/api/config")
    expect(config.length).toBe(1)
    expect(config[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(config[0]?.headers["x-org-id"]).toBe(ORG)
    const chat = env.server.chats()[0]!
    expect(chat.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(chat.headers["x-remote-org"]).toBe("remote-org-0123456789")
    expect(chat.headers["x-model-header"]).toBe("m1")
    expect(chat.body?.model).toBe("real-model")
    expect(chat.body).toMatchObject({ custom_flag: true, model_flag: 7 })
    expect(JSON.stringify(chat.body)).not.toContain("remote-key-0123456789")
    expect(JSON.stringify(chat.headers)).not.toContain("remote-key-0123456789")
    expect(result.stdout + result.stderr).not.toContain(TOKEN)
  })

  test("debug server labels the step, names the headers and prints no token, org id or header value", async () => {
    await using env = await setup({ npm: "@ai-sdk/github-copilot", catalogAPI: CATALOG, remote: { status: 200, body: remote } })
    const text = await env.run(["debug", "server", "--model", MODEL])
    expect(text.code).toBe(0)
    expect(text.stdout).toContain("auth opencode.db oauth + api/config · headers x-remote-org,x-model-header · context 77777 · max_tokens 9000")
    expect(text.stdout).toContain(`server ${env.server.url}`)
    const json = await env.run(["debug", "server", "--model", MODEL, "--output-format", "json"])
    const all = text.stdout + text.stderr + json.stdout + json.stderr
    ;[TOKEN, ORG, "remote-org-0123456789", "remote-key-0123456789"].forEach((secret) => expect(all).not.toContain(secret))
    expect(JSON.parse(json.stdout)).toMatchObject({ auth: "opencode.db oauth + api/config", headers: ["x-remote-org", "x-model-header"] })
  })

  test("404 continues with the catalog defaults, as opencode does", async () => {
    await using env = await setup({ remote: { status: 404 } })
    const result = await env.run(ask)
    expect(result.code).toBe(0)
    expect(env.server.requests.filter((item) => item.path === "/api/config").length).toBe(1)
    const chat = env.server.chats()[0]!
    expect(chat.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(chat.headers["x-remote-org"]).toBeUndefined()
    const debug = await env.run(["debug", "server", "--model", MODEL])
    expect(debug.stdout).toContain("auth opencode.db oauth · context")
  })

  test("401 and 403 are a clear error that points to opencode, and no model request is sent", async () => {
    await Promise.all([401, 403].map(async (status) => {
      await using env = await setup({ remote: { status } })
      const result = await env.run(ask)
      expect(result.code).toBe(2)
      expect(result.stderr).toContain(`rejected by ${env.server.url.replace(/\/v1$/, "")}/api/config (HTTP ${status}) — run opencode once to refresh the login`)
      expect(result.stdout + result.stderr).not.toContain(TOKEN)
      expect(env.server.chats().length).toBe(0)
    }))
  })

  test("a config apiKey or a catalog env key skips the step", async () => {
    await using env = await setup({ remote: { status: 200, body: remote } })
    await env.run(ask, { ZEN_TEST_KEY: "env-key-0123456789" })
    expect(env.server.requests.filter((item) => item.path === "/api/config").length).toBe(0)
    expect(env.server.chats()[0]?.headers.authorization).toBe("Bearer env-key-0123456789")
  })

  test("a project baseURL override still gets neither the credential nor the remote headers", async () => {
    await using env = await setup({ remote: { status: 200, body: remote }, provider: { opencode: { options: { baseURL: "https://proxy.invalid/v1" } } } })
    const result = await env.run(["debug", "server", "--model", MODEL])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("not sending your opencode.db oauth credential")
  })

  test("loopback servers never trigger it", async () => {
    await using env = await setup({ remote: { status: 200, body: remote }, provider: { local: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "$URL" }, models: { "test-model": { reasoning: true } } } } })
    const result = await env.run(["debug", "server", "--model", "local/test-model"])
    expect(result.code).toBe(0)
    expect(env.server.requests.some((item) => item.path === "/api/config")).toBe(false)
    expect(env.server.requests.every((item) => item.headers.authorization === undefined && item.headers["x-remote-org"] === undefined)).toBe(true)
  })
})

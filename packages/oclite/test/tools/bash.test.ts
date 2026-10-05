import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../lib/tmp"
import type { AskRequest, RenderEvent, ResolvedConfig } from "../../src/contract"
import { killAll } from "../../src/tools/bash"
import { config, rtkPath, scriptedAsker, toolset } from "./harness"

const allowBash = (cwd: string) => config(cwd, { permission: [{ permission: "bash", pattern: "*", action: "allow" }] })

function alive(pid: number) {
  // Signal 0 only checks that the process exists.
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("bash", () => {
  test("runs in cwd or workdir, merges stderr, reports a non-zero exit", async () => {
    await using dir = await tmpdir({ files: { "sub/x.txt": "x" } })
    const tools = await toolset(allowBash(dir.path))
    expect((await tools.call("bash", { command: "pwd" })).text).toBe(dir.path)
    expect((await tools.call("bash", { command: "ls", workdir: "sub" })).text).toBe("x.txt")
    const failed = await tools.call("bash", { command: "echo out; echo err >&2; exit 3" })
    expect(failed.status).toBe("ok")
    expect(failed.text).toBe("out\nerr\n\n(exit code 3)")
  })

  test("timeout kills the whole process group, including children", async () => {
    await using dir = await tmpdir()
    const tools = await toolset(allowBash(dir.path))
    const pidFile = path.join(dir.path, "child.pid")
    const started = Date.now()
    const result = await tools.call("bash", { command: `sleep 30 & echo $! > ${pidFile}; wait`, timeout: 500 })
    expect(result.status).toBe("timeout")
    expect(result.text).toBe("timed out after 0.5 s")
    expect(Date.now() - started).toBeLessThan(5000)
    const child = Number((await Bun.file(pidFile).text()).trim())
    await Bun.sleep(100)
    expect(alive(child)).toBe(false)
  })

  test("default mode asks for bash; headless rejects it", async () => {
    await using dir = await tmpdir()
    const tools = await toolset(config(dir.path))
    const result = await tools.call("bash", { command: "echo hi" })
    expect(result.status).toBe("denied")
    expect(result.text).toBe("permission denied: bash echo hi")
  })

  test("always for a wrapped or complex command persists nothing; for a plain one, the command prefix", async () => {
    await using dir = await tmpdir()
    const seen: AskRequest[] = []
    const tools = await toolset(config(dir.path), { asker: scriptedAsker(["always", "always", "always"], seen) })
    await tools.call("bash", { command: "bash -c 'npm test'" })
    await tools.call("bash", { command: "npm test && echo ok" })
    await tools.call("bash", { command: "npm test" })
    expect(seen.map((request) => request.always)).toEqual([[], [], ["npm test *"]])
    // Neither complex "always" granted anything: the wrapped form asks again.
    await tools.call("bash", { command: "bash -c 'npm test'" })
    expect(seen).toHaveLength(4)
  })

  test("--allowed-tools bash(git *) allows git but not a chained command", async () => {
    await using dir = await tmpdir()
    const { cliRules } = await import("../../src/config/config")
    const tools = await toolset(config(dir.path, { cliRules: cliRules(["bash(git *)"], "allow") }))
    expect((await tools.call("bash", { command: "git --version" })).text).toStartWith("git version")
    const chained = await tools.call("bash", { command: "git status; touch pwned" })
    expect(chained.text).toBe("permission denied: bash <complex> git status touch pwned")
    expect(await Bun.file(path.join(dir.path, "pwned")).exists()).toBe(false)
  })
})

describe("rtk rewrite", () => {
  const rtkOn = (cwd: string, overrides: Partial<ResolvedConfig> = {}) =>
    config(cwd, { rtk: "auto", permission: [{ permission: "bash", pattern: "*", action: "allow" }], ...overrides })
  const notices = (events: RenderEvent[]) =>
    events.flatMap((event) => (event.type === "status" && event.phase === "notice" ? [event.message] : []))

  test("rewrites a command rtk handles, runs others unchanged, and calls the same rtk binary", async () => {
    await using dir = await tmpdir()
    await using _path = await rtkPath()
    const tools = await toolset(rtkOn(dir.path))
    expect((await tools.call("bash", { command: "ls -la" })).text).toBe("REWRITTEN")
    expect((await tools.call("bash", { command: "echo plain" })).text).toBe("plain")
    expect((await tools.call("bash", { command: "whoami" })).text).toBe("FAKE-RTK self")
    expect(notices(tools.events)).toEqual(["rtk: ls -la → echo REWRITTEN", "rtk: whoami → rtk self"])
  })

  test("rtk: false disables it", async () => {
    await using dir = await tmpdir()
    await using _path = await rtkPath()
    const off = await toolset(rtkOn(dir.path, { rtk: false }))
    expect((await off.call("bash", { command: "ls" })).text).toBe("(no output)")
    expect(notices(off.events)).toEqual([])
  })

  test("rtk missing: auto is silent, true gives one notice; both run the command unchanged", async () => {
    await using dir = await tmpdir()
    await using _missing = await rtkPath({ missing: true })
    const auto = await toolset(rtkOn(dir.path))
    expect((await auto.call("bash", { command: "ls" })).text).toBe("(no output)")
    const forced = await toolset(rtkOn(dir.path, { rtk: true }))
    expect((await forced.call("bash", { command: "ls" })).text).toBe("(no output)")
    expect((await forced.call("bash", { command: "ls" })).text).toBe("(no output)")
    expect(notices(auto.events)).toEqual([])
    expect(notices(forced.events)).toEqual(["rtk: true but rtk is not on PATH; running commands unchanged"])
  })

  test("permission and PreToolUse see the original command; a rewrite never widens what is allowed", async () => {
    await using dir = await tmpdir()
    await using _path = await rtkPath()
    const seen = path.join(dir.path, "hook.json")
    const hooks = { PreToolUse: [{ matcher: "*", command: `cat > ${seen}`, timeout_ms: 5000 }], PostToolUse: [], Stop: [] }
    // Allowed as `ls *`; the rewritten `echo REWRITTEN` would not be.
    const allowed = await toolset(rtkOn(dir.path, { permission: [{ permission: "bash", pattern: "ls *", action: "allow" }], hooks }))
    expect((await allowed.call("bash", { command: "ls -la" })).text).toBe("REWRITTEN")
    expect(JSON.parse(await Bun.file(seen).text()).tool_input.command).toBe("ls -la")
    // Only the rewritten form is allowed: the original is still not, so headless denies it and nothing runs.
    const widened = await toolset(rtkOn(dir.path, { permission: [{ permission: "bash", pattern: "echo *", action: "allow" }] }))
    expect((await widened.call("bash", { command: "ls -la" })).text).toBe("permission denied: bash ls -la")
    const denied = await toolset(
      rtkOn(dir.path, { permission: [{ permission: "bash", pattern: "*", action: "allow" }, { permission: "bash", pattern: "ls *", action: "deny" }] }),
    )
    expect((await denied.call("bash", { command: "ls -la" })).status).toBe("denied")
    expect([...notices(widened.events), ...notices(denied.events)]).toEqual([])
  })
})

describe("process groups and env", () => {
  test("killAll() kills running bash process groups", async () => {
    await using dir = await tmpdir()
    const tools = await toolset(allowBash(dir.path))
    const pidFile = path.join(dir.path, "pid")
    const started = Date.now()
    const pending = tools.call("bash", { command: `sleep 30 & echo $! > ${pidFile}; wait` })
    await Bun.sleep(300)
    killAll()
    const result = await pending
    expect(Date.now() - started).toBeLessThan(5000)
    expect(result.text).toContain("exit code")
    expect(alive(Number((await Bun.file(pidFile).text()).trim()))).toBe(false)
  })

  test("OCLITE_MCP_TOKEN is not passed to bash", async () => {
    await using dir = await tmpdir()
    const previous = process.env.OCLITE_MCP_TOKEN
    process.env.OCLITE_MCP_TOKEN = "tok_should_not_leak"
    const tools = await toolset(allowBash(dir.path))
    const result = await tools.call("bash", { command: 'echo "${OCLITE_MCP_TOKEN:-unset} $HOME"' })
    if (previous === undefined) delete process.env.OCLITE_MCP_TOKEN
    if (previous !== undefined) process.env.OCLITE_MCP_TOKEN = previous
    expect(result.text).toBe(`unset ${process.env.HOME}`)
  })
})

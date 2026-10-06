import path from "path"
import { Effect, Exit, Schema } from "effect"
import type { ResolvedConfig, RunToolContext } from "../contract"
import { childEnv, killGroup, track } from "../hooks/hooks"
import { mentionsEnv } from "../permission/permission"
import { define } from "./fs"

// ---- permission patterns ----
// A shell metacharacter can chain or redirect, so such commands never match an allow glob like `git status*`.
// Also complex: a backslash anywhere, or a quote inside a word (`r''m`), since both can disguise a command name.
const COMPLEX = /[;&|><\n`()\\]|\$\(|\w['"]+\w/
const SEPARATORS = /\|\||&&|\$\(|[;&|\n`()]/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
// Heads that run another command given as arguments; the wrapped command becomes a segment of its own.
const WRAPPERS = new Set(
  "bash sh zsh dash ksh fish eval exec xargs env command sudo doas nohup time timeout nice watch builtin source .".split(
    " ",
  ),
)

export { killAll } from "../hooks/hooks"

export const DEFAULT_TIMEOUT_MS = 120_000
const SHELL = Bun.which("bash") ?? "/bin/sh"

// Same parameters as opencode's shell tool (tool/shell/prompt.ts parameterSchema).
const Parameters = Schema.Struct({
  command: Schema.String.annotate({ description: "The command to execute" }),
  timeout: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
    description: "Optional timeout in milliseconds",
  }),
  workdir: Schema.optional(Schema.String).annotate({
    description:
      "The working directory to run the command in. Defaults to the current directory. Use this instead of 'cd' commands.",
  }),
})

const warned = { rtk: false }

export function bashTool(ctx: RunToolContext, setting: ResolvedConfig["rtk"] = "auto") {
  const workdir = (dir: string | undefined) => path.resolve(ctx.cwd, dir ?? ".")
  // Resolved once per run. A rewritten command runs with this binary's dir first on PATH, so it calls the same rtk.
  const rtk = setting === false ? undefined : (Bun.which("rtk", { PATH: process.env.PATH ?? "" }) ?? undefined)
  const notice = (message: string) =>
    ctx.sink({ session_id: ctx.session_id, agent_path: [ctx.agent.name], type: "status", phase: "notice", message })
  return define({
    name: "bash",
    parameters: Parameters,
    readOnly: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    // The registry's timeout interrupts `execute`, whose finalizer kills the whole process group.
    timeoutFor: (params) => params.timeout ?? DEFAULT_TIMEOUT_MS,
    access: (params) => {
      const patterns = bashPatterns(params.command)
      return { permission: "bash", patterns, always: patterns[0] === "<complex>" ? [] : [prefix(patterns[0])] }
    },
    summarize: (params) => `bash ${params.command.split("\n")[0].slice(0, 80)}`,
    paths: (params) => [{ path: workdir(params.workdir), kind: "directory" }],
    envFiles: (params) => (mentionsEnv(params.command) ? [".env"] : []),
    // Permission and PreToolUse already ran on the model's command; the executed command is the inspected
    // command, optionally prefixed by `rtk `.
    execute: (params) =>
      Effect.gen(function* () {
        if (setting === true && !rtk && !warned.rtk) {
          warned.rtk = true
          yield* notice("rtk: true but rtk is not on PATH; running commands unchanged")
        }
        const command = rtk
          ? yield* Effect.promise(() => rewrite(rtk, params.command).catch(() => params.command))
          : params.command
        const env = childEnv()
        const expected = `rtk ${params.command.trim()}`
        if (rtk && command !== params.command && command !== expected) {
          yield* notice(`rtk: ignored rewrite of "${params.command}" (not "rtk <command>")`)
          return yield* run(params.command, workdir(params.workdir), env)
        }
        if (rtk && command !== params.command) {
          yield* notice(`rtk: ${params.command} → ${command}`)
          env.PATH = `${path.dirname(rtk)}${path.delimiter}${env.PATH ?? ""}`
        }
        return yield* run(command, workdir(params.workdir), env)
      }),
  })
}

function run(command: string, cwd: string, env: Record<string, string | undefined>) {
  return Effect.acquireUseRelease(
    // Own process group (detached) so a timeout or cancel reaches every child, not just the shell.
    Effect.sync(() => {
      const proc = Bun.spawn([SHELL, "-c", `exec 2>&1\n${command}`], { cwd, env, stdin: "ignore", stdout: "pipe", detached: true })
      track(proc)
      return proc
    }),
    (proc) =>
      Effect.promise(async () => {
        const [output, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
        const text = output.trimEnd() || "(no output)"
        return code === 0 ? text : `${text}\n\n(exit code ${code})`
      }),
    (proc, exit) => Effect.sync(() => (Exit.isSuccess(exit) ? undefined : killGroup(proc.pid))),
  )
}

// `rtk rewrite` must print exactly `rtk <command>` and exit 0; non-zero, empty, a 2 s timeout, a spawn error,
// or any other output all keep the original command, so the executed command is the inspected command,
// optionally prefixed by `rtk `.
async function rewrite(rtk: string, command: string) {
  const proc = Bun.spawn([rtk, "rewrite", command], { env: childEnv(), stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 2000 })
  const [output, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return code === 0 && output.trim() ? output.trim() : command
}

// `always` for a simple command covers the same command and subcommand: `git status -s` → `git status *`.
function prefix(command: string) {
  const words = command.split(/\s+/)
  const head = words[1] && !words[1].startsWith("-") ? words.slice(0, 2) : words.slice(0, 1)
  return `${head.join(" ")} *`
}

/**
 * Bash permission patterns: the command itself, or, when it chains, pipes, redirects, substitutes, wraps another
 * command (`bash -c`, `xargs`, `sudo`, …) or is obfuscated, `<complex>` plus each segment (naive split, subshell
 * bodies, wrapper heads stripped). Every pattern must be allowed and any deny wins, and `<complex>` never matches an
 * allow like `git status*`.
 *
 * This is a regex heuristic, not a shell parser, so it is not airtight: a deny glob layered under a broad allow or
 * bypassPermissions is best-effort. The real guard is the default `ask` for bash plus read_only's blanket deny.
 */
export function bashPatterns(command: string) {
  const trimmed = command.trim()
  const joined = trimmed.replace(/\\\n/g, "")
  const segments = joined
    .split(SEPARATORS)
    .map((segment) => segment.trim())
    .filter(Boolean)
  const variants = segments.flatMap(unwrap)
  const complex = COMPLEX.test(trimmed) || variants.length > segments.length
  if (!complex) return [trimmed]
  return ["<complex>", ...new Set(variants)]
}

// A segment plus the forms a deny glob should see: head unquoted (`\rm` → `rm`) and wrapper heads stripped.
function unwrap(segment: string): string[] {
  const tokens = segment.split(/\s+/)
  const body = tokens.slice(
    Math.max(
      0,
      tokens.findIndex((token) => !ASSIGNMENT.test(token)),
    ),
  )
  const head = body[0].replace(/['"\\]/g, "")
  const plain = [head, ...body.slice(1)].join(" ")
  const forms = plain === segment ? [segment] : [segment, plain]
  if (!WRAPPERS.has(head)) return forms
  const rest = body.slice(1)
  const start = rest.findIndex((token) => !/^(-|\d+$)/.test(token) && !ASSIGNMENT.test(token))
  const inner =
    start === -1
      ? ""
      : rest
          .slice(start)
          .join(" ")
          .replace(/^['"]|['"]$/g, "")
          .trim()
  return [...forms, ...(inner ? unwrap(inner) : [])]
}

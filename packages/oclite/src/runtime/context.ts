// System prompt layering and reminders (SPEC "Context engineering" 1–3, ARCHITECTURE §8 instructions).
// Fixed, cache-friendly order: harness → agent prompt → tool protocol → instruction files → env block → style.
// The prompt is computed once per run and never changes within it; volatile content goes into reminders.
import { stat } from "fs/promises"
import os from "os"
import path from "path"
import type { AgentDef, Profile, ResolvedConfig } from "../contract"
import { envFile } from "../config/config"
import { ancestors, configDir } from "../util/paths"

export interface SystemInput {
  harness: string
  agent: AgentDef
  cfg: ResolvedConfig
  profile: Profile
  /** ToolSet.textProtocolPrompt, when the server has no tool-call parser. */
  textProtocolPrompt?: string
  /** Instructions of MCP servers whose tools are in the first request (mcp/tools.ts mcpForRun). */
  mcpInstructions?: readonly string[]
  /** Run depth; > 0 is a sub-agent (in-process or a `transport: mcp` child, which starts at OCLITE_DEPTH). */
  depth?: number
  home?: string
  now?: Date
}

// Caveman response style (config `style`). Prose only; a sub-agent's final message is the parent's task result.
const CAVEMAN = {
  lite: "Respond concise. Drop filler, pleasantries, hedging; keep full sentences.",
  full: "Respond terse. Drop articles, filler, pleasantries, hedging. Fragments OK. Short words.\nPattern: [thing] [action] [reason]. [next step].",
  ultra: "Respond max-compressed. No articles, filler, hedging. Fragments, abbreviations, → OK.\nPattern: [thing] [action] [reason]. [next].",
}

function caveman(cfg: ResolvedConfig, depth: number) {
  const style = cfg.style
  if (!style || style.caveman === "off" || (style.scope === "subagents" && depth === 0)) return undefined
  return [
    "# Response style",
    CAVEMAN[style.caveman],
    "Keep exact: code, commands, file paths, identifiers, error messages, numbers.",
    "Use normal clear prose for security warnings, destructive or irreversible actions, and steps where order matters.",
    "Code, commits and file contents: write normally. Style applies to prose only.",
  ].join("\n")
}

export interface System {
  text: string
  instructions: string[]
  branch?: string
  /** One notice at most: instruction files cut to the profile cap. */
  notices: string[]
}

export async function system(input: SystemInput): Promise<System> {
  const files = await instructions(input)
  const branch = await gitBranch(input.cfg.projectRoot)
  const text = [
    input.harness,
    input.agent.prompt,
    input.textProtocolPrompt,
    ...files.parts,
    ...(input.mcpInstructions ?? []).map(neutralize),
    input.cfg.appendSystemPrompt,
    env(input.cfg.cwd, branch, input.now ?? new Date()),
    // Last, after the stable sections: fixed for the whole run, so the prefix stays byte-stable.
    caveman(input.cfg, input.depth ?? 0),
  ]
    .map((part) => part?.trim())
    .filter((part) => !!part)
    .join("\n\n")
  const cap = input.profile.instructionCapChars
  return {
    text,
    instructions: files.paths,
    branch,
    notices: files.cut.length ? [`instruction files cut to ${cap} chars (${input.profile.name}): ${files.cut.join(", ")}`] : [],
  }
}

/** AGENTS.md (else CLAUDE.md) per directory from projectRoot down to cwd, then home files, then cfg.instructions. */
async function instructions(input: SystemInput) {
  const home = input.home ?? os.homedir()
  const dirs = ancestors(input.cfg.cwd)
  const within = dirs.slice(0, dirs.indexOf(input.cfg.projectRoot) + 1 || 1).toReversed()
  const project = await Promise.all(
    within.map(async (dir) => {
      const agents = path.join(dir, "AGENTS.md")
      if (await Bun.file(agents).exists()) return agents
      const claude = path.join(dir, "CLAUDE.md")
      return (await Bun.file(claude).exists()) ? claude : undefined
    }),
  )
  const candidates = [
    ...project,
    path.join(input.home ? path.join(input.home, ".config", "oclite") : configDir(), "AGENTS.md"),
    path.join(home, ".claude", "CLAUDE.md"),
    // config/config.ts already filters these; the .env guard is repeated here as defence in depth.
    ...input.cfg.instructions.map((file) => path.resolve(input.cfg.projectRoot, file)).filter((file) => !envFile(file)),
  ].filter((file): file is string => file !== undefined)
  const unique = [...new Set(candidates)]
  const loaded = await Promise.all(
    unique.map(async (file) => ((await Bun.file(file).exists()) ? { file, text: await Bun.file(file).text() } : undefined)),
  )
  const cap = input.profile.instructionCapChars
  const found = loaded.filter((item) => item !== undefined && item.text.trim() !== "") as Array<{ file: string; text: string }>
  return {
    paths: found.map((item) => item.file),
    cut: found.filter((item) => cap !== undefined && item.text.length > cap).map((item) => item.file),
    parts: found.map((item) => {
      const text = cap !== undefined && item.text.length > cap ? item.text.slice(0, cap) + "\n…[truncated]" : item.text
      return `Instructions from: ${item.file}\n${text.trim()}`
    }),
  }
}

/** Date only (YYYY-MM-DD, local time), never a timestamp, so the prefix stays byte-stable all day. */
function env(cwd: string, branch: string | undefined, now: Date) {
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
  return [
    "<env>",
    `Working directory: ${cwd}`,
    `Platform: ${process.platform}`,
    `Today's date: ${date}`,
    ...(branch ? [`Git branch: ${branch}`] : []),
    "</env>",
  ].join("\n")
}

/** Reads .git/HEAD directly (no git spawn). Handles worktrees (`.git` file with `gitdir:`) and detached HEADs. */
export async function gitBranch(root: string): Promise<string | undefined> {
  const dotgit = path.join(root, ".git")
  const info = await stat(dotgit).catch(() => undefined)
  if (!info) return undefined
  const gitdir = info.isFile() ? (await Bun.file(dotgit).text()).match(/^gitdir:\s*(.+)$/m)?.[1]?.trim() : dotgit
  if (!gitdir) return undefined
  const head = Bun.file(path.resolve(root, gitdir, "HEAD"))
  if (!(await head.exists())) return undefined
  const text = (await head.text()).trim()
  return text.match(/^ref:\s*refs\/heads\/(.+)$/)?.[1] ?? (text.length >= 7 ? text.slice(0, 7) : undefined)
}

export interface ReminderInput {
  steers: readonly string[]
  envelopes: readonly string[]
  stop: readonly string[]
  /** Harness notices for the model (the doom-loop guard). */
  notes?: readonly string[]
  /** Only when the todo list changed since the last reminder. */
  todos?: readonly unknown[]
}

/** Volatile content for the last user message at a turn boundary; undefined when there is nothing to say. */
export function reminders(input: ReminderInput) {
  const blocks = [
    ...input.steers.map((text) => `The user sent a new message while you were working:\n${text}`),
    ...input.envelopes,
    ...input.stop.map((text) => `A Stop hook blocked ending the turn:\n${text}`),
    ...(input.notes ?? []),
    ...(input.todos && input.todos.length ? [`Current todo list:\n${todoLines(input.todos)}`] : []),
  ]
  if (!blocks.length) return undefined
  return blocks.map((block) => `<system-reminder>\n${block}\n</system-reminder>`).join("\n")
}

/**
 * Untrusted text (handbacks, MCP instructions) can't open or close the harness's own blocks: `<` of reminder, task
 * and tool-result tags becomes `‹`, so a child can't forge a `</task>…<system-reminder>` inside its envelope.
 */
export function neutralize(text: string) {
  return text.replace(/<(\/?)(system-reminder|task_result|task_error|task|tool_result)\b/gi, "‹$1$2")
}

function todoLines(todos: readonly unknown[]) {
  return todos
    .map((todo) => {
      if (!todo || typeof todo !== "object") return `- ${String(todo)}`
      const item = todo as Record<string, unknown>
      return `- [${String(item.status ?? "pending")}] ${String(item.content ?? JSON.stringify(todo))}`
    })
    .join("\n")
}

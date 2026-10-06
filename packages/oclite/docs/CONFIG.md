# oclite configuration reference

oclite reads JSON (comments and trailing commas are allowed, as in `opencode.jsonc`). Where a field exists in
opencode too (`model`, `provider`, `mcp`, `permission`, `agent`, `instructions`), it has the same shape, so blocks
can be copied between the two.

## Files, layering and precedence

Low → high:

1. Built-in defaults (below).
2. User config: `~/.config/oclite/config.json` (`$XDG_CONFIG_HOME/oclite/config.json`).
3. Project config: `<projectRoot>/.oclite/config.json`. `projectRoot` is the nearest ancestor of the working
   directory that holds `.oclite/` or `.git`, else the working directory. Subject to [project trust](#project-trust).
4. Each `--mcp-config` (repeatable), which only contributes MCP servers.
5. CLI flags: `--model`, `--profile`, `--agent`, `--permission-mode`, `--allowed-tools`, `--disallowed-tools`,
   `--max-turns`, `--thinking`, `--no-thinking`, `--append-system-prompt`.

Merge rules:
- Objects merge deeply; a later layer overrides single keys.
- `instructions` arrays concatenate. Other arrays are replaced.
- `mcp` entries replace **per server**: a project entry named `github` replaces the user entry named `github`
  entirely, so a `local` entry never picks up fields from a `remote` one.
- `--strict-mcp-config` drops `mcp` from layers 2 and 3.

`oclite mcp add` / `mcp remove` edit layer 2 (`--scope user`) or layer 3 (`--scope project`, the default). They
keep `{env:…}` references as written, but don't preserve comments.

## Substitution: `{env:NAME}` and `{file:path}`

Applied to the raw text of each config file (and inline `--mcp-config` JSON) before parsing, as in opencode:

- `{env:NAME}` → the value of the environment variable, or an empty string when unset.
- `{file:path}` → the trimmed contents of the file, JSON-escaped. Relative paths resolve against the config file's
  directory; `~/` is the home directory. A missing file is a config error (exit 2). References on lines that
  start with `//` are left alone.

```jsonc
{ "provider": { "anthropic": { "options": { "apiKey": "{env:MY_ANTHROPIC_KEY}" } } },
  "mcp": { "github": { "type": "remote", "url": "https://api.githubcopilot.com/mcp/",
                        "headers": { "Authorization": "Bearer {file:~/.secrets/gh-token}" } } } }
```

In an untrusted project config, substitution is not applied (see below).

## Project trust

A cloned repository can carry `.oclite/config.json` and agent files, and some of their settings run code or send
data. So the project layer and project agent files (`.oclite/agents`, `.opencode/agent(s)`, `.claude/agents`)
start out **untrusted**. Until you approve them, oclite ignores these settings from them:

- `provider`, `mcp`, `hooks`, `servers`;
- `allow` rules in `permission` (deny and ask rules still apply);
- `{file:}` and `{env:}` substitution;
- agent `transport` and `mcp` (the agent runs in-process).

How trust is granted:
- The REPL (on a TTY) asks once: "This project's config defines <what>. Trust <root>? [y/N]". `y` records it.
- `-p`, `mcp serve`, `mcp list` and a non-TTY REPL never prompt. They skip the settings above and print
  ``untrusted project <root>: ignored <what> from its config; run `oclite trust` to trust it, or --trust-project for one run``.
- `oclite trust [path] [--yes]` shows what the project sets and records trust in `~/.config/oclite/trusted.json`,
  keyed by the project root's real path, with a sha256 of `.oclite/config.json`, the project agent files and the
  instruction files that config names. Any change to those files makes the project untrusted again.
- `--trust-project` (or `OCLITE_TRUST_PROJECT=1`) trusts the project for one run without recording it.

User-level config (`~/.config/oclite/…`) and `--mcp-config` are always trusted.

## Top-level fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `$schema` | string | – | Ignored |
| `model` | `"provider/model"` | `anthropic/claude-sonnet-5` | Model for agents without their own `model`. `--model` overrides it |
| `small_model` | `"provider/model"` | – | Used by the built-in `explore` agent when that agent sets no `model` |
| `profile` | `default` \| `local` \| `local-min` | automatic | Force a profile (README → Profiles). `--profile` overrides it |
| `default_agent` | string | `build` | Primary agent. `--agent` overrides it. Unknown names are a config error |
| `provider` | object | `{}` | [Providers](#provider) |
| `mcp` | object | `{}` | [MCP servers](#mcp), opencode's shape |
| `permission` | object or action | – | [Permission rules](#permission), opencode's shape |
| `agent` | object | – | Per-agent field overrides, opencode's `ConfigAgentV1` shape ([Agents](#agents)) |
| `instructions` | string[] | `[]` | Extra instruction files. Relative paths resolve against the file that lists them; concatenated across layers |
| `hooks` | object | – | `PreToolUse`, `PostToolUse`, `Stop` lists ([HOOKS.md](HOOKS.md)) |
| `servers` | object | `{}` | [Per-server capability pins](#servers) |
| `permission_timeout_ms` | integer | `300000` | How long an ask waits (REPL, MCP elicitation or `agent_permission_reply`) before it's denied |
| `subagent.max_depth` | integer | `2` | Nesting limit for sub-agents (the parent agent's `max_depth` can lower it) |
| `subagent.max_concurrent` | integer | `4` | Running sub-agents per parent; extras wait as `pending` |
| `rtk` | `"auto"` \| `true` \| `false` | `"auto"` | Rewrite `bash` commands through `rtk rewrite` ([below](#rtk-and-style)) |
| `style.caveman` | `off` \| `lite` \| `full` \| `ultra` | `off` | Terse-prose rule block in the system prompt ([below](#rtk-and-style)) |
| `style.scope` | `subagents` \| `all` | `subagents` | Which sessions get the caveman block |

Unknown keys are ignored.

## `rtk` and `style`

**`rtk`.** `rtk` is a CLI proxy that compresses command output for LLMs.
`"auto"` turns the rewrite on when `rtk` resolves on PATH (looked up once per run, so every sub-agent run checks
too); `true` does the same but prints one notice if rtk is missing (commands then run unchanged); `false` turns it
off. Before spawning, the `bash` tool runs `rtk rewrite <command>` (2 s timeout). Exit 0 with non-empty output that
differs → the rewritten command runs, with the resolved rtk's directory first on that spawn's PATH so it calls the
same binary, and a `rtk: <original> → <rewritten>` notice is shown. Anything else (exit 1, timeout, empty
output, spawn error) → the original runs. The tool result is the command's output; the session's `tool_call`
record keeps the original command.

*Security invariant:* the permission check and PreToolUse hooks see the model's **original** command, exactly as
without rtk. The rewrite happens after approval and never widens what's allowed: a rule `bash: {"ls *": "allow"}`
still allows `ls -la` even though `rtk ls -la` wouldn't match it, a denied original stays denied, and a rule that
would allow only the rewritten form grants nothing. Unlike Claude Code's rtk hook, a rewrite is never
auto-approved. The rewrite is rtk's own mapping, so trusting rtk on PATH is part of enabling it.

**`style`.** `caveman` appends a short "Response style" block (about 360–420 chars) at the very end of the system
prompt, after the env block, so the cached prefix ahead of it is unchanged. `lite` drops filler and hedging but
keeps grammar; `full` allows fragments and short words in a `[thing] [action] [reason]. [next step].` pattern;
`ultra` adds abbreviations and arrows. All levels keep code, commands, paths, identifiers, errors and numbers exact,
use normal prose for security warnings, destructive or irreversible actions and ordered steps, and leave code,
commits and file contents alone. With `scope: "subagents"` only runs at depth > 0 get it (`task` children at any
depth, and `transport: mcp` children, which start at `OCLITE_DEPTH`); `"all"` adds it to the main agent too, and
`oclite debug prompt` then shows it.

## `provider`

```jsonc
"provider": {
  "<id>": {
    "npm": "@ai-sdk/anthropic",            // optional; only "@ai-sdk/anthropic" changes behaviour (see below)
    "options": {
      "baseURL": "http://127.0.0.1:8000/v1",
      "apiKey": "{env:LOCAL_KEY}",          // optional for local servers (no Authorization header without it)
      "headers": { "X-Team": "infra" },
      "headerTimeout": 1800000,             // ms to the first response byte; false = no limit
      "chunkTimeout": 600000                // ms between streamed chunks; false = no limit
    },
    "models": {
      "<model id>": {
        "limit": { "context": 32768, "output": 4096 },
        "reasoning": true,                   // force the reasoning-model treatment (max_tokens ≥ 8192)
        "options": { "reasoning_effort": "low" }   // sent only if the server accepts it
      }
    }
  }
}
```

How a `provider/model` ref resolves:
- `anthropic/…`, or any provider with `npm: "@ai-sdk/anthropic"` → Anthropic API. Key: `options.apiKey`, else
  `ANTHROPIC_API_KEY`. `options.baseURL` is optional.
- `openai/…` without `options.baseURL` → OpenAI API. Key: `options.apiKey`, else `OPENAI_API_KEY`.
- Anything else with `options.baseURL` (including `openai` with a baseURL) → openai-compatible chat completions.
  These servers are probed (README → What you'll see and why). A loopback base URL makes the automatic profile `local`.
- Anything else without `options.baseURL` → the cached opencode catalog decides (below); not in it → config error (exit 2).

Hosted providers aren't probed. They get a static capability record (context 200,000 unless
`models.<id>.limit.context` or a `servers` pin says otherwise).

`max_tokens` per request: `servers[<url>].max_tokens`, else `models.<id>.limit.output`, else 4096; at least 8192
for reasoning models (`reasoning: true`, or a local server where the probe saw reasoning output).

API keys, header values and credentials in `baseURL` are registered as secrets and redacted everywhere.

### Hosted catalog providers and opencode credentials

Any provider in opencode's **cached** models.dev catalog (OpenCode Zen as `opencode`, `google`, `amazon-bedrock`,
`azure`, `openrouter`, `xai`, other openai-compatible ones) works without a `baseURL`.

- **Catalog source**, read-only and never fetched: `$XDG_DATA_HOME/opencode/opencode.db` (`kv['models-dev:catalog']`),
  else `models.json` (`$OPENCODE_MODELS_PATH`, default `$XDG_CACHE_HOME/opencode/models.json`). Run opencode once to
  create or refresh it. It supplies `npm`, `api` (the base URL), `env`, `limit.context`, `limit.output` and `reasoning`.
  `provider.<id>.models.<m>.limit`, `reasoning` and `servers` pins still win.
- **npm**: `provider.<id>.npm`, else the catalog model's `provider.npm`, else the catalog provider's `npm`.
  Supported: `@ai-sdk/openai`, `azure`, `anthropic`, `google`, `amazon-bedrock`, `openai-compatible`,
  `@openrouter/ai-sdk-provider`. Anything else is a config error (exit 2).
- **baseURL**: `options.baseURL`, else the catalog `api`. Catalog-known models are not probed, get the `default`
  profile and a static capability record. `max_tokens` is the catalog output limit capped at 32,000 (as opencode does).
- **Credential order**: `options.apiKey`; then the catalog's `env` variables (and `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY` for those packages); then opencode's store: `opencode.db` table `credential` (newest row for the
  provider id), `auth.json` (`type` `api`/`wellknown`/`oauth`), `OPENCODE_AUTH_CONTENT`. Zen with none of these sends
  `"public"`, which works for free models only (a paid model is rejected by the server with an auth error).
- **OAuth expiry**: the stored `access` token is used while it has more than a minute left. Otherwise oclite fails with
  `opencode login for "<id>" expired — run opencode once to refresh it, then retry`. oclite never refreshes (opencode's
  refresh tokens rotate) and never writes opencode's files.
- **Security rule**: a looked-up credential (env or store) is attached only when the effective baseURL equals the
  catalog's `api` for that provider, or comes from the **user** config layer. A project-config `baseURL` for such a
  provider is an error (`not sending your … credential to …, a baseURL from project config`); set it in user config or
  put `options.apiKey` next to it. A looked-up credential (env or store) is never sent to a non-loopback http URL (resolution fails with `not sending your … credential over plain http …; use an https URL`). A loopback `baseURL` that is not the catalog's `api` behaves as before (probed, only
  `options.apiKey`). Looked-up values are registered as secrets: they never appear in `debug server`, `debug prompt`,
  stream-json, errors or logs; `debug server` shows only a label (`opencode.db oauth`, `env NAME`, `config apiKey`, `public`).

- **`/api/config` step** (provider `opencode` only). When the credential is the `opencode` integration login in
  `opencode.db` (OAuth, or a service-account `key` row) and no `options.apiKey` or catalog env key (`OPENCODE_API_KEY`)
  wins, oclite does what opencode does: `GET ${metadata.server}/api/config` (default server
  `https://opencode.ai/console`, must be https or loopback) with `Authorization: Bearer <access or key>` and
  `x-org-id: <metadata.orgID>` when present. The login is only read. The call runs once per process (10 s timeout) and the
  result is kept in memory; there is no on-disk cache. Its `config.provider.<id>` then overrides the catalog for that
  provider: `api` url, `npm`, `options.headers` (sent as request headers), other `options` (merged into the request body;
  `apiKey` and `headers` are dropped, the login stays the credential) and per model `id`, `provider.npm/api` (the
  provider's `api` when a model has none), `headers`, `options`, `limit`, `cost`. Your own `options.headers` win over
  remote headers. The login goes only to the url `/api/config` (or the catalog) declares, or to a user-config baseURL;
  a baseURL override ignores the remote headers and options. `debug server` shows `auth opencode.db oauth + api/config`
  and the remote header **names** (never values). **Failures:** 404 continues with catalog defaults (as opencode);
  401/403 stops with `opencode login rejected by …/api/config (HTTP n) — run opencode once to refresh the login`;
  another status, a timeout or a network error continues with catalog defaults and says so in the auth label.
- **Zen free tier**: not usable from oclite. Zen answers the `"public"` key (and free models without an app login)
  with `403 FreeTierError: OpenCode's free tier can only be used from within OpenCode`. oclite adds no client-identity
  headers of its own and does not try to get around that. Paid Zen models work through your login and `/api/config`.

**Streaming timeouts.** `options.headerTimeout` and `options.chunkTimeout` use opencode's names and shape (ms,
`false` = off), so the same block works in both tools. `headerTimeout` is the wait from sending the request to the
first response byte. llama.cpp sends headers only once generation starts, so it covers prefill. `chunkTimeout` is the
longest gap between streamed chunks; reasoning deltas count as chunks, so a thinking model keeps the stream alive.

| Base URL | `headerTimeout` | `chunkTimeout` |
|---|---|---|
| hosted or remote (opencode's default) | 300000 (5 min) | 300000 (5 min) |
| loopback (`localhost`, `127.*`, `::1`) | 1800000 (30 min) | 600000 (10 min) |

The loopback defaults are long because a cold ~60k-token prompt on a slow local model can take about 6 minutes to
prefill, and a thinking model can produce hundreds of reasoning tokens before any visible text. On timeout the turn
fails with, for example, `no response from http://127.0.0.1:8080/v1 within 1800 s (prefill of a large prompt on a
slow local model can take minutes; raise provider.local.options.headerTimeout)`. A timeout is retried once at most;
re-sending the same large prompt mostly repeats the wait. These timers replace Bun's built-in 300 s fetch timeout.

## `mcp`

opencode's `ConfigMCPV1` shape, unchanged:

```jsonc
"mcp": {
  "fs": {
    "type": "local",
    "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."],
    "environment": { "LOG_LEVEL": "warn" },   // added to oclite's own environment
    "cwd": "tools",                           // optional; relative to the working directory
    "enabled": true,
    "timeout": 30000                          // ms per request and for connect
  },
  "github": {
    "type": "remote",
    "url": "https://api.githubcopilot.com/mcp/",
    "headers": { "Authorization": "Bearer {env:GITHUB_TOKEN}" },
    "oauth": { "clientId": "…", "clientSecret": "…", "scope": "…", "callbackPort": 19876, "redirectUri": "…" },
    // or "oauth": false to turn off OAuth detection
    "enabled": true,
    "timeout": 30000
  }
}
```

- `timeout` defaults to 30,000 ms in oclite (opencode's code default; the 5,000 in opencode's schema text isn't
  used). Progress notifications from the server reset it; a single call is capped at 10× the timeout.
- Remote servers try StreamableHTTP, then SSE, and stop at the first auth error (`needs_auth`; run
  `oclite mcp auth <name>`). OAuth tokens are stored in opencode's `~/.local/share/opencode/mcp-auth.json`.
- `environment` values are redacted everywhere, whatever their key. `OCLITE_MCP_TOKEN` is never passed to stdio
  servers.
- In the `local` and `local-min` profiles, MCP tool schemas are deferred behind `tool_search`. Its description lists
  the deferred tool names per server (names only, no schemas), fixed for the run so the request prefix stays
  byte-stable: `Find MCP tools by keyword; matches load next turn. Tools: context7: query-docs, resolve-library-id;
  git: git_add, git_branch, …`. Over 400 chars it lists only server names and tool counts (`git (12 tools)`).
  A prompt that names a server as MCP (`git mcp`, `mcp server git`, `mcp__git__…`) loads that server's tools from
  the first request. The `default` profile sends every MCP schema and has no `tool_search`.
- `--mcp-config` also accepts Claude Code's `{"mcpServers": {...}}`. Entries with a `url` (and `type` other than
  `stdio`) become `remote`; the rest become `local` with `command: [command, ...args]` and `environment: env`.

## `permission`

opencode's shape: a single action (`"ask"`, `"allow"`, `"deny"`) for everything, or an object keyed by permission
name, each either an action or a `{pattern: action}` map. Key order is kept; the **last** matching rule wins.

```jsonc
"permission": {
  "bash": { "*": "ask", "git status*": "allow", "git push*": "deny" },
  "edit": "ask",
  "webfetch": "allow",
  "mcp__github__*": "ask",
  "external_directory": { "~/scratch/*": "allow" }
}
```

Permission names are the tool names: `read`, `write`, `edit`, `glob`, `grep`, `bash`, `task` (pattern: the
sub-agent name), `webfetch` (pattern: the URL), `todowrite`, `skill`, `tool_search`, `mcp__<server>__<tool>`, plus
`external_directory` (pattern: `<dir>/*` for paths outside the working directory and project root). For `bash`,
the pattern is the command. A command with shell metacharacters or wrappers is matched as `<complex>` plus each
segment. See the README's Security notes for why bash deny rules are best-effort.

`webfetch` to a loopback, link-local or private address is refused unless a rule allows that exact origin, e.g.
`"webfetch": {"http://127.0.0.1:3000/*": "allow"}` (a plain `"webfetch": "allow"` isn't enough). An `always` reply
approves one origin. Redirects (max 5) are checked the same way.

Built-in defaults: everything asks, except `read`, `glob`, `grep`, `todowrite`, `skill` and `tool_search`, which are
allowed. Reading `.env` / `.env.*` asks (`.env.example` and `.env.sample` are allowed), and any other tool whose path
or bash command names a `.env` file is also checked as a `read` of it. Paths are resolved through symlinks first.

Where rules come from, in evaluation order (later wins): defaults → config `permission` → agent `permission` →
permission mode → parent session (for sub-agents) → `--allowed-tools` / `--disallowed-tools` → read_only rules →
`--disallowed-tools` again → inherited parent denies. So `--disallowed-tools` and a parent's denies always win,
and `--allowed-tools` can't lift read_only. Note that `bypassPermissions` comes after config and agent rules, so it
overrides their denies.

**Repeated calls (`doom_loop`).** As in opencode, a call identical to the two before it (same tool, same input)
checks the `doom_loop` permission first (pattern: the tool name; default `ask`, so `-p` rejects it and counts a
denial). Set `"doom_loop": "allow"` to turn the check off. Separately, a call denied 3 times with identical input in
one run isn't retried forever: a `-p` run ends at once with exit 3 and a message naming the call and how to allow it,
e.g. `stopped: bash git log -1 --pretty=%B was denied 3 times with identical input. To allow it: --allowed-tools
"bash(git log*)" or a permission rule`. In the REPL the model gets a `<system-reminder>` that the call is denied and
must not be retried, and the run stops after 3 more identical denials.

`--allowed-tools` / `--disallowed-tools` take comma- or space-separated rules: `read`, `bash(git *)`, Claude's
`Bash(npm test:*)` (`:*` means prefix), `mcp__github__*`. Claude tool names (`Read`, `Edit`, `MultiEdit`, `Bash`,
`Grep`, `Glob`, `LS`, `WebFetch`, `Task`, `TodoWrite`, `ToolSearch`) map to oclite's.

## Agents

Agents are markdown files with YAML frontmatter; the body is the agent's prompt. Loaded low → high (a later file
with the same name merges over an earlier one):

1. Built-in: `packages/oclite/agents/*.md` (`build`, `plan`, `explore`, `code`, `audit`).
2. `~/.config/oclite/agents/**/*.md`.
3. `<root>/.claude/agents/*.md` (Claude Code compat, below).
4. `<root>/.opencode/agent/**/*.md` and `<root>/.opencode/agents/**/*.md`.
5. `<root>/.oclite/agents/**/*.md`.
6. Config `agent.<name>` overrides.

The name is the frontmatter `name`, else the file path without `.md`. `disable: true` removes an agent.

Frontmatter (opencode's `ConfigAgentV1`):

| Field | Meaning |
|---|---|
| `description` | Shown in agent lists and in the `task` tool |
| `mode` | `primary`, `subagent` or `all` (default `all`). Only non-primary agents can be sub-agents; only non-subagent agents are MCP prompts |
| `model` | `provider/model`; unset = inherit. For a sub-agent: its own `model`, else the model given with the spawn (MCP `agent_spawn`/`spawn` `model`), else its **parent's resolved model**, else the global `model`. A local-only primary agent therefore keeps its sub-agents local; this also holds at depth 2 and for `transport: mcp` children (the parent's model travels as the child's spawn `model`) |
| `temperature`, `top_p` | Sampling |
| `steps` | Maximum model turns for this agent |
| `permission` | Rules as in [`permission`](#permission) |
| `tools` | opencode's deprecated `{tool: boolean}` map becomes permission rules; a **list** is the oclite extension below |
| `prompt` | Overrides the body |
| `disable` | Remove the agent |

oclite extensions (read from the same frontmatter):

| Field | Default | Meaning |
|---|---|---|
| `transport` | `in-process` | `mcp` runs the agent in a child `oclite mcp serve` driven over MCP |
| `mcp.command` | `["oclite", "mcp", "serve", "--permission-mode", <this process's mode>]` | Child command for `transport: mcp`. A leading `oclite` means this same CLI |
| `mcp.url` | – | Instead of a command: an existing oclite MCP server (`http://127.0.0.1:4096/mcp`) |
| `mcp.token` | – | Bearer token for `mcp.url`, a literal or `{env:NAME}`. Without it, `OCLITE_MCP_TOKEN` is sent only to loopback URLs |
| `max_depth` | `2` | Nesting limit for this agent's own sub-agents |
| `read_only` | `false` | Deny edit/write/bash except `git status\|diff\|log`, `ls`, `pwd`; allow MCP tools with `readOnlyHint: true` |
| `max_context_tokens` | model context | Compaction triggers at the profile's fraction of this, even if the model allows more |
| `thinking` | `auto` | `auto` (on for a fresh user prompt, off for tool-result turns), `on`, `off`. `--thinking` overrides it |
| `tools` (list) | – | Optional tools to enable in local profiles: `task`, `todowrite`, `skill`, `webfetch`. Only `local` has optional tools |

```markdown
---
description: Reviews SQL migrations
mode: subagent
model: local/qwen3-coder
read_only: true
max_context_tokens: 24000
thinking: off
permission:
  bash: { "psql --version": allow }
---
You review SQL migrations for locking and data-loss risks. Reply with findings only.
```

**`.claude/agents` compat.** `color` is dropped, Claude model aliases (`sonnet`, `opus`, `haiku`, `inherit`) mean
inherit, and a `tools:` list (string or array) **only restricts**: every built-in and MCP tool not listed is denied,
and listed tools keep their normal rules (they're not auto-allowed). Listing an MCP tool also enables `tool_search`.
Files that don't parse are skipped instead of failing the CLI.

Config overrides use the same fields: `{"agent": {"build": {"model": "local/qwen3-coder", "steps": 40}}}`. That
includes the `tools` list (`{"agent": {"build": {"tools": ["task", "todowrite"]}}}`, the same as
`"options": {"tools": [...]}`). The `{tool: boolean}` record still works too, and untrusted project config keeps only
its `false` entries, as for agent files.

## `instructions` and instruction files

Loaded into the system prompt in this order: `AGENTS.md` (or `CLAUDE.md` when a directory has no `AGENTS.md`) in
each directory from the project root down to the working directory, then `~/.config/oclite/AGENTS.md`, then
`~/.claude/CLAUDE.md`, then each `instructions` entry. Local profiles cap each file (2000 / 1000 chars) and print one
notice naming the files that were cut.

## `hooks`

See [HOOKS.md](HOOKS.md).

## `servers`

Per openai-compatible base URL. The key must equal the provider's `options.baseURL` (a trailing `/` is ignored).

```jsonc
"servers": {
  "http://127.0.0.1:8000/v1": {
    "context_window": 32768,
    "max_tokens": 4096,
    "concurrency": 1,
    "probe_timeout_ms": 120000,
    "capabilities": {
      "tools_native": true,
      "prefix_cache": true,
      "usage_in_stream": true,
      "reasoning_field": "reasoning_content",
      "think_tags": false,
      "tokenize": false,
      "no_think_suffix": false,
      "accepts": { "chat_template_kwargs": true, "prompt_cache_key": true, "reasoning_effort": false, "parallel_tool_calls": true }
    }
  }
}
```

| Field | Meaning |
|---|---|
| `context_window` | Context length (also accepted inside `capabilities`). Otherwise from `/models`, else 32768 with a notice |
| `max_tokens` | `max_tokens` per request |
| `concurrency` | Requests in flight to this server, shared by the main agent, sub-agents and side calls. Default 1 for loopback, 8 otherwise |
| `probe_timeout_ms` | Per-request limit for the probe's chat requests (default 30,000), for slow CPU servers |
| `capabilities.tools_native` | Native `tool_calls`. `false` → text tool protocol |
| `capabilities.prefix_cache` | The server reuses a cached prompt prefix. `false` → automatic profile `local-min` |
| `capabilities.usage_in_stream` | The final chunk carries `usage`. `false` → estimated counts, marked `est.` |
| `capabilities.reasoning_field` | `reasoning_content`, `reasoning` (vLLM), or `none` |
| `capabilities.think_tags` | `<think>…</think>` in the text is split out as reasoning (when `reasoning_field` is `none`) |
| `capabilities.tokenize` | llama.cpp `/tokenize` is available for estimates |
| `capabilities.no_think_suffix` | Append `/no_think` to turn thinking off (Qwen-style templates), used only when `chat_template_kwargs` isn't accepted. Pin-only; never probed |
| `capabilities.accepts.<param>` | Whether to send `chat_template_kwargs` (`enable_thinking`), `prompt_cache_key` (the session id), `reasoning_effort`, `parallel_tool_calls` |

Pinned fields are never probed. The probe result is cached for 7 days in
`~/.local/share/oclite/servers/<host>_<port>-<model>.json`; `oclite debug server --reprobe` refreshes it, and a
400 that names an optional parameter updates the cache (`error-400`).

## Environment variables

| Variable | Meaning |
|---|---|
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and each catalog provider's `env` names (e.g. `OPENCODE_API_KEY`) | Hosted provider keys when the config has no `apiKey`. Redacted in all output |
| `OPENCODE_AUTH_CONTENT`, `OPENCODE_MODELS_PATH` | opencode's auth JSON and catalog file, read-only fallbacks (see Hosted catalog providers) |
| `OCLITE_MCP_TOKEN` | Bearer token required by `mcp serve --transport http`; also sent by `transport: mcp` agents to loopback `mcp.url`s. Not passed to bash, hooks, MCP stdio servers or children |
| `OCLITE_MCP_MAX_SESSIONS` | HTTP MCP sessions at once (default 16) |
| `OCLITE_MCP_MAX_RUNS` | Live runs per `mcp serve` process (default 8) |
| `OCLITE_MCP_IDLE_MS` | Idle HTTP MCP sessions expire after this (default 1,800,000); their runs keep going |
| `OCLITE_TRUST_PROJECT` | `1` trusts the project config for this run, like `--trust-project` |
| `OCLITE_DEBUG` | `1` copies MCP stdio servers' stderr to oclite's stderr (redacted) |
| `OCLITE_DEPTH` | Set by oclite for `transport: mcp` children; not meant to be set by hand |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME` | Move `~/.config/oclite` and `~/.local/share/oclite` |
| `NO_COLOR` | Turn off dim/erase ANSI codes |

## Files oclite writes

| Path | Contents |
|---|---|
| `~/.local/share/oclite/sessions/<id>.jsonl` | Append-only, redacted session records (`session export` prints them). Directory 0700, files 0600 |
| `~/.local/share/oclite/tool-output/` | Full text of truncated tool output (over 2000 lines / 50 KB) and large MCP resources, redacted. The model is told the path; reading it back is pre-approved |
| `~/.local/share/oclite/servers/` | Capability probe cache |
| `~/.config/oclite/trusted.json` | Trusted projects |
| `~/.local/share/opencode/mcp-auth.json` | MCP OAuth tokens, shared with opencode |

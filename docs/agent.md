# phren agent

`phren agent` is phren's own coding agent. It reads, edits and runs your code
with tool calls, like Claude Code or Codex, and it starts every session already
knowing the project: its truths, open tasks, recent findings and the summary of
the last session. What it learns goes back into the same phren store your other
agents use.

It ships as a separate npm package, `@phren/agent`, so the `phren` CLI stays
small for people who only want memory. Install it and run it either way:

- `phren agent …` from the phren CLI, or
- `phren-agent …`, the package's own binary.

Both run the same program with the same arguments.

---

## Install

```bash
npm install -g @phren/cli @phren/agent
phren init              # once: creates the memory store (~/.phren)
```

`@phren/agent` is released with `@phren/cli` and carries the same version
number. It needs Node.js 20 or later. Without it, `phren agent` prints
`phren agent needs @phren/agent: run npm install -g @phren/agent` and exits.

The CLI looks for the agent in this order: the directory in
`PHREN_AGENT_PACKAGE`, a copy Node can resolve next to the CLI, a phren
repository checkout (`packages/agent`), then npm's global packages.

From a repository checkout instead:

```bash
git clone https://github.com/alaarab/phren && cd phren
pnpm install && pnpm build
node packages/cli/dist/index.js agent -i     # or: node packages/agent/dist/bin.js -i
```

## Quickstart

```bash
phren agent -i                                     # interactive terminal UI
phren agent "fix the failing date test"            # one task, then exit
phren agent --plan "refactor the database layer"   # review the plan before it acts
phren agent --resume                               # continue the last session
phren agent --help                                 # every option
```

Run it from the project's directory. phren picks the project from the
directory (or `--project <name>`) and loads that project's memory.

---

## Providers

The agent picks a provider from the credentials it finds, in this order, or
the one you name with `--provider` (or `PHREN_AGENT_PROVIDER`):

| Provider | `--provider` | Credentials | Default model |
|----------|--------------|-------------|---------------|
| ChatGPT / Codex subscription | `openai-codex` | `phren agent auth login` (browser sign-in) | `gpt-5.4` |
| OpenAI | `openai` | `OPENAI_API_KEY` | `gpt-5.4` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | `anthropic/claude-sonnet-4-20250514` |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-5` |
| Ollama (local) | `ollama` | none; `PHREN_OLLAMA_URL` (default `http://localhost:11434`) | `qwen2.5-coder:14b` |

Choose a model with `--model <id>` (or `PHREN_AGENT_MODEL`) and a reasoning
effort with `--reasoning low|medium|high|xhigh` (or `PHREN_AGENT_REASONING`).
In the terminal UI, `/model` switches both mid-session.

### ChatGPT or Codex subscription

Uses the plan you already pay for; no API key and no per-token bill.

```bash
phren agent auth login      # opens the browser; tokens are stored locally
phren agent auth status
phren agent auth logout
```

Once signed in, this provider is preferred whenever no other is named.

### API keys

Set the environment variable, or store the key once so every shell picks it up:

```bash
phren agent auth set-key openrouter sk-or-...     # also: openai, anthropic
phren agent auth clear-key openrouter
```

Stored keys live in `~/.phren/.runtime/auth-profiles.json` (private to your
user). An environment variable wins over a stored key.

### OpenRouter

One key, many models. Name the model with its OpenRouter id:

```bash
phren agent --provider openrouter --model google/gemini-2.5-pro -i
```

### DeepSeek and other OpenAI-compatible models

The agent does not yet take a custom OpenAI-compatible base URL, so a
DeepSeek API key cannot be used directly. Reach DeepSeek through OpenRouter,
which is how the agent's own assessment runs were made:

```bash
phren agent --provider openrouter --model deepseek/deepseek-v4.1-flash "add input validation"
```

or run a DeepSeek model locally through Ollama (below).

### Ollama

No key; the agent talks to a running Ollama server.

```bash
ollama pull qwen2.5-coder:14b
phren agent --provider ollama -i
PHREN_OLLAMA_URL=http://gpu-box:11434 phren agent --provider ollama --model deepseek-r1:14b -i
```

When no credentials are found at all, the agent falls back to Ollama on
`localhost:11434`.

---

## MCP servers

Give the agent more tools by connecting MCP servers. A config file uses the
same `mcpServers` shape as Claude Code:

```json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "..." } },
    "docs":   { "type": "http", "url": "https://example.com/mcp", "oauth": true }
  }
}
```

```bash
phren agent --mcp-config ./mcp.json -i
phren agent --mcp "npx -y @modelcontextprotocol/server-filesystem /tmp" -i   # one stdio server, repeatable
```

Transports are `stdio`, `http` (Streamable HTTP) and legacy `sse`. With
`oauth: true` the agent prints an authorization URL on first connection and
stores the tokens in private files under `~/.phren/agent/mcp-auth`
(`PHREN_MCP_AUTH_DIR` overrides it). `oauth` can also be an object with
`clientId`, optional `clientSecret`, `scope` and `callbackPort` (default
14557). The agent does not need phren's own MCP server: its memory tools are
built in.

---

## Permissions

Every tool call passes a permission check first.

| Mode | What runs without asking | How to choose it |
|------|--------------------------|------------------|
| `suggest` (default) | Nothing; you approve each call | default |
| `auto-confirm` | Reads and searches (read, glob, grep); edits and shell commands still ask | `--permissions auto-confirm` |
| `full-auto` | Everything | `--yolo` or `--permissions full-auto` |

Shift+Tab cycles the mode in the terminal UI, and the choice is remembered in
`~/.phren-agent/settings.json`. At a prompt, `y` allows the call once, `s` allows
calls like it (the same file, or the same command) for the rest of the
session, `a` allows the tool for the rest of the session (for the shell, only
that command) and `n` denies. Approvals kept across sessions live in
`~/.phren-agent/permissions.json`.

Whatever the mode, file tools stay inside the project directory, secret files
such as `.env` are protected, shell commands have safety checks and timeouts,
and on Linux shell commands run under a bubblewrap sandbox that makes
everything outside the workspace read-only (`--sandbox auto|require|off`,
see [Security](#security)).

Hooks can allow or deny tool calls with your own scripts: put
`PreToolUse`, `PostToolUse`, `UserPromptSubmit` or `Stop` entries (each a
`command`, optional `matcher` and `timeoutMs`) in `~/.phren-agent/hooks.json`
or the project's `.phren-agent/hooks.json`. Markdown files in
`~/.phren-agent/commands/` or `.phren-agent/commands/` become slash commands.

---

## Memory

The agent uses the phren store directly, the same one `phren init` created
and your other agents read.

**When a session starts** it loads the project's truths, open tasks, recent
findings, the project's `AGENTS.md`, the enabled skills and, with `--resume`,
the previous session's summary. Items waiting in the review queue are shown
separately and marked as unconfirmed.

**During the session** it has built-in tools to search memory
(`phren_search`), save a finding (`phren_add_finding`), and read, add and
complete tasks (`phren_get_tasks`, `phren_add_task`, `phren_complete_task`),
plus `run_skill` for your phren skills.

**When the context fills up** (or on `/compact`) it asks the model for a
checkpoint and routes the knowledge in it by confidence: confident items
become findings, uncertain ones go to the review queue
([details](#compaction-with-knowledge-promotion)).

**When the session ends** it saves a summary and checkpoint for `--resume` and
writes a searchable session note.

Every session is logged at
`~/.phren/.runtime/sessions/session-<id>.events.jsonl`, which is also what the
phone app reads (below).

---

## Headless and scripted runs

Give the task as an argument and the agent runs it to the end, prints its
answer on stdout and exits: no terminal UI. Nobody is there to approve tool
calls, so choose the permission mode and limits up front:

```bash
phren agent --permissions auto-confirm --max-turns 30 --budget 1.00 "summarize open TODOs in src/"
phren agent --yolo --provider openrouter --model deepseek/deepseek-v4.1-flash "run the tests and fix what fails"
```

`--budget <dollars>` stops the run when its estimated spend passes the limit,
`--max-turns` caps tool rounds (default 50), `--verbose` streams tool calls to
stderr and `--dry-run` prints the system prompt without calling a model. Exit
code 130 means the run was interrupted; resume it with `--resume`. Subagents a
one-shot run spawns run without a terminal and refuse any call that would need
approval.

---

## Phone app

Sessions show up in the phren iOS and Android apps like Claude Code, Codex and
Copilot sessions do, through [Phren Hook](phren-hook.md) (`phren bridge
install`).

- **Under tmux** the Hook recognizes the agent whichever way it was started
  (`phren agent`, `phren-agent`, or the package's `dist/bin.js`) and shows the
  conversation, its status and a chat you can type into from the phone.
- **Under Herdr** the agent reports its session to the Hook itself (no
  settings to edit), which binds the pane to its event log. The chat appears
  once Herdr reports `phren` as an agent kind.

Starting a new phren agent session from the phone is not available yet; start
it on the computer and it appears in the app.

---

## CLI flags

| Flag | Description |
|------|-------------|
| `<task>` | Task to run (one-shot mode) |
| `-i`, `--interactive` | Interactive terminal UI |
| `--provider <name>` | `openai-codex`, `openai`, `openrouter`, `anthropic`, `ollama` |
| `--model <id>` | Model for the chosen provider |
| `--reasoning <level>` | `low`, `medium`, `high`, `xhigh` |
| `--project <name>` | phren project to load, instead of the one found from the directory |
| `--permissions <mode>` | `suggest` (default), `auto-confirm`, `full-auto` |
| `--yolo` | Same as `--permissions full-auto` |
| `--plan` | Show a plan and wait for approval before running tools |
| `--resume` | Continue the last session (the task is optional) |
| `--budget <dollars>` | Stop when estimated spend passes this |
| `--max-turns <n>` | Maximum tool rounds (default 50) |
| `--max-output <n>` | Maximum output tokens per response |
| `--mcp <command>` | Connect a stdio MCP server (repeatable) |
| `--mcp-config <path>` | Load MCP servers from a JSON file |
| `--sandbox <mode>` | Linux shell sandbox: `auto` (default), `require`, `off` |
| `--lint-cmd <cmd>`, `--test-cmd <cmd>` | Override the detected lint and test commands |
| `--no-subagents` | No subagent tools in one-shot mode |
| `--no-llm-compact` | Regex summaries instead of model checkpoints when compacting |
| `--multi` | Multi-agent terminal UI |
| `--team <name>` | Team mode with shared task coordination |
| `--dry-run` | Print the system prompt and exit |
| `--verbose` | Show tool calls as they run |
| `--help`, `--version` | Help and version |

`phren agent auth login|logout|status|set-key|clear-key` manages credentials
(see [Providers](#providers)).

---

## Slash commands

All 23 commands available in the interactive TUI:

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/model` | Interactive model picker with reasoning slider |
| `/provider` | Show current provider info |
| `/cost` | Show session cost breakdown |
| `/plan` | Show/toggle plan mode |
| `/undo` | Undo last file change |
| `/compact` | Compact context: LLM checkpoint + knowledge promotion (regex fallback) |
| `/review` | Triage the phren review queue (`go` = manual, `auto` = model-assisted) |
| `/context` | Show context window usage |
| `/history` | Show conversation history |
| `/turns` | Show turn count and stats |
| `/clear` | Clear conversation history |
| `/files` | List files touched this session |
| `/cwd` | Show/change working directory |
| `/diff` | Show git diff of session changes |
| `/git` | Run git commands |
| `/spawn` | Spawn a sub-agent (multi-agent mode) |
| `/agents` | List active sub-agents |
| `/preset` | Save/load/list agent presets |
| `/mode` | Toggle input mode (steering vs queue) |
| `/exit` | Exit the agent |

---

## Keyboard shortcuts

Full readline-style editing in the interactive TUI:

| Key | Action |
|-----|--------|
| **Navigation** | |
| Tab | Toggle memory browser / slash command completion |
| Shift+Tab | Cycle permission mode (suggest / auto-confirm / full-auto) |
| Up / Down | Input history |
| Left / Right | Move cursor |
| Alt+Left / Alt+Right | Jump word |
| Ctrl+A | Move to start of line |
| Ctrl+E | Move to end of line |
| **Editing** | |
| Ctrl+U | Kill entire line |
| Ctrl+K | Kill from cursor to end |
| Ctrl+W | Delete word backward |
| Alt+Backspace | Delete word backward |
| Delete | Delete character at cursor |
| **Tab completion** | |
| Tab (with `/` prefix) | Complete slash commands |
| Tab (in bash mode) | Complete file paths |
| **Modes** | |
| `!` | Enter bash mode (run shell commands) |
| Escape | Exit bash mode / clear input |
| Ctrl+C | Progressive: clear input, then warn, then quit |
| Ctrl+D | Clean exit |

---

## Tools

The agent has access to these built-in tools:

### File operations
- **read_file** — Read file contents (with line range support)
- **write_file** — Write or create files
- **edit_file** — Surgical string replacements in files
- **glob** — Find files by pattern
- **grep** — Search file contents with regex

### Shell and git
- **shell** — Run shell commands (with timeout and safety checks)
- **git_status** — Show working tree status
- **git_diff** — Show staged/unstaged changes
- **git_commit** — Create commits

### Web
- **web_fetch** — Fetch URL contents
- **web_search** — Search the web

### Phren memory
- **phren_search** — Search findings across all projects
- **phren_add_finding** — Capture a finding
- **phren_add_task** — Create a task
- **phren_get_tasks** — List tasks for a project
- **phren_complete_task** — Mark a task done

---

## Multi-agent mode

Spawn and coordinate multiple agents from a single TUI.

```bash
phren agent --multi                            # start multi-agent TUI
phren agent --team myproject "build X"          # team mode with shared tasks
```

In the multi-agent TUI:

| Command | Description |
|---------|-------------|
| `/spawn <name> <task>` | Create a new sub-agent |
| `/agents` | List active agents with status |
| `/kill <name>` | Terminate an agent |
| `/broadcast <msg>` | Message all agents |
| `1-9` | Switch between agent panes |

Agents run as child processes with IPC messaging and shared task coordination.

---

## Compaction with knowledge promotion

When the conversation approaches 75% of the context window (or on `/compact`),
the agent asks the *same provider* for a structured checkpoint via prefix
replay: the summarization request reuses the conversation's own system prompt
and message prefix byte-identical, so the provider's KV cache covers
everything except the final instruction. The response carries the summary plus
candidate knowledge items, routed by the model's own confidence:

| Confidence | Destination |
|---|---|
| ≥ 0.8 | `FINDINGS.md` immediately, with agent/session provenance + citation |
| 0.5 – 0.8 | Review queue (`review.md`), with provenance metadata |
| < 0.5 | Dropped |

Any failure — call error, timeout, botched JSON, too-short summary — degrades
to the old regex summary with identical prune indices, so compaction can never
break a turn. The summary lands as a durable `log/replace` event; the pruned
messages stay in the event log. Knobs: `--no-llm-compact`,
`PHREN_AGENT_LLM_COMPACT=0`, `PHREN_AGENT_COMPACT_THRESHOLD`,
`PHREN_AGENT_COMPACT_MIN_TOKENS` (skip the LLM below this pruned-range size,
default 8k tokens).

## Governance: the review-queue triage loop

High-confidence knowledge never enters the queue (promotion above), so what
does land there is genuinely uncertain — and the agent makes sure it gets
looked at instead of silting up:

- **Session start (interactive):** items older than 14 days are auto-rejected
  (`PHREN_AGENT_QUEUE_EXPIRE_DAYS`, `0` = never; undated items never expire),
  then a banner shows the pending count and top 3 items. One-shot runs print a
  count only and never mutate the queue.
- **`/review`** lists pending items. **`/review go`** is a per-item keypress
  loop (approve / reject / edit / skip) over exact `review.md` lines.
  **`/review auto`** asks the model to propose a verdict + one-line reason per
  item, then applies the batch on one confirm — or preloads the proposals as
  defaults in the interactive loop.
- The warm-start context includes a clearly-labeled section (count + top 3,
  "do NOT treat as truth") so the model knows candidate knowledge exists
  without it leaking as fact. Notes and queue content are excluded from the
  automatic injection path entirely; explicit `phren_search` results tag them.

---

## Security

**Permission modes** control what the agent can do without asking:
- `suggest` (default): every tool call requires approval
- `auto-confirm`: safe tools (read, glob, grep) auto-approved; destructive tools need confirmation
- `full-auto` (`--yolo`): everything runs without confirmation

**Additional protections:**
- Path sandboxing limits file operations to the project directory
- Sensitive file patterns (`.env`, credentials) are protected
- Shell commands have safety checks and timeouts
- Environment variables are scrubbed before sending to LLM providers

### Kernel sandbox (Linux, bubblewrap)

With `--sandbox auto` (the default), shell commands are wrapped in `bwrap` so
the filesystem is **read-only outside the workspace** — enforced by the
kernel, which covers every child process, not just what in-process checks can
see. Writable roots derive from the same permission config as the in-process
path sandbox (project root + allowed paths + tmp), so the two layers cannot
drift apart. When a sandboxed write is blocked, the tool result gets a
`[sandbox]` annotation so the model redirects instead of retrying.

| Mode | Behavior |
|---|---|
| `auto` (default) | Confine when a functional `bwrap` probe passes; otherwise run unconfined with a one-time notice (non-Linux included) |
| `require` | Fail closed: no working bwrap ⇒ every shell call errors |
| `off` | Never wrap |

### web_fetch SSRF guard

`web_fetch` rejects URLs that are — or resolve via DNS to — private,
loopback, link-local (cloud metadata!), or CGNAT addresses, and follows
redirects manually so each hop is re-checked. Override with
`PHREN_AGENT_ALLOW_PRIVATE_FETCH=1` if your docs genuinely live on your LAN.

---

## Replay testing (keyless)

Every run records a session event log — and any recording can be replayed as
a scripted provider with **zero API cost and no credentials**:

```bash
PHREN_AGENT_REPLAY=path/to/session-<id>.events.jsonl phren agent --yolo "same task"
```

Each recorded `assistant/message` replays as one response, in order; the loop
errors loudly if the conversation diverges past the script. This turns any
interesting real session into a deterministic regression test — CI runs the
built binary against a committed fixture (scripted tool call → real shell
execution → scripted final answer) on every push.

## Live smoke test

`scripts/agent-smoke.sh` runs one short real session per provider that has
credentials configured (skips the rest): a real tool call plus the final
answer check. Use it before releases or after provider-layer changes:

```bash
pnpm build && ./packages/agent/scripts/agent-smoke.sh            # all configured
./packages/agent/scripts/agent-smoke.sh anthropic                # just one
```

## Skills

The warm-start context lists enabled skills (name + description from the
phren skill registry, project scope honored) so the model knows what exists
instead of guessing `run_skill` names. In the REPL/TUI, an unknown slash
input that matches a skill — by name, frontmatter `command`, or alias — is
rewritten into a `run_skill` task: `/commit fix typo` runs your `commit`
skill with those args. Built-in commands always win.

---

## Session event log

Session history is an append-only event log at
`<phrenPath>/.runtime/sessions/session-<id>.events.jsonl` — one JSON line per
event (`user/message`, `assistant/message`, `tool/results`, `log/replace`).
The message array the model sees is derived from the log, and an invariant
asserts before every request that the projection still reconstructs from it
(disable with `PHREN_AGENT_NO_INVARIANT=1`). Context pruning appends a
`log/replace` event instead of deleting: the model sees a summary, the log
keeps everything for replay and resume. `--resume` prefers the newest event
log (forking it into the new run's own file, with `parentSession` lineage)
and falls back to legacy v1 message snapshots, which are still written once
at session end.

## Reasoning models

Reasoning/thinking output round-trips per provider: Codex re-sends encrypted
reasoning items so multi-turn tool use keeps the model's chain of thought;
Anthropic gets a `thinking` budget derived from `--reasoning` and replays
signed thinking blocks; OpenAI-compatible endpoints and Ollama surface
`reasoning_content`/`thinking` for display. Reasoning from a different
provider is stripped on send, so `--resume` under a new model never replays
another model's private state. The TUI shows a dim live thinking tail;
one-shot `--verbose` streams it to stderr.

## Images

`read_image` (registered only for vision-capable models) reads png/jpeg/webp/
gif up to 5MB into the conversation. On a text-only model, image content in
resumed history degrades to an explicit `[image omitted]` marker rather than
an unsendable request.

## Loop hygiene

Consecutive identical tool calls (same tool, same canonicalized arguments)
get escalating reminders at runs of 3/5/8 appended to the tool result;
identical calls within one assistant message execute once and share the
result. Every tool runs under a declarative per-tool timeout (default 120s)
with a real AbortSignal — shell commands are cancellable and no longer block
the event loop.

## Subagents in one-shot mode

`spawn_agent`, `send_message_to_agent`, and `list_agents` are available in
one-shot runs (not just the TUI); disable with `--no-subagents`. In `suggest`
permission mode, spawning asks first — a child runs with auto-confirm
permissions. Headless children auto-deny any tool that would need an
interactive approval.


# phren-agent

A coding agent with persistent memory. Reads, writes, and edits your code with tool calling. Starts each session knowing your project's gotchas, active tasks, and past decisions.

---

## Quickstart

### Install

```bash
npm i -g @phren/cli @phren/agent
phren init                          # set up memory store + MCP config
```

### Authentication

Providers are auto-detected from environment variables:

```bash
export OPENROUTER_API_KEY=sk-or-...     # OpenRouter (default)
export ANTHROPIC_API_KEY=sk-ant-...     # Anthropic direct
export OPENAI_API_KEY=sk-...            # OpenAI
```

For Codex (ChatGPT subscription), authenticate via browser:

```bash
phren-agent auth login
```

Ollama requires no key — just a running local server.

### First task

```bash
phren-agent "fix the login bug"                        # one-shot
phren-agent -i                                         # interactive TUI
phren-agent --plan "refactor the database layer"       # review plan first
phren-agent --provider codex --budget 2.00 "add tests" # pick provider, set cost cap
phren-agent --yolo "add input validation"              # full-auto, no confirmations
```

---

## Providers

Auto-detected from env vars, or forced with `--provider <name>`.

| Provider | Default Model | Env Var / Auth |
|----------|---------------|----------------|
| OpenRouter | claude-sonnet-4-20250514 | `OPENROUTER_API_KEY` |
| Anthropic | claude-sonnet-4-20250514 | `ANTHROPIC_API_KEY` |
| OpenAI | gpt-4.1 | `OPENAI_API_KEY` |
| Codex | gpt-5.3-codex | `phren-agent auth login` (ChatGPT subscription) |
| Ollama | llama3.3 | Local, no API key needed |

Switch models mid-session with the `/model` command (interactive reasoning level slider).

---

## CLI flags

| Flag | Description |
|------|-------------|
| `<task>` | Task description (one-shot mode) |
| `-i`, `--interactive` | Interactive TUI with streaming, history, tab completion |
| `--provider <name>` | Force provider: `openrouter`, `anthropic`, `openai`, `codex`, `ollama` |
| `--model <id>` | Override the default model for the chosen provider |
| `--budget <dollars>` | Max spend in USD (aborts when exceeded) |
| `--plan` | Plan mode: show plan before executing tools |
| `--yolo` | Full-auto permissions — no confirmations |
| `--resume` | Resume last session's conversation |
| `--multi` | Multi-agent TUI mode |
| `--team <name>` | Team mode with shared task coordination |
| `--verbose` | Debug-level logging |
| `--help` | Show help |
| `--version` | Show version |

### Permission modes

| Mode | Behavior | How to set |
|------|----------|------------|
| **suggest** (default) | Agent proposes tool calls, you approve each one | Default |
| **auto-confirm** | Auto-approve safe tools (read, glob, grep), confirm destructive ones | Shift+Tab in TUI |
| **full-auto** | All tools run without confirmation | `--yolo` flag |

Cycle modes during a session with Shift+Tab.

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
| `/compact` | Compress context (prune old messages) |
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
phren-agent --multi                       # start multi-agent TUI
phren-agent --team myproject "build X"    # team mode with shared tasks
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

## Memory integration

The agent is deeply integrated with phren's memory layer:

**On startup:**
- Loads project truths (always-injected facts)
- Loads active tasks and recent findings
- Reads CLAUDE.md for project conventions
- Restores prior session summary (with `--resume`)

**During a session:**
- Searches phren for relevant context when approaching new problems
- Captures findings as it discovers patterns, pitfalls, and decisions
- Creates and completes tasks

**On session end:**
- Saves session summary and checkpoint
- Records edited files and test state for exact resume

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

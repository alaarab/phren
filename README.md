<p align="center"><img src="docs/phren-transparent.png" width="180" alt="phren"></p>

<h3 align="center">Your agents forget everything. Phren doesn't.</h3>

<p align="center">
  <a href="https://www.npmjs.com/package/@phren/cli"><img src="https://img.shields.io/npm/v/%40phren%2Fcli?style=flat&labelColor=0D0D0D&color=7C3AED" alt="npm version"></a>
  <a href="https://github.com/alaarab/phren/blob/main/LICENSE"><img src="https://img.shields.io/github/license/alaarab/phren?style=flat&labelColor=0D0D0D&color=7C3AED" alt="license"></a>
  <a href="https://alaarab.github.io/phren/"><img src="https://img.shields.io/badge/docs-alaarab.github.io%2Fphren-7C3AED?style=flat&labelColor=0D0D0D" alt="docs"></a>
  <a href="https://alaarab.github.io/phren/whitepaper.pdf"><img src="https://img.shields.io/badge/whitepaper-PDF-7C3AED?style=flat&labelColor=0D0D0D" alt="whitepaper"></a>
</p>

<p align="center">
Persistent memory for AI agents. Findings, tasks, and patterns live in markdown files in a git repo you control. No database, no vendor lock-in. Works with Claude, Copilot, Cursor, and Codex.
</p>

---

## Install

```bash
npx @phren/cli init
```

One command. Sets up `~/.phren`, wires up MCP for your tools, installs hooks. Next time you open a project, context starts flowing automatically. On a new machine? Re-run init and you're back in sync.

---

## What actually happens

**When you open a prompt:**
- Hooks extract keywords from your question
- Phren searches findings across projects (FTS5 full-text with semantic fallback)
- Relevant snippets inject into your prompt before you hit send
- You ask; Claude already knows the gotchas

**When you discover something:**
- `phren add-finding <project> "finding text"` captures it with optional tags (`[decision]`, `[pattern]`, `[pitfall]`, `[bug]`)
- Trust scores decay over time; decisions never do; observations expire in 14 days
- Findings link to fragments (named concepts like "auth" or "build") that connect knowledge across projects

**Sessions:**
- Mark boundaries with `session_start` / `session_end`
- Next session sees your prior summary, active tasks, recent findings, and where you left off
- Checkpoints track edited files and failing tests so you can resume exactly where you stopped

**Tasks:**
- Add with priority/section. Pin across sessions. Link to GitHub issues.
- Track completions and cross-project rollups.

---

## Key features

### Fragment graph
Explore connections visually. Drag nodes to reorganize; graph auto-settles. Click a fragment to see every finding linked to it across all projects.

### Finding lifecycle
- **Supersede**: "Finding X is obsoleted by finding Y"
- **Retract**: "We were wrong about this; here's why"
- **Contradict**: "We have two findings that conflict; this is why"

Helps you reason about contradictions instead of hiding them.

### Multi-agent support
Same store works with Claude Code, Copilot, Cursor, and Codex. Agents tag findings with their tool, so you see who discovered what.

### Review queue
Mark findings as needing review (`[Review]` section). Phren surfaces review items on every session start. Approve, reject, or edit in place.

### Governance & policies
Per-project retention policies. Confidence decay curves. Access control. Audit logs. Configure with `phren config` or the web UI.

### Store subscriptions
Subscribe to specific projects in a team store — others stay hidden from search and context injection:
```bash
phren store subscribe team-store arc intranet
phren store unsubscribe team-store legacy-projects
```

### Progressive disclosure
Enable `PHREN_FEATURE_PROGRESSIVE_DISCLOSURE=1` to get compact memory indices instead of full snippets. Call `get_memory_detail(id)` to expand only what you need.

### Semantic dedup & conflict detection
Optional: enable LLM-based duplicate detection and contradiction flagging on `add_finding`. Prevents near-duplicate entries and catches "always use X" vs "never use X" contradictions.

### Skills & hooks
Drop custom slash commands into `~/.phren/global/skills/`. Hooks run on user prompt, tool use, and session events — wire phren into your own workflows.

---

## Integrated Agent

Phren now uses `phren` itself as the primary coding-agent entrypoint. Memory operations remain available under `phren manage ...`, and `phren-agent` remains an explicit alias for the standalone agent runtime. [Read the agent docs →](docs/agent.md)

```bash
npm i -g @phren/agent
phren -i                               # interactive TUI
phren "fix the login bug"              # one-shot task
phren --reasoning high "audit auth"    # same GPT-5.4 default, higher reasoning
phren --yolo "add tests"               # full-auto, no confirmations
phren manage search auth               # memory/search surface
```

---

## CLI quick reference

```bash
phren                                   Interactive coding agent
phren "task"                            Run a one-shot coding task
phren -i                                Interactive agent (TUI/REPL)
phren manage shell                      Interactive memory shell
phren manage search <query>             Full-text search with FTS5
phren manage add-finding <project> "insight"
phren manage task add <project> "item"  Add a task
phren manage session_start <project>    Start a session
phren manage store list                 List personal + team stores
phren manage team init <name> --remote <url>
phren manage team join <url>            Join a team store
phren manage web-ui [--port 3499]       Launch the web UI
phren manage doctor                     Health check & auto-fix
```

See full CLI docs at [alaarab.github.io/phren](https://alaarab.github.io/phren/).

---

## Team stores

Shared knowledge repos for teams. One person creates with `phren team init`, others join with `phren team join`. Findings, tasks, and skills sync across team members.

Each team store can be configured with per-project subscriptions so people only see what they care about.

---

## Platforms

- **Claude Code** (VS Code, Web, Desktop) — MCP hooks + CLI
- **Copilot** (VS Code, GitHub.com) — MCP hooks
- **Cursor** (IDE) — MCP hooks + built-in skill system
- **Codex** (Claude Agent SDK) — MCP tools + hooks

All use the same phren store. No vendor lock-in.

---

## Packages

| Package | Description |
|---------|-------------|
| [`@phren/cli`](packages/cli) | CLI, MCP server, data layer (53 tools, FTS5, hooks) |
| [`@phren/agent`](packages/agent) | Coding agent with TUI (providers, tools, multi-agent) |
| [`phren-vscode`](packages/vscode) | VS Code extension (sidebar, graph, onboarding) |

---

MIT License. Made by [Ala Arab](https://github.com/alaarab).

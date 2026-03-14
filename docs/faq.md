# Phren FAQ

## How is this different from just using CLAUDE.md?

`CLAUDE.md` loads the entire file on every prompt. If your file is 2,000 tokens, you pay 2,000 tokens every single time — whether the content is relevant or not. With five agents running in parallel, that's 10,000 tokens of context before anyone types a word.

Phren searches what you wrote and injects only what matches the current prompt. By default it targets roughly 550 tokens with `PHREN_CONTEXT_TOKEN_BUDGET`, regardless of how large your knowledge base grows. You can run more agents in parallel for the same cost, and they're not reading noise.

`CLAUDE.md` is also static. Phren learns as you work. Every bug traced, every decision made, every pattern discovered gets saved automatically. The next session starts with that knowledge already in context.

## Does this slow down my prompts?

Usually not on a warm local repo. The hook runs locally: keyword extraction, FTS5 search, and context injection all happen against a local SQLite index with no network calls in the default path. On a healthy warm cache it is often fast enough that you will barely notice it, but the exact latency depends on corpus size, filesystem speed, and whether semantic retrieval is enabled.

The main exceptions are the first prompt in a session, where `SessionStart` pulls the phren repo from git, and very large or slow filesystems, where index work can become noticeable. On a fast connection the pull is often under a second; on a slow connection it can be a few seconds. This is configurable — you can disable the auto-pull if you prefer to sync manually.

## What happens when I run multiple agents at the same time?

They all read and write the same `~/.phren` directory. Concurrent reads are safe. Writes are serialized within a process by file locks; cross-process synchronization happens at the git layer.

In practice: an agent on Codex hits a pitfall and saves a finding. On the next git pull cycle, a Claude Code session on a different machine has it in context. No coordination code, no message passing — it's just a shared git repo.

The one rough edge is heavy concurrent writes on the same machine. If two agents are pushing at exactly the same moment you can get a push conflict or a locally saved commit that has not been pushed yet. Phren retries transient git failures, rebases and auto-merges safe markdown conflicts in the background sync worker, and surfaces remaining failures in status, shell, and web UI. Under extreme parallelism, think of Phren as eventually consistent rather than strongly coordinated.

## What failure modes should I expect?

The common ones are boring infrastructure issues, not mystery behavior:

- No remote configured: auto-save still commits locally, but nothing syncs across machines until you add a remote.
- Push failed: the commit stays local and Phren records the last sync error so `phren status`, shell, and web UI can show it.
- Hooks disabled or stale: retrieval stops, but your files are still there; rerun `phren init` or re-enable hooks with `phren hooks-mode on`.
- Stale index: search quality drops until the next rebuild; `phren doctor` and `phren status` will flag index trouble.
- Review queue growth: trust filtering is catching too much low-signal or stale content, which usually means your findings need pruning or governance thresholds need adjustment.
- Governance lockout: if access control blocks a write, nothing is silently discarded; check `.governance/access-control.json`, `.runtime/access-control.local.json`, and actor identity (`PHREN_ACTOR` / OS user).

## How does trust decay work?

Every finding has a confidence score. The score degrades over time in four steps:

| Age | Cited entry | Uncited entry |
|-----|-------------|---------------|
| 0–30 days | 1.00 | 0.80 |
| 31–60 days | 1.00 | 0.80 |
| 61–90 days | 0.85 | 0.68 |
| 91–120 days | 0.65 | 0.52 |
| 120+ days | 0.45 | 0.36 |

Entries below 0.35 are suppressed entirely and move to the review queue instead of being injected. Entries with file/line/commit citations hold their score longer than uncited ones.

You can save a truth with `pin_memory` to make it never decay. Truths live in `truths.md` and always inject regardless of age.

All thresholds are configurable via `phren config policy`.

## How do I use the web UI?

```bash
phren web-ui
```

Opens a browser-based interface at `localhost:3499` (configurable with `--port`). From there you can approve, reject, or edit entries in the review queue and inspect project memory without starting an agent session.

You can filter by machine, model, and project. Useful when you're running agents across multiple machines and want to triage what each one produced.

Inside a project, the `Reference` tab shows three buckets side by side:

- project topics from `topic-config.json`
- suggested topics inferred from project language
- other hand-written docs under `reference/`

From that tab you can:

- read topic docs under `reference/topics/<slug>.md`
- add, edit, or delete project-owned topics
- adopt a suggested topic with one click
- run a safe reclassification pass that moves legacy auto-generated `reference/*.md` topic docs into `reference/topics/` while leaving hand-written docs alone

If a project has never customized topics, the UI shows a starter-topics banner. Saving topics in the UI writes `topic-config.json` and creates the matching topic docs immediately so they are visible before the next archive cycle.

The terminal shell (`phren`, then press `m`) covers the same workflow if you prefer staying in the terminal.

Security defaults for `phren web-ui`:
- loopback-only bind (`127.0.0.1`)
- random per-run auth token
- CSRF token required for mutating routes
- CSP and anti-framing headers enabled

## What gets saved automatically vs what do I save manually?

**Automatic:**
- Findings added via `add_finding` MCP tool (agents call this when they discover something worth saving)
- Task items via `add_task`
- Session state committed and pushed by the Stop hook after every response

**Manual:**
- Running `/phren-consolidate` when findings pile up and you want patterns surfaced
- Running `phren maintain govern` to queue low-value or stale entries for review
- Pinning findings that should never decay

In practice, well-configured agents save findings automatically as they work. You review the queue periodically to keep quality high, and run consolidation intentionally when the findings file starts to get repetitive.

## How do finding lifecycle and contradictions work?

Findings now have explicit lifecycle operations:
- `supersede_finding`: mark older guidance replaced by newer guidance
- `retract_finding`: invalidate a finding with a reason
- `resolve_contradiction`: resolve status between conflicting findings
- `get_contradictions`: list unresolved contradicted findings

Lifecycle metadata stays attached to finding entries, so history remains auditable instead of being silently deleted.

## What is finding provenance and impact scoring?

`add_finding` accepts a `source` field (`human`, `agent`, `hook`, `extract`, `consolidation`, `unknown`) so origin is explicit.

Impact scoring tracks which findings were injected into context and whether those sessions completed tasks. Repeatedly successful findings get a stronger retrieval boost.

## How does cross-session resume work?

`session_end` writes task checkpoints (task ID/text, edited files, failing tests, last attempt, next step).  
`session_start` surfaces those checkpoints so agents can resume quickly.  
`session_history` gives list/drill-down access to prior sessions and artifacts.

## How do I add a new project?

For an existing repo:

```bash
cd ~/code/my-project
phren add
```

Phren bootstraps `~/.phren/my-project/` and adds it to your active profile. If you just open a session in an untracked repo, phren tells the agent to ask whether you want to add it.

For a brand-new project scaffold inside Claude:

```bash
/phren-init my-project
```

Project setup note:
- `phren add` is the canonical path for existing repos.
- Platform-specific behavior is documented in `docs/platform-matrix.md`.
- Best-effort vs fail-closed behavior is documented in `docs/error-reporting.md`.
- Package/update behavior is documented in `docs/versioning.md`.
- The local task is still the primary planning surface. GitHub issue links are optional metadata on task items, and promotion is one-way by default to avoid issue spam.

## Does phren require MCP?

No. MCP is recommended — it gives agents 60 tools across 11 modules for reading and writing memory directly. But phren also works in hooks-only mode, where context injection still happens automatically via the prompt hook. The simpler default story is still markdown + git + local FTS5; semantic and LLM-assisted paths are optional layers, not prerequisites.

```bash
phren init --mcp off
```

Toggle anytime:

```bash
phren mcp-mode on
phren mcp-mode off
```

## How do I preview init changes without writing files?

```bash
phren init --dry-run
```

Prints what would be created or updated and exits without touching anything.

## Which agents are supported?

Claude Code, GitHub Copilot CLI, Cursor, VS Code Copilot, and OpenAI Codex.

- Shared mode configures user-scoped integrations for Claude Code, VS Code, Copilot CLI, Cursor, and Codex.
- Project-local mode configures VS Code workspace MCP only.
- Claude gets full native lifecycle hooks (`SessionStart`, `UserPromptSubmit`, `Stop`) plus MCP.
- Copilot CLI, Cursor, and Codex get generated hook configs plus session wrappers, in addition to MCP config.

## Which platforms are supported?

Linux is the primary validation path. macOS and Windows are supported, with explicit config-path handling for their user-home layouts and MCP config locations. The current support matrix and known differences live in `docs/platform-matrix.md`.

## How are skills resolved when names or aliases collide?

Skill resolution precedence is project scope over global scope. Disabled skills remain on disk but are hidden from active mirrors. Alias/command collisions are flagged and left unregistered in generated command outputs.

Generated skill artifacts:
- `.claude/skill-manifest.json`
- `.claude/skill-commands.json`

## Is telemetry on by default?

No. Telemetry is opt-in and local-only.

```bash
phren config telemetry on
```

Stats are stored in `.runtime/telemetry.json`. No external reporting is sent by default.

## Where does phren store data?

Shared mode stores data in `~/.phren` by default. Set `PHREN_PATH` to use a custom shared root.

```bash
PHREN_PATH=/path/to/my-phren phren init
```

Project-local mode stores data inside the repo:

```bash
cd /path/to/repo
phren init --mode project-local
```

That creates `<repo>/.phren` and keeps the install repo-local.

## What does uninstall remove?

`phren uninstall` now removes the active install, not just the agent config.

- Shared mode: removes Phren MCP/hooks/config plus the active Phren root and machine alias.
- Project-local mode: removes `<repo>/.phren` and the workspace MCP entry from `.vscode/mcp.json`.

If you want to preserve data, export or back up the root before uninstalling.

## How do I navigate the shell?

```bash
phren
```

Opens the interactive shell. Single-key navigation:

| Key | View |
|-----|------|
| `p` | Projects |
| `b` | Task |
| `l` | Findings |
| `m` | Review Queue |
| `s` | Skills |
| `k` | Hooks |
| `h` | Health |
| `/` | Filter current view |
| `:` | Command palette |
| `?` | Help |
| `q` | Quit |

Press `?` for the full keybinding reference inside the shell.

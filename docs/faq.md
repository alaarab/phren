# Cortex FAQ

## How is this different from just using CLAUDE.md?

`CLAUDE.md` loads the entire file on every prompt. If your file is 2,000 tokens, you pay 2,000 tokens every single time — whether the content is relevant or not. With five agents running in parallel, that's 10,000 tokens of context before anyone types a word.

Cortex searches what you wrote and injects only what matches the current prompt. By default it targets roughly 550 tokens with `CORTEX_CONTEXT_TOKEN_BUDGET`, regardless of how large your knowledge base grows. You can run more agents in parallel for the same cost, and they're not reading noise.

`CLAUDE.md` is also static. Cortex learns as you work. Every bug traced, every decision made, every pattern discovered gets saved automatically. The next session starts with that knowledge already in context.

## Does this slow down my prompts?

Usually not on a warm local repo. The hook runs locally: keyword extraction, FTS5 search, and context injection all happen against a local SQLite index with no network calls in the default path. On a healthy warm cache it is often fast enough that you will barely notice it, but the exact latency depends on corpus size, filesystem speed, and whether semantic retrieval is enabled.

The main exceptions are the first prompt in a session, where `SessionStart` pulls the cortex repo from git, and very large or slow filesystems, where index work can become noticeable. On a fast connection the pull is often under a second; on a slow connection it can be a few seconds. This is configurable — you can disable the auto-pull if you prefer to sync manually.

## What happens when I run multiple agents at the same time?

They all read and write the same `~/.cortex` directory. Concurrent reads are safe. Writes are serialized within a process by file locks; cross-process synchronization happens at the git layer.

In practice: an agent on Codex hits a pitfall and saves a finding. On the next git pull cycle, a Claude Code session on a different machine has it in context. No coordination code, no message passing — it's just a shared git repo.

The one rough edge is heavy concurrent writes on the same machine. If two agents are pushing at exactly the same moment you can get a push conflict or a locally saved commit that has not been pushed yet. Cortex retries transient git failures, rebases and auto-merges safe markdown conflicts in the background sync worker, and surfaces remaining failures in status, shell, and review UI. Under extreme parallelism, think of Cortex as eventually consistent rather than strongly coordinated.

## What failure modes should I expect?

The common ones are boring infrastructure issues, not mystery behavior:

- No remote configured: auto-save still commits locally, but nothing syncs across machines until you add a remote.
- Push failed: the commit stays local and Cortex records the last sync error so `cortex status`, shell, and review UI can show it.
- Hooks disabled or stale: retrieval stops, but your files are still there; rerun `cortex init` or `cortex hooks enable <tool>`.
- Stale index: search quality drops until the next rebuild; `cortex doctor` and `cortex status` will flag index trouble.
- Review queue growth: trust filtering is catching too much low-signal or stale content, which usually means your findings need pruning or governance thresholds need adjustment.
- Governance lockout: if access control blocks a write, nothing is silently discarded; fix `access-control.json` or your actor identity.

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

You can pin a memory with `pin_memory` to make it never decay. Pinned entries live in `CANONICAL_MEMORIES.md` and always inject regardless of age.

All thresholds are configurable via `cortex config policy`.

## How do I use the review UI?

```bash
cortex review-ui
```

Opens a browser-based interface at `localhost:3499` (configurable with `--port`). From there you can approve, reject, or edit entries in the memory queue — findings that failed trust filtering and are waiting for your review.

You can filter by machine, model, and project. Useful when you're running agents across multiple machines and want to triage what each one produced.

The terminal shell (`cortex`, then press `m`) covers the same workflow if you prefer staying in the terminal.

## What gets saved automatically vs what do I save manually?

**Automatic:**
- Findings added via `add_finding` MCP tool (agents call this when they discover something worth saving)
- Backlog items via `add_backlog_item`
- Session state committed and pushed by the Stop hook after every response

**Manual:**
- Running `/cortex-consolidate` when findings pile up and you want patterns surfaced
- Running `cortex maintain govern` to queue low-value or stale entries for review
- Pinning canonical memories that should never decay

In practice, well-configured agents save findings automatically as they work. You review the queue periodically to keep quality high, and run consolidation intentionally when the findings file starts to get repetitive.

## How do I add a new project?

```bash
/cortex-init my-project
```

This runs through a guided setup: creates `~/.cortex/my-project/` with `summary.md`, `CLAUDE.md`, `FINDINGS.md`, and `backlog.md`, then adds it to your profile. Or manually:

```bash
mkdir ~/.cortex/my-project
# add files, then run:
cortex link
```

## Does cortex require MCP?

No. MCP is recommended — it gives agents 47 tools for reading and writing memory directly. But cortex also works in hooks-only mode, where context injection still happens automatically via the prompt hook. The simpler default story is still markdown + git + local FTS5; semantic and LLM-assisted paths are optional layers, not prerequisites.

```bash
npx @alaarab/cortex init --mcp off
```

Toggle anytime:

```bash
cortex mcp-mode on
cortex mcp-mode off
```

## How do I preview init changes without writing files?

```bash
npx @alaarab/cortex init --dry-run
```

Prints what would be created or updated and exits without touching anything.

## Which agents are supported?

Claude Code, GitHub Copilot CLI, Cursor, and OpenAI Codex. `cortex init` detects which ones are installed and configures them automatically. All four share the same knowledge base — a finding saved by any one of them is available to all the others on the next pull.

## Where does cortex store data?

By default in `~/.cortex`. Set `CORTEX_PATH` to use a custom location.

```bash
CORTEX_PATH=/path/to/my-cortex cortex init
```

## How do I navigate the shell?

```bash
cortex
```

Opens the interactive shell. Single-key navigation:

| Key | View |
|-----|------|
| `p` | Projects |
| `b` | Backlog |
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

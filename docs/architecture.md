# Phren Architecture

How project memory flows through the system, from user prompt to repo-backed state and back into bounded retrieval.

Current public surface: 60 MCP tools across 11 modules.

## System Overview

```
Claude / Copilot / Cursor / Codex
            |
            v
+-------------------------------+
| Lifecycle Entry               |
| Claude: native hooks          |
| Others: wrapper + hook config |
+---------------+---------------+
                |
                v
+---------------+---------------+
| Retrieval Path                |
| hook-context + hook-prompt    |
| FTS5 lexical-first ranking    |
| optional vector recovery      |
+---------------+---------------+
                |
                v
+---------------+---------------+
| MCP Server (phren-mcp)       |
| 60 tools across 11 modules    |
+---------------+---------------+
                |
                v
+---------------+---------------+
| Data Layer (~/.phren or      |
| <repo>/.phren)               |
| markdown + json + git         |
+---------------+---------------+
                |
                v
+---------------+---------------+
| Governance + Persistence       |
| RBAC, trust filters, review    |
| queue, sync + session tracking |
+-------------------------------+
```

## Install Modes

Phren has two install modes, rooted by `phren.root.yaml`:

- `shared`: default personal memory at `~/.phren`, with profiles, machine mappings, user-scoped MCP config, and full Claude lifecycle hooks
- `project-local`: repo-owned memory at `<repo>/.phren`, with one primary project, workspace-managed git, and workspace MCP wiring

Runtime path resolution order:

1. explicit CLI path argument
2. `PHREN_PATH`
3. nearest ancestor `.phren` containing `phren.root.yaml`
4. shared root at `~/.phren` only if it contains `phren.root.yaml`

## End-to-End Runtime Loop

```
[1] Session lifecycle trigger
    Claude: SessionStart/UserPromptSubmit/Stop
    Copilot/Cursor/Codex: session wrapper + tool hook config

[2] Retrieval
    keyword extraction + synonym expansion
    lexical-first FTS5 retrieval
    optional vector fallback when lexical confidence is low
    recency/task-aware reranking

[3] Governance
    citation checks + confidence decay + policy gates
    stale/low-confidence items filtered or queued

[4] Persistence
    MCP writes to markdown/json
    stop lifecycle persists via git and sync worker

[5] Next prompt
    retrieval reads newly persisted state
```

## Hook and Integration Model

Claude uses native lifecycle hooks in `~/.claude/settings.json`:

- `SessionStart` -> `hook-session-start`
- `UserPromptSubmit` -> `hook-prompt`
- `Stop` -> `hook-stop`

Copilot CLI, Cursor, and Codex use two layers:

- generated per-tool hook config files
- generated session wrapper binaries in `~/.local/bin/` that enforce lifecycle behavior around each tool invocation

This gives Claude full native lifecycle parity while keeping other tools synchronized through wrappers + config.

## MCP Server Modules

Phren MCP is split into 11 modules:

1. Search and browse
2. Task management
3. Finding capture and lifecycle
4. Memory quality
5. Data management
6. Fragment graph
7. Session management
8. Operations and review queue
9. Skills management
10. Hooks management
11. Extraction

Newly documented finding lifecycle tools:

- `supersede_finding`
- `retract_finding`
- `resolve_contradiction`
- `get_contradictions`

Newly documented session continuity tool:

- `session_history`

## Data Layer

All state stays local as files (markdown/json), with git as transport in shared mode.

```
~/.phren/
  machines.yaml
  profiles/*.yaml
  <project>/
    CLAUDE.md
    summary.md
    FINDINGS.md
    tasks.md
    review.md
    truths.md
    reference/
    skills/
  global/
    CLAUDE.md
    FINDINGS.md
    skills/

  .governance/
    access-control.json
    retention-policy.json
    workflow-policy.json
    index-policy.json

  .runtime/
    runtime-health.json
    audit.log
    telemetry.json
    access-control.local.json
    shell-state.json
    session-metrics.json

  .runtime/sessions/
    session-*.json
    last-summary.json

  .sessions/
    checkpoint-<project>-<task>.json
```

## Findings: Lifecycle, Provenance, Impact

Findings now carry richer state:

- provenance source via `add_finding.source`:
  - `human`, `agent`, `hook`, `extract`, `consolidation`, `unknown`
- lifecycle state stored inline (active/superseded/contradicted/retracted/stale/invalid_citation)
- contradiction and supersession handled by dedicated lifecycle tools

Impact scoring pipeline:

1. injected findings are logged by ID when surfaced in context
2. session completion checks for task completion in that session
3. completed outcomes update impact logs
4. high-impact findings get boosted in future retrieval

## Session Continuity

Session continuity has three parts:

- `session_start` returns prior summary + recent findings + checkpoint hints
- `session_end` writes summary and task checkpoint snapshots
- `session_history` lists sessions or returns detailed session artifacts

Task checkpoints include task ID/text, edited files, failing tests, and resume hints (`lastAttempt` and `nextStep`). Completed tasks clear their checkpoint files.

## Skill Resolution System

Skill resolution is deterministic and policy-aware:

- precedence: project scope overrides global scope for same skill name
- alias collisions: colliding commands/aliases are marked unregistered
- visibility gating: disabled skills stay on disk but are hidden from active agent mirrors
- generated artifacts:
  - `.claude/skill-manifest.json`
  - `.claude/skill-commands.json`

## Governance Identity and RBAC

Identity and authorization flow:

- actor identity from `PHREN_ACTOR` (in trusted/test contexts) or OS user identity
- shared role policy from `.governance/access-control.json`
- local fallback/augmentation from `.runtime/access-control.local.json`

RBAC roles:

- `admin`
- `maintainer`
- `contributor`
- `viewer`

Write/policy/delete operations are checked against RBAC before mutation.

## Web UI Security Model

Web UI (`phren web-ui`) is hardened by default:

- binds only to loopback (`127.0.0.1`)
- issues random per-run auth token (bearer/query/body)
- requires CSRF token for mutating routes
- CSRF tokens are single-use with TTL
- sets CSP and anti-framing headers (`Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`)

Mutating endpoints require both auth and CSRF.

## Telemetry Model

Telemetry is opt-in and local-only:

- default: disabled
- enable: `phren config telemetry on`
- storage: `.runtime/telemetry.json`
- captured data: tool call counts, CLI command counts, session/error counters, last activity
- no external reporting by default

## Retrieval and Context Efficiency

Retrieval is optimized for bounded context usage:

- lexical-first FTS5 path handles most queries
- vector fallback runs only when lexical confidence is weak
- progressive disclosure keeps injection bounded (`PHREN_CONTEXT_TOKEN_BUDGET`)
- task APIs support summary/pagination/single-item fetch patterns

This keeps memory growth and prompt context growth decoupled.

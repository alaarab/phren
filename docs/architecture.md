# Cortex Architecture

How data flows through the system, from user prompt to persistent memory.

## System Overview

```
 Claude Code
 +-------------------+
 |  User Prompt      |
 |  (any session)    |
 +--------+----------+
          |
          v
 +--------+----------+     +-------------------+
 | Hook: SessionStart |     | Hook: Stop        |
 | git pull --rebase  |     | git add + commit  |
 | hook-context       |     | git push          |
 +--------+----------+     +--------+----------+
          |                          ^
          v                          |
 +--------+----------+     +--------+----------+
 | Hook:              |     | MCP Server        |
 | UserPromptSubmit   |     | (cortex-mcp)      |
 | hook-prompt        |     | MCP tools         |
 +--------+----------+     +--------+----------+
          |                          |
          v                          v
 +--------+----------+     +--------+----------+
 | FTS5 Search Index  |     | Data Layer        |
 | (in-memory SQLite) |<--->| ~/.cortex/<proj>/ |
 +--------------------+     +-------------------+
```

## End-to-End Data Flow Loop (Practical View)

This is the core runtime loop from one prompt to the next:

```
[1] Hooks Trigger
    SessionStart / UserPromptSubmit / Stop
        |
        v
[2] Retrieval Path
    hook-context + hook-prompt
    -> keyword extraction + synonym expansion
    -> FTS5 search over ~/.cortex markdown state
    -> top snippets injected into model context
        |
        v
[3] Governance Path
    trust checks before injection
    -> citation validity + confidence decay + policy thresholds
    -> low-confidence or stale items filtered/queued
        |
        v
[4] Persistence Path
    MCP tool writes (findings/backlog/memories)
    + Stop hook git add/commit/push
    -> updated markdown + governance config become source of truth
        |
        +---------------------------------------------+
                                                      |
                                                      v
                                        Next UserPromptSubmit reads
                                        the newly persisted state
```

In practice:
1. A user prompt triggers `UserPromptSubmit`, which runs fast retrieval against the cached FTS5 index.
2. Matching memories are filtered by governance rules before any context injection.
3. During the turn, MCP tools can add or update memory/backlog files in `~/.cortex/<project>/`.
4. `Stop` persists those file changes through git, making them available for the next retrieval cycle.

## Hook Pipeline

### SessionStart

Runs once when a Claude Code session begins.

```
SessionStart
  |
  +-> git pull --rebase ~/.cortex
  |     (sync latest from remote)
  |
  +-> hook-context
        |
        +-> detect project from cwd
        +-> read project CLAUDE.md, summary.md
        +-> inject into session context
```

### UserPromptSubmit

Runs on every user prompt. Budget: ~250ms.

```
UserPromptSubmit (stdin: JSON with prompt text)
  |
  +-> extract keywords (stop-word filter + bigrams)
  |
  +-> FTS5 search with synonym expansion
  |     query capped at 20 terms
  |
  +-> trust filter
  |     check citation validity
  |     apply confidence decay (d30/d60/d90/d120)
  |     skip entries below minInjectConfidence
  |
  +-> inject top snippets into prompt context
  |     token budget: CORTEX_CONTEXT_TOKEN_BUDGET (default 550)
  |     per-snippet cap: CORTEX_CONTEXT_SNIPPET_LINES / _CHARS
  |
  +-> check consolidation threshold
        if 25+ entries since last marker, inject one-time notice
        tracked via ~/.cortex/.noticed-{session_id}
```

### Stop

Runs after every Claude response (including subagent responses).

```
Stop
  |
  +-> git add -A ~/.cortex
  +-> git commit (if changes exist)
  +-> git push (if remote configured)
        retry with pull --rebase on conflict
        auto-merge FINDINGS.md / backlog.md if possible
```

## MCP Server

The MCP server exposes tools organized into seven categories.

```
Claude Code <--stdio--> cortex-mcp
                          |
          +---------------+---------------+
          |               |               |
     Search/Browse   Backlog CRUD       Finding Capture
     - search_knowledge - get_backlog   - add_finding(s)
     - get_project_summary      - add_item     - remove_finding(s)
     - list_projects    - complete(s)  - push_changes
     - get_findings     - update
          |
     Memory Quality     Data Management
     - pin_memory       - export_project
     - memory_feedback  - import_project
                        - manage_project

     Entity Graph         Session Management
     - search_entities    - session_start
     - get_related_docs   - session_end
     - read_graph         - session_context
     - link_findings
     - cross_project_entities

     Governance (CLI-only: `cortex config` and `cortex maintain`)
```

## Data Layer

All state lives in `~/.cortex/` as plain files, committed to git.

```
~/.cortex/
  machines.yaml            # hostname -> profile mapping
  profiles/
    *.yaml                 # profile -> project list
  <project>/
    CLAUDE.md              # project instructions
    summary.md             # one-liner + stack description
    FINDINGS.md            # captured insights (with citation comments)
    CANONICAL_MEMORIES.md  # pinned high-signal memories
    MEMORY_QUEUE.md        # pending review (stale/conflicts/low-value)
    backlog.md             # task tracking (Active/Queue/Done)
  global/
    CLAUDE.md              # cross-project instructions
    FINDINGS.md            # cross-project insights
  .governance/
    retention-policy.json  # retention, ttl, decay, confidence
    workflow-policy.json   # approval gates for risky entries
    access-control.json    # role-based permissions
    index-policy.json      # include/exclude globs
    shell-state.json       # interactive shell persistence
    cache/
      <hash>.db            # FTS5 index cache (SQLite)
```

## FTS5 Index

Built at MCP server startup, cached to disk by content hash.

```
Build:
  scan project dirs -> glob *.md files -> read + classify
  -> INSERT into FTS5 virtual table (project, filename, type, content, path)

Query:
  sanitize input -> expand synonyms (cap at 20 terms)
  -> FTS5 MATCH with quoted OR terms
  -> rank by relevance, boost recent files (1.2x for last 30 days)
```

## Memory Governance

Automated quality control for FINDINGS.md entries.

```
cortex maintain govern
  |
  +-> scan FINDINGS.md for each project
  |
  +-> trust filter
  |     stale: older than ttlDays without recent citation
  |     invalid: citation points to missing file/commit
  |     low-value: short entries or generic patterns
  |
  +-> append to MEMORY_QUEUE.md (Review/Stale/Conflicts sections)
  |
  +-> consolidate: deduplicate bullets
  |
  +-> enforce canonical locks (pinned entries stay)

approve/reject/edit queue items via MCP tools or review-ui
```

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
| hook-context       |     | queue sync worker |
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
    -> 3-tier RRF search (FTS5 + token-overlap + vector embeddings)
    -> recency boost applied to ranking
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
    + Stop hook git add/commit/background sync
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
4. `Stop` persists those file changes locally through git, then queues background sync work if a remote is configured.

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
  +-> 3-tier RRF search (FTS5 + token-overlap + vector)
  |     query capped at 20 terms
  |     all tiers run in parallel, merged by reciprocal rank
  |     recency boost: <=7d +0.3, <=30d +0.15
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
  +-> record saved-local runtime state
  +-> schedule background sync worker (if remote configured)
        push in detached step
        pull --rebase on conflict
        auto-merge FINDINGS.md / backlog.md if possible
```

## MCP Server

The MCP server exposes 46 tools organized into ten categories.

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

     Skills               Hooks
     - list_skills        - list_hooks
     - read_skill         - toggle_hooks
     - write_skill        - add_custom_hook
     - remove_skill       - remove_custom_hook

     Operations
     - health_check       - approve_queue_item
     - get_consolidation  - reject_queue_item
     - list_hook_errors   - edit_queue_item

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

## Search and Retrieval

### Three-Tier Hybrid Search with RRF

Search uses three tiers that run in parallel, with results merged by Reciprocal Rank Fusion (RRF):

```
Query
  |
  +-> Tier 1: FTS5 (primary)
  |     sanitize input -> expand synonyms (cap at 20 terms)
  |     -> FTS5 MATCH with quoted OR terms
  |
  +-> Tier 2: Token-overlap semantic
  |     TF-IDF cosine similarity over indexed documents
  |     cache invalidated on incremental index updates
  |
  +-> Tier 3: Vector embeddings (when configured)
  |     uses CORTEX_EMBEDDING_API_URL or Ollama
  |     embedding cache loaded on first call (including hook subprocesses)
  |     cached to .runtime/embed-cache.jsonl by SHA-256 hash
  |
  +-> RRF merge
        merge ranked lists from all tiers by reciprocal rank
        apply recency boost: <=7 days +0.3, <=30 days +0.15
        -> final ranked results
```

Search and hook injection now share the same core ranking path. Benchmark notes still need to publish whether embeddings were enabled and what corpus was indexed, because the quality story depends on those conditions.

### FTS5 Index

Built at MCP server startup, cached to disk by content hash.

```
Build:
  scan project dirs -> glob *.md files -> read + classify
  -> INSERT into FTS5 virtual table (project, filename, type, content, path)

Query:
  sanitize input -> expand synonyms (cap at 20 terms)
  -> FTS5 MATCH with quoted OR terms
```

## MCP Context Optimization

MCP tool responses consume context tokens. Cortex provides progressive disclosure patterns to minimize overhead. See [Context Optimization](context-optimization.md) for the full guide.

**Backlog progressive disclosure:**

```
Tier 1: get_backlog(summary:true)        ~200 tokens   planning/status
Tier 2: get_backlog(limit:10, offset:0)  ~1,000 tokens  reviewing details
Tier 3: get_backlog(id:"bid:a3f9c2e1")   ~100 tokens   single item execution
```

**Search progressive disclosure** (when `CORTEX_FEATURE_PROGRESSIVE_DISCLOSURE=1`):

```
1-2 results: full snippets injected directly
3+ results:  compact index injected (mem:project/filename + summary)
             agent calls get_memory_detail(id) to expand
```

**Stable identifiers:** Backlog items embed `<!-- bid:XXXXXXXX -->` content-addressed hashes that survive reordering and completions. Use these instead of positional IDs (A1, Q3) for cross-session or multi-agent references.

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

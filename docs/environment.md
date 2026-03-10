# Environment Variables Reference

All environment variables are optional. cortex uses sensible defaults when they are not set.

## Core

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `CORTEX_PATH` | string | `~/.cortex` | Override the cortex directory location. |
| `CORTEX_PROFILE` | string | (empty) | Active profile name. Filters which projects are indexed. When empty, all projects are indexed. |
| `CORTEX_DEBUG` | `0` or `1` | `0` | Set to `1` to enable debug logging to `~/.cortex/debug.log`. |
| `CORTEX_ACTOR` | string | `$USER` or `$USERNAME` | Identifies who performed a governance action. Used in audit logs and access control checks. |

## Context Injection (hook-prompt)

These control how much context the UserPromptSubmit hook injects into each prompt.

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `CORTEX_CONTEXT_TOKEN_BUDGET` | integer | `550` | Maximum approximate tokens injected per prompt. |
| `CORTEX_CONTEXT_SNIPPET_LINES` | integer | `6` | Maximum lines per injected snippet. |
| `CORTEX_CONTEXT_SNIPPET_CHARS` | integer | `520` | Maximum characters per injected snippet. |
| `CORTEX_MAX_INJECT_TOKENS` | integer | `2000` | Maximum tokens injected per prompt (overrides token budget). Range: 200-20000. |
| `CORTEX_BACKLOG_PRIORITY` | string | `high,medium` | Comma-separated list of backlog priorities to inject. Set to `high` to inject only high-priority items. |

## Memory Governance

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `CORTEX_MEMORY_TTL_DAYS` | integer | `120` | How many days before a finding is considered stale. Overrides the value in `retention-policy.json`. |
| `CORTEX_MEMORY_AUTO_ACCEPT` | float | `0.75` | Confidence threshold for auto-accepting extracted memories. Below this, entries go to MEMORY_QUEUE.md for review. |
| `CORTEX_MEMORY_EXTRACT_WINDOW_DAYS` | integer | `30` | How far back (in days) the `extract-memories` command looks in git and GitHub history. |
| `CORTEX_FINDINGS_CAP` | integer | `20` | Maximum findings in FINDINGS.md before auto-archival moves old entries to `reference/`. |

## File Locking

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `CORTEX_FILE_LOCK_MAX_WAIT_MS` | integer | `5000` | Maximum time to wait for a file lock before giving up. |
| `CORTEX_FILE_LOCK_POLL_MS` | integer | `100` | How often to poll for lock availability. |
| `CORTEX_FILE_LOCK_STALE_MS` | integer | `30000` | Age after which a lock file is considered stale and auto-recovered. |

## GitHub Integration (extract-memories)

These control the `gh` CLI calls used by `extract-memories` to pull signals from PRs, CI runs, and issues.

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `CORTEX_GH_RETRIES` | integer | `2` | Number of retry attempts for failed `gh` API calls. Range: 0-5. |
| `CORTEX_GH_TIMEOUT_MS` | integer | `10000` | Timeout in milliseconds for each `gh` command. Range: 1000-60000. |
| `CORTEX_GH_PR_LIMIT` | integer | `40` | Maximum number of recent PRs to fetch. Range: 5-200. |
| `CORTEX_GH_RUN_LIMIT` | integer | `25` | Maximum number of recent CI workflow runs to fetch. Range: 5-200. |
| `CORTEX_GH_ISSUE_LIMIT` | integer | `25` | Maximum number of recent issues to fetch. Range: 5-200. |

## Embeddings

These control the vector embedding tier used in hybrid search and hook retrieval.

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `CORTEX_EMBEDDING_API_URL` | string | (none) | OpenAI-compatible `/embeddings` endpoint (e.g. `https://api.openai.com/v1`). When set, used for both hook retrieval and MCP search. Takes priority over Ollama. |
| `CORTEX_EMBEDDING_API_KEY` | string | (none) | Bearer token for `CORTEX_EMBEDDING_API_URL`. Required when using a cloud embedding endpoint. |

## LLM Integration

These control the optional LLM calls used for semantic dedup and conflict detection.

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `CORTEX_LLM_ENDPOINT` | string | (none) | OpenAI-compatible endpoint URL for semantic dedup/conflict LLM calls. |
| `CORTEX_LLM_KEY` | string | (none) | API key for LLM endpoint. Falls back to `OPENAI_API_KEY` then `ANTHROPIC_API_KEY`. |
| `CORTEX_LLM_MODEL` | string | `gpt-4o-mini` / `claude-haiku-4-5-20251001` | Model name override. Default depends on whether the OpenAI or Anthropic path is used. |

## Feature Flags

Feature flags follow a convention: set to `0`, `false`, `off`, or `no` to disable. Any other value (or unset) means enabled.

| Variable | Default | Description |
|----------|---------|-------------|
| `CORTEX_FEATURE_AUTO_EXTRACT` | enabled | Automatically extract memory candidates from git/GitHub signals once per session per project during hook-prompt. |
| `CORTEX_FEATURE_DAILY_MAINTENANCE` | enabled | Schedule background maintenance (pruning and canonical lock enforcement) once per day during hook-session-start. |
| `CORTEX_FEATURE_AUTO_CAPTURE` | disabled | Set to `1` to extract insights from conversation transcripts at session end (Stop hook). Enabled during `cortex init` walkthrough. |
| `CORTEX_FEATURE_SEMANTIC_DEDUP` | disabled | Set to `1` to enable LLM-based paraphrase dedup when adding findings. |
| `CORTEX_FEATURE_SEMANTIC_CONFLICT` | disabled | Set to `1` to enable LLM-based contradiction detection when adding findings. |
| `CORTEX_FEATURE_GH_MINING` | disabled | Set to `1` to mine GitHub signals in `cortex maintain extract`. |

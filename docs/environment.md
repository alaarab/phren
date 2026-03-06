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

## Memory Governance

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `CORTEX_MEMORY_TTL_DAYS` | integer | `120` | How many days before a learning is considered stale. Overrides the value in `memory-policy.json`. |
| `CORTEX_MEMORY_AUTO_ACCEPT` | float | `0.75` | Confidence threshold for auto-accepting extracted memories. Below this, entries go to MEMORY_QUEUE.md for review. |
| `CORTEX_MEMORY_EXTRACT_WINDOW_DAYS` | integer | `30` | How far back (in days) the `extract-memories` command looks in git and GitHub history. |

## GitHub Integration (extract-memories)

These control the `gh` CLI calls used by `extract-memories` to pull signals from PRs, CI runs, and issues.

| Variable | Type | Default | Range |
|----------|------|---------|-------|
| `CORTEX_GH_RETRIES` | integer | `2` | 0-5 |
| `CORTEX_GH_TIMEOUT_MS` | integer | `10000` | 1000-60000 |
| `CORTEX_GH_PR_LIMIT` | integer | `40` | 5-200 |
| `CORTEX_GH_RUN_LIMIT` | integer | `25` | 5-200 |
| `CORTEX_GH_ISSUE_LIMIT` | integer | `25` | 5-200 |

| Variable | Description |
|----------|-------------|
| `CORTEX_GH_RETRIES` | Number of retry attempts for failed `gh` API calls. |
| `CORTEX_GH_TIMEOUT_MS` | Timeout in milliseconds for each `gh` command. |
| `CORTEX_GH_PR_LIMIT` | Maximum number of recent PRs to fetch. |
| `CORTEX_GH_RUN_LIMIT` | Maximum number of recent CI workflow runs to fetch. |
| `CORTEX_GH_ISSUE_LIMIT` | Maximum number of recent issues to fetch. |

## Feature Flags

Feature flags follow a convention: set to `0`, `false`, `off`, or `no` to disable. Any other value (or unset) means enabled.

| Variable | Default | Description |
|----------|---------|-------------|
| `CORTEX_FEATURE_AUTO_EXTRACT` | enabled | Automatically extract memory candidates from git/GitHub signals once per session per project during hook-prompt. |
| `CORTEX_FEATURE_DAILY_MAINTENANCE` | enabled | Schedule background maintenance (pruning, canonical lock enforcement, legacy migration) once per day during hook-session-start. |

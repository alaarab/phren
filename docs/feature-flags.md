# Feature Flags

cortex uses environment variables as feature flags to control optional behaviors. All flags are enabled by default. Set to `0`, `false`, `off`, or `no` to disable.

## CORTEX_FEATURE_AUTO_EXTRACT

**Default:** enabled

Controls automatic memory extraction during the `hook-prompt` lifecycle hook. When enabled, cortex runs `extract-memories` once per session per project. This mines git history and GitHub signals (PRs, CI runs, issues) for memory candidates.

The extraction happens in the background during the UserPromptSubmit hook. It writes candidates to MEMORY_QUEUE.md for review rather than directly to LEARNINGS.md. The confidence threshold for auto-acceptance is controlled by `CORTEX_MEMORY_AUTO_ACCEPT` (default: 0.75).

**When to disable:**
- In CI environments or automated pipelines where git/GitHub lookups add unwanted latency
- When working in repositories where `gh` CLI is not authenticated
- If extraction is generating too many low-quality candidates

```bash
export CORTEX_FEATURE_AUTO_EXTRACT=0
```

## CORTEX_FEATURE_DAILY_MAINTENANCE

**Default:** enabled

Controls the daily background maintenance job scheduled during `hook-session-start`. When enabled, cortex spawns a detached background process (once per calendar day) that runs:

- Memory pruning based on retention policy
- Canonical lock enforcement
- Legacy findings migration
- Dead memory cleanup

The maintenance process runs independently and does not block the session. A marker file (`.quality-YYYY-MM-DD`) prevents it from running more than once per day.

**When to disable:**
- On shared machines where background processes are not desired
- During development/testing of cortex itself
- If you prefer to run governance commands manually

```bash
export CORTEX_FEATURE_DAILY_MAINTENANCE=0
```

## How Feature Flags Work

The `isFeatureEnabled` function in `cli.ts` reads the named environment variable. If the value is `0`, `false`, `off`, or `no` (case-insensitive, trimmed), the feature is disabled. Any other value, or if the variable is not set, means the feature is enabled.

This convention applies to all `CORTEX_FEATURE_*` variables.

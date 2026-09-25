# Environment Variables Reference

All environment variables are optional. phren uses sensible defaults when they are not set.

## Management presets

How much of your machine phren wires up is controlled by a **management preset**
(`managed` | `assisted` | `manual`), set with `phren init --preset <name>` and
switchable anytime with `phren preset <name>`. The preset lives in
`install-preferences.json` (absent → `managed`). `managed` is the default and
symlinks into `~/.claude`, installs wrappers, and self-heals every session;
`assisted` keeps hooks + MCP but writes nothing outside the store; `manual` is an
MCP server only. See [footprint.md](footprint.md) for a full path-by-path table
and precedence rules. `phren status` shows the active preset and what it touches.

## Periodic Git checks

| Variable | Values | Default | Effect |
|----------|--------|---------|--------|
| `PHREN_PULL_INTERVAL_SECONDS` | Whole seconds from `30` to `86400`; `0` or `off` disables | `0` (off) | Overrides `phren config pull-interval` for periodic checks by running MCP servers. |

Periodic checks are off by default. Use `phren config pull-interval 600` for ten minutes, `phren config pull-interval 60` for one minute, or `phren config pull-interval off`. With no value, the command shows the effective setting and its source. The preference lives in this machine's `.runtime/install-preferences.json`; running servers reload it automatically. An environment override takes precedence and requires restarting the server when changed.

The first remote check runs after the configured interval. MCP clients sharing a store coordinate one check per interval using local locks and `.runtime/pull-poll.json`. A check reads the upstream's advertised commit with `git ls-remote`; only changed refs trigger a fetch. Updates require a clean worktree and fast-forward history. Dirty stores, diverged histories, and in-progress Git operations are left for the existing sync/recovery flows, with the reason recorded in runtime sync status. Failed network checks back off exponentially, capped at 30 minutes or the configured interval if longer.

Polling covers the primary and registered secondary Git stores while an MCP server is running. It refreshes each client's index and existing managed skill/instruction mirrors when local commits change. Agents consume updated instructions at their normal reload boundaries. The manual preset and project-local/workspace-Git installs do not poll by default. Disabling periodic checks does not disable SessionStart/Stop hooks. This setting installs no background service.

## MCP tool profile

| Variable | Values | Default | Effect |
|----------|--------|---------|--------|
| `PHREN_MCP_PROFILE` | `core`, `full` | `core` (or whatever `phren config mcp-profile` set) | `core` exposes ten tools with everything else behind `phren_admin`; `full` exposes every tool by name. See `api-reference.md`. |

## Core

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PHREN_PATH` | string | `~/.phren` | Override the phren directory location. |
| `PHREN_PROFILE` | string | (empty) | Active profile name. Filters which projects are indexed. When empty, all projects are indexed. |
| `PHREN_DEBUG` | `0` or `1` | `0` | Set to `1` to enable debug logging to `~/.phren/debug.log`. |
| `PHREN_ACTOR` | string | `$USER` or `$USERNAME` | Identifies who performed a governance action. Used in audit logs and access control checks. |
| `PHREN_SKIP_GLOBAL_NPM_UNINSTALL` | `0` or `1` | `0` | Set to `1` to make `phren uninstall` leave the global npm package (`@phren/cli`) installed. `npm uninstall -g` targets the machine's real npm prefix, which `PHREN_PATH`/`HOME` cannot redirect, set this whenever you run `phren uninstall` against a sandboxed store you don't want affecting the machine. The test helpers set it for every spawned CLI. |

## Context Injection (hook-prompt)

These control how much context the UserPromptSubmit hook injects into each prompt.

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PHREN_CONTEXT_TOKEN_BUDGET` | integer | `550` | Maximum approximate tokens injected per prompt. |
| `PHREN_CONTEXT_SNIPPET_LINES` | integer | `6` | Maximum lines per injected snippet. |
| `PHREN_CONTEXT_SNIPPET_CHARS` | integer | `520` | Maximum characters per injected snippet. |
| `PHREN_MAX_INJECT_TOKENS` | integer | `2000` | Maximum tokens injected per prompt (overrides token budget). Range: 200-20000. |
| `PHREN_TASK_PRIORITY` | string | `high,medium` | Comma-separated list of task priorities to inject. Set to `high` to inject only high-priority items. |
| `PHREN_PROACTIVITY` | `high`/`medium`/`low` | `high` | Auto-capture level for findings and tasks. Configured with `phren config proactivity <level>`; overrides the stored value. |
| `PHREN_PROACTIVITY_FINDINGS`, `PHREN_PROACTIVITY_TASKS` | `high`/`medium`/`low` | base level | Findings-only and task-only overrides. Configured with `phren config proactivity <level> --scope findings|tasks` (or `proactivity.findings` / `proactivity.tasks`), per project with `--project`; over MCP, `set_config` domain `proactivity` with `scope`. Stored as `proactivityFindings` / `proactivityTask` in `.config/install-preferences.json`. |

## Memory Governance

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PHREN_MEMORY_TTL_DAYS` | integer | `120` | How many days before a finding is considered stale. Overrides the value in `retention-policy.json`. |
| `PHREN_MEMORY_AUTO_ACCEPT` | float | `0.75` | Confidence threshold for auto-accepting extracted memories. Below this, entries go to review.md for review. |
| `PHREN_MEMORY_EXTRACT_WINDOW_DAYS` | integer | `30` | How far back (in days) the `extract-memories` command looks in git and GitHub history. |
| `PHREN_FINDINGS_CAP` | integer | `20` | Maximum findings in FINDINGS.md before auto-archival moves old entries to `reference/`. |

## Finding citations

A finding can carry a source citation in a `<!-- phren:cite {json} -->` comment.
Besides `file`, `line`, `repo` and `commit`, the object may link the finding to a
function, type or variable as `name: "Name"`, `name: "Type.member"` or
`name: "name()"` (the older `symbol` spelling is accepted until 0.2.18). When the project
has a code index (the `code` module), a finding whose text names exactly one
function, type or variable the index resolves, at least four characters long
and not a local variable unless exported, gets that link attached
automatically; the finding text is never rewritten. An explicit `name` is
validated against the index and stored either way: one that does not resolve is
kept and marked unresolved, the counterpart of an invalid file citation, and
the trust filter treats it as `invalid_citation`. `code_definition` lists the
findings linked to it, and `get_findings` / `search_knowledge` return the link
so a client can show it. See
[store-format.md](store-format.md#3-metadata-comments).

## File Locking

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PHREN_FILE_LOCK_MAX_WAIT_MS` | integer | `5000` | Maximum time to wait for a file lock before giving up. |
| `PHREN_FILE_LOCK_POLL_MS` | integer | `100` | How often to poll for lock availability. |
| `PHREN_FILE_LOCK_STALE_MS` | integer | `30000` | Age after which a lock file is considered stale and auto-recovered. |

## GitHub Integration (extract-memories)

These control the `gh` CLI calls used by `extract-memories` to pull signals from PRs, CI runs, and issues.

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PHREN_GH_RETRIES` | integer | `2` | Number of retry attempts for failed `gh` API calls. Range: 0-5. |
| `PHREN_GH_TIMEOUT_MS` | integer | `10000` | Timeout in milliseconds for each `gh` command. Range: 1000-60000. |
| `PHREN_GH_PR_LIMIT` | integer | `40` | Maximum number of recent PRs to fetch. Range: 5-200. |
| `PHREN_GH_RUN_LIMIT` | integer | `25` | Maximum number of recent CI workflow runs to fetch. Range: 5-200. |
| `PHREN_GH_ISSUE_LIMIT` | integer | `25` | Maximum number of recent issues to fetch. Range: 5-200. |

## Embeddings

These control the vector embedding tier used in hybrid search and hook retrieval.

Use this tier when you expect paraphrase-heavy or fuzzy retrieval. Leave it disabled if your searches are mostly exact identifiers, filenames, commands, or project names.

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PHREN_EMBEDDING_API_URL` | string | (none) | OpenAI-compatible `/embeddings` endpoint (e.g. `https://api.openai.com/v1`). When set, used for both hook retrieval and MCP search. Takes priority over Ollama. |
| `PHREN_EMBEDDING_API_KEY` | string | (none) | Bearer token for `PHREN_EMBEDDING_API_URL`. Required when using a cloud embedding endpoint. |

## LLM Integration

These control the optional LLM calls used for semantic dedup and conflict detection.

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PHREN_LLM_ENDPOINT` | string | (none) | OpenAI-compatible endpoint URL for semantic dedup/conflict LLM calls. |
| `PHREN_LLM_KEY` | string | (none) | API key for LLM endpoint. Falls back to `OPENAI_API_KEY` then `ANTHROPIC_API_KEY`. |
| `PHREN_LLM_TIMEOUT_MS` | integer | `10000` | Floor for the per-call LLM timeout. Summaries already wait up to 120s; raise this if a local model needs longer for dedup/conflict checks too. |
| `PHREN_LLM_MODEL` | string | `gpt-4o-mini` / `claude-haiku-4-5-20251001` | Model name override. Default depends on whether the OpenAI or Anthropic path is used. |

## Feature Flags

Feature flags follow a convention: set to `0`, `false`, `off`, or `no` to disable. Any other value (or unset) means enabled.

| Variable | Default | Description |
|----------|---------|-------------|
| `PHREN_FEATURE_AUTO_EXTRACT` | enabled | Automatically extract memory candidates from git/GitHub signals once per session per project during hook-prompt. |
| `PHREN_FEATURE_DAILY_MAINTENANCE` | enabled | Schedule background maintenance (pruning and canonical lock enforcement) once per day during hook-session-start. |
| `PHREN_FEATURE_AUTO_CAPTURE` | disabled | Set to `1` to extract insights from conversation transcripts at session end (Stop hook). Enabled during `phren init` walkthrough. |
| `PHREN_FEATURE_SEMANTIC_DEDUP` | disabled | Set to `1` to enable LLM-based paraphrase dedup when adding findings. |
| `PHREN_FEATURE_SEMANTIC_CONFLICT` | disabled | Set to `1` to enable LLM-based contradiction detection when adding findings. |
| `PHREN_FEATURE_GH_MINING` | disabled | Set to `1` to mine GitHub signals in `phren maintain extract`. |

### Phren Hook locations

The optional iPhone helper is installed with `phren bridge install`; it uses
`PHREN_SPEECH_VOICE` to choose the ElevenLabs voice id for talk mode's spoken replies
(`POST /v1/speech`; the default is River), `PHREN_BRIDGE_HOME` to override `~/.local/share/phren/bridge` for isolated tests,
and `PHREN_HERDR_HOME` to override `~/.config/herdr`. Normal phone installations
use the defaults. Transcript and callback settings respect `CODEX_HOME`,
`CLAUDE_CONFIG_DIR`, and `COPILOT_HOME`. `PHREN_APPROVAL_HOLD_MS` overrides how
long the Hook holds a permission ask for the phone (default `55000`, the whole
Claude window is 60000); tests shorten it. Tests also shorten
`PHREN_IDENTITY_CACHE_MS` (how long a pane's process-based conversation probe
is reused, default `2000`) and `PHREN_DIALOG_THROTTLE_MS` (how often a waiting
pane's terminal dialog is read, default `3000`); the Hook reads all three once
at startup. `PHREN_SNAPSHOT_SHARE_MS` sets how old a Herdr `session.snapshot`
may be for the chat and status streams and the activity timer to share it
(default `2500`; `0` stops reusing answers), and `PHREN_SERVER_LIST_REUSE_MS` how
long the activity timer reuses the list of running Herdr servers (default
`30000`). The installed service uses its own user
session environment; keep these paths consistent with the coding agents.
See [Phren Hook setup](phren-hook.md) and [written files](footprint.md).

The Claude model menu reads the newest
`<CLAUDE_CONFIG_DIR>/cache/model-catalog/*-cc.json` (default config directory
`~/.claude`). The Hook checks the installed client's version before offering
version-gated rows, preserves the catalogue's names and order, and adds the
default model's 1M option. An unreadable or empty catalogue uses the built-in
fallback. The result is cached in memory for ten minutes. No new environment
variable is needed for this menu.

OpenCode reply previews use a `.preview.json` sidecar beside the mirrored
session event log under `<store>/.runtime/sessions`. Hook reads this temporary
turn text for the live socket; it does not add it to transcript history.

### Code and worker files

| Variable | Default | Use |
| --- | --- | --- |
| `PHREN_CODE_PACKAGE` | unset | Explicit optional code-package location, checked before the bridge and store package directories. |
| `PROJECTS_DIR` | unset | Additional checkout root used when resolving a project's code index source. |
| `PHREN_FANOUT_JOB` | set by the launcher | Worker job ID; tells the OpenCode plugin that the worker is headless. |
| `PHREN_FANOUT_DIR` | `<store>/.runtime/agent-fanouts/<job id>` | Worker directory; a refused permission is recorded in `blocked.json` here. |

Code indexes live in `<store>/.runtime/code/<project>.sqlite`. Their
declaration fingerprints and last-observed change times stay local. The optional package
can live under `<store>/.runtime/packages/node_modules/@phren/code`.

Workers write manifests, event logs, stderr and exit records under
`<store>/.runtime/agent-fanouts`. Finished jobs move after 24 hours to
`.runtime/agent-fanouts-archive`, capped at 500 folders. See
[Code index](code-index.md) and [Fan-out workers](fanout.md).

Phone-local notification switches, the approval dedupe ledger and pending
schedule reminders live on the iPhone. They require no Hook environment
setting, APNs key or relay. Optional direct APNs remains separate; see
[phone notifications](../apps/ios/design/notifications.md).

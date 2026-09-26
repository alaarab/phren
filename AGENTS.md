<!-- tokens: ~900 -->
# AGENTS.md

Open-source knowledge layer for AI agents. Published as `@phren/cli` on npm.

## Project Location

Source lives at `~phren`. Published to npm. Starter templates are bundled in the package.

## Monorepo Structure

pnpm workspace with turborepo. Shipped packages:

| Package | Path | npm | Description |
|---------|------|-----|-------------|
| `@phren/code` | `packages/code/` | Published | Optional code index, grammars and code skill |
| `@phren/cli` | `packages/cli/` | Published | CLI, MCP server, data layer |
| `@phren/agent` | `packages/agent/` | Published, version-locked to `@phren/cli` | phren's coding agent. Optional like `@phren/code`: `phren agent` lazy-loads it (`packages/cli/src/modules/agent-package.ts`) and spawns its `phren-agent` binary, which also works on its own. It pins the exact CLI version (its `workspace:*` dependency is rewritten by `pnpm pack` in `release.yml`, which publishes it right after the CLI); `validate-docs` fails if the two versions drift. Its suite runs under its own vitest config in the CI `agent-test` job (`pnpm exec turbo run test --filter=@phren/agent`), not the root `pnpm test`. |
| `@phren/vscode` | `packages/vscode/` | VS Code Marketplace | VS Code extension. Versions separately from the CLI (`packages/vscode/CHANGELOG.md`, shown on the Marketplace listing) and releases through the `Release VS Code extension` workflow. It is a thin client calling MCP tools by name, so it starts its server in the `full` tool profile, and a test in `packages/cli` fails if the CLI stops registering a tool it calls. |

Outside the pnpm workspace:

| App | Path | Description |
|-----|------|-------------|
| phren for iOS and Android | not in this repo | Closed source, in the private `alaarab/phren-apps` repo, which includes this repo as a submodule. The Hook routes, store format and conformance fixtures (`packages/cli/fixtures/conformance/`) the apps depend on live here; change them here, never by reaching into app code. |
| Herdr plugin | `integrations/herdr/` | Plugin for [Herdr](https://herdr.dev) (terminal workspace manager): keybinding → a pane running `phren shell --here`. `herdr-plugin.toml` manifest + POSIX-ish bash launchers, no build step. Installed by users with `herdr plugin install alaarab/phren/integrations/herdr`; developed with `herdr plugin link`. Not part of the pnpm workspace and not published to npm. |
| Omarchy plugin | `integrations/omarchy/` | Bar widget for [Omarchy](https://omarchy.org)'s Quickshell shell (`manifest.json` kind `bar-widget`, `Panel.qml`): projects and counts, recalls as they land, buttons into the shell / graph / web viewer; `install.sh` also registers `phren` and `phren graph` in the app launcher. Two bash helpers read the store's files directly. Installed with `bash integrations/omarchy/install.sh`; validated with `omarchy plugin validate`. No build step, not on npm. |

## Key Files

| File | Purpose |
|------|---------|
| `packages/cli/src/index.ts` | Entry point: top-level invocation routing + MCP server (71 tools registered; the `core` profile exposes 10, see `src/mcp/profile.ts`) |
| `packages/cli/src/tools/summaries.ts` | MCP tools `get_topic_summaries` / `set_topic_summary`: the agent reads a topic's bullets and stores its own paragraph, under the invented-identifier check; driven by the `/phren-summarize` skill |
| `packages/cli/src/content/summarize.ts` | The archive's shape: `## Now` blocks at the top of `reference/topics/*.md` (structural, or LLM prose with `--llm`), the `What phren knows` block in `summary.md` the hook injects once per session, and the split of oversized topic files into `<topic>.older.md`. Run by `phren maintain summarize` and by background maintenance. |
| `packages/cli/src/store-weight.ts` | Words per kind across the store and the median hook injection size; behind `phren status`'s weight line and doctor's `context-cost` check |
| `packages/cli/src/mcp/profile.ts` | MCP tool profiles: the gate between tool modules and the server, the `core` tool list, the `revise_finding` / `manage_task` / `session` / `phren_admin` composites that dispatch into the catalog with the target's own schema |
| `packages/cli/src/entrypoint.ts` | Top-level dispatcher: resolves `--help`/`--version`/`--health`/MCP/manage invocations and routes via the command registry |
| `packages/cli/src/cli-registry.ts` | Command catalog. Single source of truth for help generation and dispatch (Command type, REGISTRY, lookupCommand, DOC_TOPICS). |
| `packages/cli/src/cli-help.ts` | Help formatters over the registry: formatCheatSheet, formatTopic, formatCommand, formatFullHelp |
| `packages/cli/src/cli-handlers.ts` | Native handlers for `add`, `init`, `uninstall`, `status`, `verify`, `mcp-mode`, `hooks-mode`, plus argv parsing helpers |
| `packages/cli/src/shared.ts` | Shared infrastructure: findPhrenPath, getProjectDirs, runtimeFile, sessionMarker |
| `packages/cli/src/content/` | Content operations: finding CRUD, trust filtering, dedup, consolidation |
| `packages/cli/src/governance/` | Governance: policy/access/workflow config, review queue, audit log, locks |
| `packages/cli/src/shared/index.ts` | FTS5 indexer: buildIndex, queryRows, @import resolution, file classification |
| `packages/cli/src/sync/pull.ts` | Configurable MCP remote polling (off by default), coordinated per store; fast-forward updates refresh the index and existing managed context through `link/refresh.ts`. |
| `packages/cli/src/utils.ts` | Utilities: FTS5 sanitization, synonym expansion, keyword extraction |
| `packages/cli/src/init/init.ts` | `phren init`: configures MCP + hooks for all detected agents |
| `packages/cli/src/link/` | Reconciles an existing install's machine/profile wiring, hooks, and local context |
| `packages/cli/src/data/access.ts` | Data layer: task CRUD, machine/profile listing, finding management |
| `packages/cli/src/telemetry.ts` | Opt-in usage telemetry: tool call and CLI command tracking |
| `packages/cli/browser/graph/` | Shared 3D memory-viewer renderer (bundled for the web UI and the VS Code webview): scene, project navigator, contents/review pane, labels |
| `packages/cli/src/graph-core/` | Host-agnostic graph model shared by the browser viewer and the terminal graph view: payload types, palette, kind/health derivation, filters, ranking, search. Must not import node builtins or anything outside itself (it is bundled for the browser). |
| `packages/cli/src/shell/graph/` | The shell's Graph view: deterministic force layout, braille canvas, controller (data/camera/selection/keys), view renderer, watch mode (tails the lookup log), agents overlay |
| `packages/cli/src/agents/` | Discovering coding agents running on this machine (`PHREN_FEATURE_AGENTS`). Host-agnostic `AgentRecord` contract plus `providers/` (herdr, phren-agent spawner). Nothing host-specific may leak outside `providers/`. |
| `packages/code/src/` | Per-project SQLite code index: tree-sitter parsing, incremental transactions, persisted identifier references, queries over functions, types and variables (including what changed) and finding citations. `phren code index` resolves this machine's checkout. |
| `packages/cli/src/bridge/code-routes.ts` | Registered-store Code routes: tree, search, outlines and batched counts, a file's resolved references, definitions with findings, references, paged usage, what changed, per-file change counts and reindex; debounced refresh after recorded file changes. |
| `packages/cli/src/bridge/code-note.ts` | Validates a dossier line, saves a finding linked to that function, type or variable, then optionally hands off to the chosen session or dispatches a worker; delivery failure is separate from save success. |
| `packages/cli/src/bridge/files.ts` | Read-only `/v1/projects/files` browser for discovered checkouts: relative paths, no symlinks or `.git`, 2 MiB files and at most 500 directory entries. |
| `packages/cli/src/bridge/transcript-preview.ts` | Ephemeral live reply previews from Claude pane text and Codex/OpenCode deltas, capped at two updates per second and cleared by completed entries. |
| `packages/cli/src/bridge/terminal.ts` | `TerminalProvider`: what the Hook needs from a terminal multiplexer (snapshot in the Hook's pane shape, list panes, processes, read screen, send keys, prompt, create, start an agent, focus, rename/close, ping). Identity and status stay out of it except as optional hints. `terminalProvider()` returns a router that sends each call to its server's provider (`terminalKind`: `tmux` / `tmux-<socket>` are tmux unless Herdr has that session, everything else Herdr); tests swap in a fake with `setTerminalProvider`. |
| `packages/cli/src/bridge/terminal-herdr.ts` | The Herdr provider: one call on Herdr's socket per method, through `herdr.ts`'s exported `rpc` (the seam bridge tests fake). Herdr's `agent_session` / `agent_status` become pane hints. |
| `packages/cli/src/bridge/terminal-tmux.ts` | The tmux provider, used when no Herdr server answers: the owner's default server (`tmux`) and the Hook's hidden `tmux -L phren` (`tmux-phren`) for phone launches. `list-panes -a` + `ps` become the Hook's snapshot (agent from the foreground command line), `capture-pane`, `send-keys`, `load-buffer`/`paste-buffer`, `respawn-pane` under a login shell. Other owner sockets that answer in `$TMUX_TMPDIR/tmux-<uid>` and `/tmp/tmux-<uid>` are listed as `tmux-<name>`; `tmuxHealth` backs doctor and health. execFile with argument arrays only; `setTmuxDeps` is the test seam, `PHREN_TMUX=off` turns it off (the vitest config does). |
| `packages/cli/src/bridge/pane-status.ts` | Agent status for panes whose terminal does not report one (tmux): the last lifecycle event per pane and terminal instance, in memory and in the pane's binding file, plus `dialogStatus`: a working pane whose screen shows its harness's own dialog (`screenDialog`, read at most once per `PHREN_DIALOG_THROTTLE_MS`) is blocked until the dialog is gone. |
| `packages/cli/src/bridge/harness-status.ts` | Status from the harnesses' own records for tmux panes: OpenCode's per-PID `opencode-status-<pid>.json` (written by the OpenCode plugin) and Copilot's `session-state/<id>/events.jsonl` tail. |
| `packages/cli/src/bridge/grants.ts` | Standing conductor dispatch/hand-off grants, scope matching, locked atomic updates and stale-row revocation checks. |
| `packages/cli/src/bridge/hand-off.ts` | Delivers one prompt to an existing local or verified-peer session, with live target validation. |
| `packages/cli/src/bridge/schedules.ts` | Scheduled prompts: the `schedules.yaml` store format and its five timing forms evaluated in the assigned computer's local time, plus the Hook's `Scheduler` that records a run before launching through Herdr or a headless wrapper. Backs `phren schedule` and the `/v1/schedules` routes. The store format lives in `schedule-format.ts`, the launchers in `schedule-launch.ts` and the run watcher in `schedule-watch.ts`; `schedules.ts` re-exports them. |
| `packages/cli/src/bridge/git.ts` | Read-only Git data for the phone's Changes screen (`status`, `log`, `branches`, `pulls`, `tree` with optional ignored entries) plus stage/unstage/discard, all bound to the pane's repository, a spawned child's worktree or a listed worktree. |
| `packages/cli/src/bridge/git-worktrees.ts` | `/v1/git/worktrees`: the repository's other worktrees with ahead/behind, uncommitted count and the worker editing there, and the resolution of a phone's opaque worktree id against that listing. |
| `packages/cli/src/bridge/server-overview.ts` | `WS /v1/overview`: the phone's session overview pushed when its rows change, rebuilt from the shared Herdr snapshot (at most one 5 s tick old) or every 10 s, with a 20 s heartbeat. Shares `workspacesReader` with `GET /v1/workspaces`; the phone polls only while this socket is down. |
| `packages/cli/src/bridge/dispatch.ts` | Conductor placement: the `dispatch` MCP tool schema and `DispatchService`, which validates verified peers, picks a named or least-busy `anywhere` computer, launches over pinned SSH, sends one prompt, and stores durable receipts. |
| `packages/cli/src/bridge/dispatch-returns.ts` | The conductor's returns loop: the receiving Hook's `workerStates` (from the shared Herdr snapshot and the transcript readers) and the dispatching Hook's `DispatchReturns`, which polls each peer once per 15 s, records done / needs-you / blocked / gone in the receipts, serves `dispatch_returns`, and types a rate-limited notice into an idle dispatching agent. |
| `packages/cli/src/bridge/computers.ts` | Computer enrollment: creates or reuses the ed25519 dispatch key and prints or accepts the `restrict,pty` `authorized_keys` line. |
| `packages/cli/src/bridge/peers.ts` | The Hook's verified SSH peer directory (`hooks.yaml`, pinned host keys, at most 32 peers) and one bounded OpenSSH process per request through `phren-hook v1 pipe`. |
| `packages/cli/src/bridge/codex-threads.ts` | Codex 0.155 thread-history compatibility: materializes `thread_history_1.sqlite` into a rollout-shaped JSONL so existing transcript readers keep working, and flags a working pane whose history stopped advancing (`threadHealth`). |
| `packages/cli/src/bridge/speech.ts` | `POST /v1/speech` for the phone's talk mode: ElevenLabs streaming TTS with the key read from `~/.config/mina-trailer.json` and never returned; failures mapped to fixed coded errors. |
| `packages/cli/src/bridge/models.ts` | Harness model catalogues: Codex app-server, Claude Code's cached `/model` catalogue with client-version filtering and a built-in fallback, and `opencode models`, cached by `ModelCatalog`. |
| `.claude-plugin/` | Claude Code plugin manifest + marketplace entry. Points at `global/skills/`, `.mcp.json` and `hooks/hooks.json`; keep the version in step with `packages/cli/package.json`. |
| `scripts/graph-survey.ts` | Renders the Graph view against synthetic stores from 3 to 40 projects at several terminal sizes. Run it before and after any graph change; three defects were invisible on small fixtures. |
| `packages/cli/src/status.ts` | `phren status`: health, project, stats overview |
| `packages/cli/starter/global/skills/` | The `phren-*` slash commands `phren init` provisions into `~/.phren/global/skills` (and symlinks into `~/.claude/skills` under the managed preset). **This is the source `init` actually reads**; `setup.ts` copies from here. |
| `.claude/skills/docs/` | Maintainer-only `docs` skill for this repo (update every documentation surface after a change). Not shipped. |
| `packages/cli/starter/` | Bundled starter templates (4 project types, copied to ~/.phren on init) |
| `packages/cli/starter/templates/` | Project templates: python-project, monorepo, library, frontend |
| `docs/index.html` | GitHub Pages site |
| `global/AGENTS.md` | User-level instructions shipped with the package |

## Commands

```bash
cd ~phren
pnpm build         # compile TypeScript (all packages)
pnpm test          # run the vitest suite
pnpm lint          # lint all packages
```

## Current Version

`@phren/cli` 0.3.5 (see `packages/cli/package.json`).

## Reference Documentation

Developer docs live in `docs/` (also published to the GitHub Pages site):
- `api-reference.md` -- the two tool profiles, all MCP tools, parameters, and usage
- `architecture.md` -- system architecture and design patterns
- `architecture-team-stores.md` -- multi-store / team-store design
- `environment.md` -- environment variables, directory structure, finding quality rules
- `footprint.md` -- management presets (managed/assisted/manual) and every path phren writes
- `governance.md` -- policies, access control, retention, audit
- `feature-flags.md` -- optional features and their env flags
- `performance.md` -- indexing and search performance notes
- `shell.md` -- the interactive `phren` shell
- `code-index.md` -- local code index, what changed, queries, phone routes and finding citations
- `conductor.md` -- launch roles, placement, hand-off, standing grants and adapter boundaries
- `fanout.md` -- worker manifests, permission failures, notification and archive lifecycle
- `graph-viewer.md` -- the 3D memory viewer (web UI Graph tab + VS Code webview)
- `agent.md` -- the coding agent (`phren agent`): install, providers, MCP, permissions, headless mode

Note: `reference/topics/` is a *runtime* location inside a user's `.phren/<project>/`
(archived per-topic docs), not a directory in this repo.

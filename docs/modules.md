# Modules

Status: design and declaration seam. This change adds manifests, a read-only
configuration resolver and `phren modules list`. It does **not** filter existing
MCP tools, CLI commands, agent hooks, Hook routes, starters or phone screens.
`enable` and `disable` below are the planned interface, not implemented commands.

Phren must remain useful as memory alone. Tasks, the phone Hook, repository
Changes, scheduled prompts, conductor and a future code map are independently
enabled contributions. Disabling one removes its active surface and background
work while preserving its data for re-enablement. No module switch uninstalls
the user's agents, deletes their tasks or stops an agent they launched.

## Current seams and the boundaries they need

| Surface | Current behavior | Required change |
| --- | --- | --- |
| `packages/cli/src/index.ts` | Imports all 15 `tools/*` registrars and calls `gate.finish()` | Resolve modules before importing optional registrars |
| `packages/cli/src/mcp/profile.ts` | `core` exposes ten tools; the catalog keeps all tools, composites dispatch into it | Filter catalog membership by module first, then apply the MCP presentation profile |
| `packages/cli/src/cli-registry.ts` | One unconditional catalog drives dispatch and help | Filter commands, aliases and nested subcommands together |
| `packages/cli/src/init/config.ts`, `hooks.ts` | Install memory lifecycle callbacks and wrappers | Reconcile only enabled contributions, respecting management presets |
| `packages/cli/src/bridge/install.ts` | Installs phone callbacks, usage status line and the OpenCode transcript plugin | Split Hook lifecycle callbacks from Git change capture; reconcile by owner |
| `packages/cli/src/bridge/server.ts` | Static capability object and route branches; starts scheduler and Changes retention unconditionally | Build routes, resources and capabilities from one enabled snapshot |
| `packages/cli/src/init/setup.ts` | Copies global starter skills, template files and instruction mirrors | Provision only enabled owners; refresh and repair use the same filter |
| iOS | General navigation is mostly unconditional | Resolve store enablement and retain negotiated host capabilities |

The existing `tools/*` files are implementation groupings, not independently
installable Modules. [API reference](api-reference.md) describes the current
tool profiles; [architecture](architecture.md) describes the current lifecycle.
This design changes ownership without renaming those tools or their parameters.

## Manifest contract

[`ModuleManifest`](../packages/cli/src/modules/manifest.ts) is declarative data.
Loading it must never import a registrar, execute an npm entrypoint, start a
timer, modify agent settings or create files. Built-ins share the CLI package
version; external modules will version independently.

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Manifest format version, initially `1` |
| `name`, `version` | Stable module identifier and implementation version |
| `defaultEnabled` | New-store default, before store and profile overrides |
| `requires` | Module dependencies; never silently enable these during a read |
| `tools` | Exact MCP names and direct exposure membership (`core`, `full`); includes generated composites |
| `cliCommands` | Paths without the `phren` prefix, including aliases and separately owned nested commands |
| `agentHooks` | Agent adapters, lifecycle event names and handler identifiers; handlers are data, not evaluated shell strings |
| `hookRoutes` | Exact method (`GET`, `POST`, `WS`) and path; no blanket `/v1/*` grants |
| `capabilities` | Names the module can provide; availability and typed values are computed by its runtime adapter |
| `storeFiles` | Owned store-relative files or patterns; `<project>` includes `global` when applicable |
| `localFiles` | Unsynced host-local resources, with `<bridge>` denoting `bridgeRoot()` |
| `phoneScreens` | Compiled phone screen identifiers and required capability names; never downloaded UI code |
| `skills` | Owned starter skill names, provisioned only when enabled |

The six built-ins are enumerated in
[`modules/registry.ts`](../packages/cli/src/modules/registry.ts). Tool names,
CLI paths and HTTP/WS routes there refer to current implementations. New
capability names (`memory`, `tasks`, `hook`, `git`, `schedules`) are proposed
negotiation fields, not fields already emitted by this release.

Declarations are an ownership inventory, not a complete filesystem deletion
allowlist. Shared structural directories such as `global/skills` have individual
child owners: the conductor skill belongs to conductor. Existing core index,
audit, cache and sync files stay with memory. Before wiring provisioning, each
adapter must enumerate its exact generated files and managed settings entries;
no adapter can claim all of `.runtime` or another module's files. Runtime paths
under `.runtime` and `.sessions` remain local even though they are store-relative.

Later runtime adapters provide lazy registration functions and a disposer for
timers, streams and temporary resources. These functions live separately from
the serializable manifest. Manifest schema validation, duplicate tool/command/
route/capability ownership and dependency-cycle checks precede adapter loading.
An owner of a namespace, such as `bridge` or `maintain`, does not automatically
own its descendants; explicit subcommand ownership wins. Only known enabled
descendants appear in help or dispatch.

## Built-ins

| Module | Default for a new store | Current contributions |
| --- | --- | --- |
| `memory` | Required | Findings, notes, truths, review, summaries, search, fragment graph, memory session continuity, skills, governance, project/store configuration, memory lifecycle integration and store sync |
| `tasks` | On | Seven task handlers plus `manage_task`; `task`/`tasks`; `tasks.md`, task checkpoints and task UI |
| `hook` | Off | `bridge` service and phone transport, native agent chat, approvals, workspace control, transcript/subagent reading, files, web previews, usage and simulators |
| `git` | Off | `auto_extract_findings`, `maintain extract`/`extract-memories`, repository diffs and `/v1/git/*`, change capture and Changes UI |
| `schedules` | Off | `schedule`, project `schedules.yaml`, scheduler, run history and Schedules UI |
| `conductor` | Off | `dispatch` MCP and CLI, `bridge enroll-computer`, dispatch routes, receipts, peer configuration and the `conductor` skill |

All optional modules require memory; conductor also requires Hook. Git and
schedules can manage their local/store data without Hook. Their phone routes
and host services require both the owner and Hook. A disabled Hook does not
prevent editing schedule definitions; it does prevent running their scheduler.
Tasks have no Hook routes today: the phone reads and writes tasks through store
sync. No invented task MCP tools or REST routes are needed for this split.

Memory-store Git transport belongs to memory: `push_changes`, `background-sync`,
pull polling and the `phren-sync` skill keep working without the Git module.
The optional Git module owns operations on a project's source repository,
including mining its history. Move automatic extraction and Git context ranking
behind Git enablement; a memory-only search must not inspect the source checkout.
The existing memory fragment graph is not a code map. A future `code-map` module
defaults off and owns its own index, tools, workers and `codeMap` capability;
it is not a built-in in this seam and its config name is currently rejected.

Hook means the phone service. It does not mean all agent lifecycle callbacks.
Memory retains its managed `SessionStart` -> `phren hook-session-start`,
`UserPromptSubmit` -> `phren hook-prompt`, `Stop` -> `phren hook-stop`, and optional
Claude `PostToolUse` -> `phren hook-tool` callbacks, with the existing adapters
and wrappers for supported agents. Memory also retains user-authored custom
hooks under existing policy; those do not grant access to disabled modules.

The separate phone installer currently sends Codex and Claude `SessionStart`,
`UserPromptSubmit`, `Stop`, `PermissionRequest`, `PreToolUse` and `PostToolUse`
to `bridge-hook.mjs hook <agent>`, plus Claude `PreCompact`. Copilot gets
`SessionStart` and `UserPromptSubmit`. The manifest assigns the two tool-use
events to Git because `AgentHooks` uses them for before/after change snapshots.
The OpenCode transcript/approval plugin and Claude usage status line belong to
Hook. Task-related work currently embedded in memory session handlers must be
extracted into optional callbacks without installing a duplicate agent process.

## The memory-only guarantee

For the default MCP `core` presentation, memory alone exposes exactly:

```text
search_knowledge  get_memory_detail  get_project_summary  add_finding
revise_finding    session            phren_admin
```

Enabling tasks adds `get_tasks`, `add_task` and `manage_task`, preserving today's
ten-tool core surface for default installations. This deliberately defines a
seven-tool memory core rather than keeping inert task tools in memory. The
current `CORE_TOOLS` constant remains unchanged in this seam. The later gate
refactor derives the set from enabled manifests and preserves listing order.

`full` remains an explicit presentation choice: it exposes all tools of the
enabled modules, not every installed module. Memory's remaining handlers stay
in the catalog for `revise_finding`, `session`, note capture and `phren_admin`.
Neither the admin dispatcher nor a composite may reach an unregistered optional
handler. Config/admin tools also cannot toggle a disabled subsystem indirectly.
Calling a disabled name returns a structured unavailable/unknown-tool error.

An initialized memory-only store, with `tasks: false`, must have:

- Only memory-owned commands, skill mirrors, files and lifecycle callbacks.
  Management commands, including module management, remain available for repair.
- No task templates, task checkpoints, task indexing/reranking, task counts or
  task guidance in generated summaries, instructions, help or prompts.
- No phone Hook service, socket, SSH wiring, transcript plugin, phone callbacks,
  repository change snapshots, scheduler, dispatch receipts or conductor skill.
- No optional registrar imports, background workers, timers or model schema
  cost, even when a feature environment variable asks for one.

This is a fresh-install and active-surface guarantee. Disabling a module in an
existing store preserves its files, removes its generated integration entries,
and excludes its files from active indexing, summaries and maintenance. Generic
export/backup can preserve those bytes without reactivating their owner. A
memory-only store with the manual management preset also installs no automatic
lifecycle callbacks, as today. The guarantee does not require deleting user data
to make a directory appear empty.

## Discovery and enablement

Resolution order is deterministic:

1. Built-in manifests bundled with the installed CLI.
2. Explicit store modules in `.config/modules/<name>/module.json`.
3. Explicit, pinned npm package references, in a later version.

Names are unique; later sources cannot shadow built-ins or silently replace an
earlier module. Within a source, sort by name for stable diagnostics. Loading
the inventory never enables a discovered module. Store modules default off;
store sync does not grant permission to execute newly arrived code. A later
loader requires a local trust record tied to the module content digest. Npm
support uses locally installed pinned packages and a lock/integrity record,
never network fetching on startup or `modules list`. Discovery and third-party
execution are not implemented in this seam.

Enablement lives in synced `.config/modules.yaml`, distinct from host-local
install preferences and the existing `profiles/*.yaml` project membership:

```yaml
version: 1
enabled:
  tasks: true
  hook: false
  git: false
  schedules: false
  conductor: false
profiles:
  work:
    enabled:
      hook: true
      git: true
      schedules: true
      conductor: true
  personal:
    enabled:
      tasks: false
```

Resolution is built-in defaults, then store overrides, then the selected store
profile's overrides. A store profile (`work`, `personal`) is not the MCP
presentation profile (`core`, `full`). A profile may enable a module disabled
at store scope; store settings are defaults, not an access-control ceiling.
Existing store/project authorization continues to apply independently.

`enabled(store, profile?)` returns manifests in built-in order. Omitting the
profile applies only store settings; the CLI passes its resolved active profile.
Unknown profiles inherit store settings. Only a missing config uses defaults;
empty/malformed YAML, unsupported versions, non-boolean values, unknown names,
`memory: false` in any scope, or unsatisfied active dependencies are errors.
No read mutates or caches configuration. A version-only document uses defaults.

The implemented command is:

```sh
phren modules list
phren modules list --profile personal
```

It prints all six built-ins, version and configured status, and explicitly says
registration is unchanged. The normal CLI store context selects the store;
`PHREN_PATH` can select another store today. It rejects `enable`/`disable` and
extra arguments, and does not create `.config/modules.yaml`.

The planned mutation interface is:

```sh
phren modules list --store personal --profile work
phren modules enable git --store personal
phren modules disable tasks --store personal --profile work
```

Without `--store`, mutate the selected primary store. Without `--profile`,
mutate the store override; with it, mutate only that profile override. `list`
shows the effective active profile by default and later includes the origin
(default/store/profile), dependencies and configured-versus-active status.
Mutations validate the complete proposed config, preserve unrelated overrides,
take the store write lock and atomically replace the YAML. Enabling conductor
requires Hook already enabled; report the missing dependency rather than
silently changing another switch. Disabling Hook while conductor depends on it
is rejected with the dependent names. There is no implicit cascading disable.

## Runtime integration and hot swapping

Each process resolves one store/profile snapshot before activation. Registrars
consume that snapshot, not their own interpretations of the config. In a
multi-store server the exposed tool set is the union needed by its accessible
stores, but each handler rechecks its target store and profile. A task tool
exposed for one store cannot operate on a second store with tasks disabled.

| Consumer | Consultation point and invariant |
| --- | --- |
| MCP | Resolve before lazy imports in `index.ts`; split mixed registrars such as `tools/finding.ts`/`tools/extract.ts` by ownership as needed. Construct the catalog from enabled handlers, then build composites and filter presentation. |
| CLI | Resolve before both help and dispatch in `entrypoint.ts`/`cli-registry.ts`; gate internal commands, aliases and namespace subcommands as well as visible top-level commands. Bootstrap/help/repair must remain reachable with invalid config. |
| Memory hooks | `init/config.ts`, `hooks.ts`, `link/refresh.ts` and repair use the same owner-aware desired state; callback execution resolves the session's store/profile again. |
| Phone installer | `bridge/install.ts` plans and reconciles Hook and Git contributions independently, preserves unrelated hooks, and records owner IDs for safe removal. Shared machine wiring is the union required by active local contexts; each callback is still scoped. |
| Hook | `bridge/server.ts` builds HTTP and WS tables from enabled owners, then starts only their resources. SSH PTY, shell and web-preview dispatch in `bridge/transport.ts`, and the separate local `/hook` callback server in `bridge/agent-hooks.ts`, enforce the same set. |
| Store/init | `init/setup.ts`, starter copying, update, repair, skill mirrors, indexers and summary generators all consult ownership. Disabling tasks cannot be undone by the next session's self-heal. |

Module enablement is the outer boundary. Within an enabled module, preserve the
existing [feature flag](feature-flags.md) precedence: environment, explicit
install preference, management preset, built-in behavior default. A preset,
feature flag or `full` MCP profile cannot activate a disabled module.

The eventual change protocol is validate, prepare, drain, publish. Validate the
new snapshot and prepare new adapters without exposing them. Stop accepting new
operations for removed owners; allow bounded in-flight operations to finish,
close owned streams, then dispose timers/resources. Atomically publish routes,
capabilities and generation together. Schedule disable stops new launches but
does not kill running workers; dispatch disable preserves receipts and never
retries an uncertain delivery. Failed preparation retains the previous working
snapshot and reports configured-versus-active disagreement.

Short-lived CLI and hook processes see config on their next invocation. Initially
MCP servers may require a restart for a changed tool list; later use the SDK's
supported list-change notification, with reconnect for clients that cache it.
This transport rollout is not a promise that editing the YAML hot swaps today's
process. Config pulled from sync follows the same reconcile path; invalid new
config keeps an already running process's last valid snapshot and yields a
health diagnostic, while a fresh activation refuses the invalid config.

## Hook capabilities and phone navigation

Keep the existing protocol-1 flat `capabilities` dictionary for compatibility,
and add `modules` (enabled module versions), selected store/profile identity
and a configuration generation to `/v1/health`. `/v1/workspaces`'s `phren` block
and WS status frames carry the same snapshot. Capability values retain their
types: `terminal`/`shell` are `"ssh-pty"`, `webPreview` is `"ssh-exec"`,
`approvalPush` is `"direct-apns"`, and `providers` is a list. Do not coerce these
to booleans or claim every declaration is operational.

| Owner | Capabilities and conditions | Phone surface |
| --- | --- | --- |
| memory | New `memory`; also available from synced store config without Hook | Projects, findings, notes, review, search and memory graph |
| tasks | New `tasks`, from the selected store/profile | Tasks tab, project task section and task actions |
| hook | New `hook`; existing `transcript`, `progress`, `images`, `prompt`, `stop`, `terminal`, `shell`, `herdr`, `webServers`, `webPreview`, `activity`, `approvals`, `accountUsage`, `providers`, `files`, `repositoryFiles`, `subagents`, `approvalPush`; `simulators` only where supported | Agents, chat, terminal, files, previews and supported host extras |
| git | New `git`, existing `diff`, when Git and Hook routes are active | Changes, History, Branches, PRs, Working tree and transcript diff actions |
| schedules | New `schedules`; host execution additionally needs Hook | Project and all-project Schedules; run/history actions require the selected host's capability |
| conductor | Existing `dispatch`, only with active conductor and Hook | Future conductor/worker UI; no dedicated screen exists yet |

`questions` is currently false; per-session `asyncQuestions` is computed for
Codex when its provider is available. Keep these runtime probes. Similarly,
the presence of a module does not prove that Herdr, an executable provider, a
simulator or push delivery is ready. Absent or false capability means the phone
hides the corresponding action and stops its polling; the server must also
reject direct requests. Unknown capabilities are ignored.

The requested `PhrenConnection.fetch` inspection reveals an important gap:
it reads `/v1/workspaces`, validates `phren.product` and `phren.protocol`, then
decodes `LiveWorkspaces`. That model currently drops the `phren` capability map.
`computerName` separately calls `/v1/health`. `WebPreviewTunnel` checks the
`webPreview` capability, and `AgentInteractions` checks question capabilities,
but those checks do not govern overall navigation.

Today `MainTabView` in `PhrenApp.swift` always creates Projects, Agents, Tasks,
Search and Settings. Readiness chooses onboarding/content. `ProjectsView` and
`AgentsView` add Schedules links without a module check; `AgentChatView` adds
Changes when it has a target; `AgentChangesView` renders all Changes sections.

The phone must retain typed capabilities in `LiveWorkspaces` and its session
model, and resolve synced `.config/modules.yaml` in PhrenKit using the same
fixtures as TypeScript. Memory and task navigation uses the selected store's
config even if no host is connected. Live operations use the selected host's
negotiated capabilities, intersected with store enablement where applicable;
never use one computer's capabilities for another. A host without a store
context advertises only its host services, never another store's task access.

On a capability change, cancel hidden screens' polls and streams, remove their
navigation links and move an invalid tab/selection to Projects (or Settings
during onboarding). Deep links and push actions recheck availability too.
Settings and connection setup remain reachable. An offline host retains its
last-known presentation with disconnected status but permits no unconfirmed
live operation; a reachable host omitting a capability hides that feature.
For an old store with no module config, apply migration defaults. For an old
Hook with no `modules` field, use an explicit, versioned compatibility adapter
for capabilities it actually reported; do not infer every optional module from
protocol `1`. Deploy phone compatibility before removing server capabilities.

## Migration

Do not apply new-store defaults to existing live registrations. Before the
first release that gates consumers, migrate existing installs once under a
store lock and save explicit overrides:

1. Memory remains required and tasks enabled. Preserve task files, task mode
   and project policies; an existing inactive task policy stays inactive.
2. Existing memory CLI/MCP installs get Git enabled to preserve today's
   extraction surface. Do not turn on a feature flag that was off.
3. A machine with an installed Hook maps its currently bundled phone, Git,
   schedules and dispatch surfaces to enabled Hook, Git, schedules and
   conductor modules. Existing schedules or the provisioned conductor skill
   are migration evidence, not reasons to silently install a phone service on
   another machine. Migrate their owning modules and required Hook declaration
   while retaining local service-install state.
4. When computers differ, write appropriate synced profile overrides. Module
   configuration expresses intent; local installation and credentials determine
   active availability. A synced `hook: true` never starts an uninstalled host
   service or enrolls a key. It reports pending local setup.
5. Record every existing module's effective value explicitly so future default
   changes cannot alter the migrated store. If this seam's config already
   exists, honor its overrides as user intent. Conflicting or incomplete
   installation evidence gets a migration diagnostic, not a silent disable.

Migration is idempotent, preserves unknown fields owned by future versions
when writing through their supported writer, never overwrites malformed config,
and stages a backup before replacement. The initial built-in resolver is strict
and cannot interpret a future-version config. Re-enabling uses the retained
files; generated hooks and skill mirrors are reconciled by ownership. Disabling
the module never removes its data. Explicit data removal, if later offered, is
a separate operation.

This release performs no migration, writes no enablement config and changes no
defaults of active runtime behavior. Its list output describes the resolver's
configured intent, which may differ from today's unconditional registration.

## Ordered independent work packages

Each package should land with its own fixtures and contract tests. Keep runtime
gating behind the rollout boundary until migration and phone compatibility have
landed. None requires implementing the future code map or an npm loader.

| Order | Package and files | Acceptance tests |
| --- | --- | --- |
| 1 | Declaration seam, delivered here: `modules/manifest.ts`, `modules/registry.ts`, `modules/registry.test.ts`, `cli-registry.ts`, this document and root changelog | Inventory matches current MCP registrations, commands, routes and skills; missing/default/store/profile/invalid/dependency configs; read-only list dispatch; memory declarations through the existing gate |
| 2 | Config writer and migration: `modules/config.ts` (new), `init/setup.ts`, `init/preferences.ts`, `profile-store.ts`, `cli-registry.ts`, `cli/namespaces-store.ts` | Atomic concurrent updates, idempotent migration, new and legacy stores, differing host profiles, no service install from synced config, dependency errors, preservation of disabled data |
| 3 | MCP catalog ownership: `index.ts`, `mcp/profile.ts`, `tools/tasks.ts`, `tools/session.ts`, `tools/finding.ts`, `tools/extract.ts`, `tools/dispatch.ts` | Exactly seven memory core tools; ten with tasks; `full` excludes disabled modules; admin/composite bypass attempts fail; no optional imports; target-store enforcement; VS Code full-profile contract |
| 4 | CLI and active views: `entrypoint.ts`, `cli-registry.ts`, `cli-help.ts`, `cli/namespaces-tasks.ts`, `cli/govern.ts`, `shell/`, `ui/memory-ui.ts`, `packages/cli/browser/` | Help and execution agree; disabled aliases, nested and internal commands cannot bypass; repair works on invalid config; task panes and counts disappear; read-only list remains cheap |
| 5 | Provisioning, hooks and memory cross-cutting behavior: `init/setup.ts`, `init/config.ts`, `hooks.ts`, `link/refresh.ts`, `bridge/install.ts`, `cli/session-start.ts`, `cli/session-stop.ts`, `cli/session-tool-hook.ts`, `shared/index.ts`, `shared/retrieval.ts`, `content/summarize.ts`, `starter/` | Fresh memory-only filesystem and agent-setting snapshots; repair/update never reintroduce optional files; preserved third-party hooks; no task search/index/summary/checkpoints; no source-repo extraction without Git; all shipped skills owned |
| 6 | Hook route/resource adapters: `bridge/server.ts`, `bridge/transport.ts`, `bridge/agent-hooks.ts`, `bridge/changes.ts`, `bridge/schedules.ts`, `bridge/dispatch.ts`, `bridge/install.ts` | HTTP/WS/SSH and callback routes agree with capabilities; no scheduler/retention/dispatch startup when disabled; profile isolation; drain/reload and failed-prepare rollback; no accidental worker termination or receipt retry |
| 7 | Phone negotiation and navigation: `PhrenLive/.../PhrenConnection.swift`, `PhrenKit/.../Sessions/LiveSessions.swift`, `PhrenKit/.../Sessions/SessionDiscovery.swift`, `Phren/AppModel.swift`, `Phren/PhrenApp.swift`, `Features/Projects/ProjectsView.swift`, `Features/Agents/{AgentsView,AgentChatView,AgentChangesView}.swift`, `Features/Schedules/SchedulesView.swift` (all under `apps/ios`) | Shared module YAML fixtures; health/workspace capability decoding; memory-only with no host; different host capabilities; legacy compatibility; hidden task/schedule/Changes entrypoints, deep links and polling; loss of selected capability |
| 8 | Rollout and lifecycle: `modules/` adapters, `sync/pull.ts`, `link/refresh.ts`, `index.ts`, `bridge/server.ts`, `docs/{api-reference,architecture,feature-flags,footprint}.md` | Sync-triggered reconciliation, invalid config retention, generation consistency, tool-list reconnect behavior, teardown resource leaks, migration upgrade/downgrade coverage; document active guarantees |
| 9 | Store directory loader, then npm loader: new `modules/discovery.ts`, module schema fixtures, package lock/trust handling and docs | Deterministic order, duplicate ownership, path containment, dependency cycles, changed-digest trust invalidation, missing/incompatible package, zero network or code execution during listing |

Packages 3 through 7 consume package 2's common snapshot contract and can be
reviewed separately. Package 8 enables the end-to-end guarantee only when their
acceptance checks and migration are complete. Any shell graph change must also
run `scripts/graph-survey.ts` before and after. iOS checks remain manual; do not
restore automatic iOS CI as part of this work.

Concrete suite targets, relative to `packages/cli/src` unless stated otherwise:

- Package 2: new `modules/config.test.ts` and `modules/migration.test.ts`, plus
  `init.test.ts` and `profile-store.test.ts`.
- Package 3: `mcp/profile.test.ts`, `__tests__/mcp-session-tools.test.ts`,
  `__tests__/session-checkpoints.test.ts` and the VS Code tool contract suite.
- Package 4: `cli-registry.test.ts`, `cli-help.test.ts`, `entrypoint.test.ts`,
  `memory-ui.test.ts` and new shell visibility fixtures.
- Package 5: `hooks.test.ts`, `cli-hooks-session.test.ts`,
  `init/preset-integration.test.ts`, `init/init-uninstall.test.ts`,
  `__tests__/init-setup-onboarding.test.ts` and new module footprint snapshots.
- Package 6: `bridge/bridge.test.ts`, `bridge/server-policy.test.ts`,
  `bridge/schedules.test.ts`, `bridge/git.test.ts` and new route/teardown fixtures.
- Package 7: PhrenKit `LiveSessionsTests.swift` and new `ModulesConfigTests.swift`,
  PhrenLive `PhrenConnectionTests.swift`, and app UI `MemoryConnectionTests.swift`,
  `ChangesTabTests.swift`, `SchedulesListTests.swift` and `LiveSessionsTests.swift`.
- Packages 8 and 9: new `modules/reload.test.ts` and `modules/discovery.test.ts`,
  including migration and trust fixtures that never launch real host services.

The declaration seam has Vitest coverage ready for the orchestrator. In this
worktree Vitest, Xcode and Swift execution are unavailable; the permitted local
compiler check is `pnpm exec tsc --noEmit -p packages/cli` (or the installed
`node_modules/.bin/tsc` directly if pnpm cannot bootstrap). Before rollout the
orchestrator must run the affected CLI suites and local PhrenKit, PhrenLive and
simulator tests from an environment that supports them.

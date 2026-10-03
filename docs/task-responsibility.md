# Task responsibility and prerequisites

A task has two independent choices: its section (`Queue`, `Active`, `Done`) and who must act (`human`, `agent`). Reassigning a task does not change its section. Moving a task preserves its stable ID, creation date, context, issue link and history. A task without responsibility metadata retains the compatible `agent` default; reading it does not write or relabel it.

The synced store format retains the existing `bid:` comment and adds one indented continuation:

```markdown
- [ ] Prepare release <!-- bid:aaaaaaaa created:2026-10-03T00:00:00Z -->
  Task: {"version":1,"responsibility":"agent","dependencies":[{"storeId":"bbbbbbbb","project":"accounts","stableId":"cccccccc"}],"history":[{"at":"2026-10-03T00:00:00Z","change":"dependencies updated"}]}
  Context: Owner requested release preparation.
```

Dependencies use the immutable primary ID in each target store’s synced `stores.yaml`, project slugs and stable task IDs. Machine-local attachment IDs and implicit path-derived IDs are never persisted as task references. An unregistered store has no task identity until an owner runs `phren store identity --create` once and distributes that registry through the existing store sync workflow. Positional IDs (`A1`, `Q2`), titles, host names and filesystem paths are not dependency identities. Cross-project and attached-store prerequisites use the same shape. Missing, unavailable or ambiguous targets are rejected when adding links. Self-links, duplicates and cycles are rejected. Clearing the list uses `dependencies: []`.

Readiness is derived on each read, independent of section:

| Value | Meaning |
| --- | --- |
| `ready` | An agent task whose prerequisites are complete |
| `waiting-on-human` | The task belongs to a human, or an unfinished direct prerequisite belongs to a human |
| `waiting-on-task` | An unfinished agent prerequisite, unavailable prerequisite, invalid graph or unsupported metadata |

Each prerequisite includes its current `title`, `responsibility`, `completed` and `missing` fields. Completion in `Done` remains satisfied after archival. Reopening a prerequisite makes dependants wait again. Unknown task metadata is retained by ordinary edits and blocks automatic selection. Claims and `work_next` refuse human or waiting tasks; explicit section moves and completion remain available. Responsibility changes to human release any current claim and record that release in history. This adds no dispatch, release, account or filesystem permission.

MCP `get_tasks` accepts independent `responsibility` and `readiness` filters, returns separate Human/Agent-ready/Agent-waiting counts, and returns `responsibility`, `dependencies`, `history`, `readiness`, `prerequisites` and `identity` alongside existing fields. `identity` is `{storeId, project, stableId}` or null for missing/ambiguous registered store identities or legacy tasks without a stable ID. Use `manage_task` action `update` (or full-profile `update_task`) with `updates.responsibility` and `updates.dependencies`. Existing claim, next, update and completion receipts remain unchanged.

```sh
phren task update core bid:aaaaaaaa --responsibility=human
phren task update core bid:aaaaaaaa --dependencies='[{"storeId":"bbbbbbbb","project":"accounts","stableId":"cccccccc"}]'
```

The TUI offers `:lane human|agent|all` as an independent lane filter and displays responsibility, readiness and prerequisite titles. `:responsibility <id> human|agent` reassigns, `:depends <id> <JSON array>` replaces prerequisites; ordinary section actions still work. The web task list has an independent Human/Agent filter, responsibility and section controls, and a prerequisite picker using stable identities. Unavailable prerequisites are retained when that picker changes available links.

## Hook and phone contract

Capability `taskDependencies` is advertised only when the tasks module is enabled. Existing authenticated Hook transport and registered store access apply.

- `GET /v1/tasks/stores` returns `{ok:true,version:1,stores:[{id,name,role,primary,available,identityReady,ambiguous,metadataWritable,projects,repositoryIdentity?}]}`. `id` is the canonical eight-hex store ID or null; `projects` is the subscribed project-slug list. `repositoryIdentity`, when available, is the existing credential-stripped GitHub `{repository,branch}` identity. Only available, identity-ready, unambiguous stores may be selected. Native clients map the verified repository identity or the pinned computer’s exact primary store; they never hash or guess an ID. Readonly stores may supply prerequisites. No filesystem paths are returned.
- `GET /v1/tasks?storeId=<immutable-id>&project=<slug>` also accepts optional `responsibility`/`readiness` query filters and returns `{ok, version:1, storeId, project, metadataWritable, counts, items:{Active:[],Queue:[],Done:[]}}`. Entries have the same enriched shape as MCP.
- `POST /v1/tasks/update` accepts `{storeId, project, stableId, updates:{responsibility?, dependencies?, section?}}`. Section uses `Active`, `Queue` or `Done`. The response is the refreshed project task document. The existing contributor/admin `update_task` policy applies; readonly stores refuse updates. No client path can select a store.

## Deliberate compatible activation

Task metadata creation is disabled by default. After every CLI, MCP process, Hook, sync writer and app that can write this store is upgraded, an owner with the existing `manage_config` permission runs `phren task format enable --all-writers-compatible`. This records a versioned acknowledgement tied to the canonical store identity in `.config/task-format.json`; it does not rewrite or relabel any task. `phren task format` reads the status. The shared data layer rejects responsibility/dependency edits until activation, so CLI, TUI, MCP, Hook and web writers use the same gate. Existing task metadata is read and preserved even before activation, and autonomous selection still honors its responsibility and dependencies.

This acknowledgement cannot prevent an older binary from ignoring the activation file. Coordinated compatible-writer adoption is a real prerequisite, including existing long-lived MCP/sync processes. A serving Hook’s capability or a new app version alone is insufficient. No live activation or runtime upgrade has been performed in this source lane. Hook task responses expose `metadataWritable` using activation and existing access rights; a native client must retain drafts and explain unavailable edits when false. Per-project GET rights are authoritative for project-scoped access.

Phones should preserve unknown metadata when writing older tasks, use stable identities for links, show prerequisite titles, and keep responsibility controls separate from section controls. Integrator owns native iOS implementation; the Android lead owns Android. This core change does not modify either app repository or installed Hooks.

Development evidence: the CLI and agent build passed before the latest identity/directory/activation corrections; those corrections have static syntax/diff checks pending a fresh capacity-gated build. The regressions in `packages/cli/src/data/task-contract.test.ts` are prepared for the consolidated RC and have not been executed. Runtime validation, cross-machine sync and native app adoption remain release-candidate gates.

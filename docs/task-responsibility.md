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

The TUI offers `:lane human|agent|all` as an independent lane filter and displays responsibility, readiness and prerequisite titles. CLI, TUI and web prerequisite rows display responsibility and the full canonical store/project/task identity; missing targets show Unknown responsibility. The TUI wraps long identities instead of truncating them. `:responsibility <id> human|agent` reassigns, `:depends <id> <JSON array>` replaces prerequisites; ordinary section actions still work. The web task list has an independent Human/Agent filter, responsibility and section controls, and a prerequisite picker using stable identities. Unavailable prerequisites are retained when that picker changes available links. The picker explains that removing those links requires the CLI or API and that a replacement retaining an unavailable target may be rejected. Failed or uncertain updates retain the visible selection and error. Web creation is labeled Add Agent task and explains that one-step Human creation is unavailable.

## Hook and phone contract

Capabilities `taskDependencies`, `taskWriterSafety` and `taskAtomicCreate` are advertised only when the tasks module is enabled. Existing authenticated Hook transport and registered store access apply.

- `GET /v1/tasks/stores` returns `{ok:true,version:1,stores:[{id,name,role,primary,available,identityReady,ambiguous,metadataWritable,writerSafety,projects,repositoryIdentity?}]}`. `id` is the canonical eight-hex store ID or null; `projects` is the subscribed project-slug list. `repositoryIdentity`, when available, is the existing credential-stripped GitHub `{repository,branch}` identity. Only available, identity-ready, unambiguous stores may be selected. Native clients map the verified repository identity or the pinned computer’s exact primary store; they never hash or guess an ID. Readonly stores may supply prerequisites. No filesystem paths are returned.
- `GET /v1/tasks?storeId=<immutable-id>&project=<slug>` also accepts optional `responsibility`/`readiness` query filters and returns `{ok, version:1, storeId, project, metadataWritable, writerSafety, counts, items:{Active:[],Queue:[],Done:[]}}`. Entries have the same enriched shape as MCP.
- `POST /v1/tasks/update` accepts `{storeId, project, stableId, updates:{responsibility?, dependencies?, section?}}`. Section uses `Active`, `Queue` or `Done`. The response is the refreshed project task document. The existing contributor/admin `update_task` policy applies; readonly stores refuse updates. No client path can select a store.

`writerSafety` reports `{version:1,metadataVersion:1,activation:"disabled"|"owner-acknowledged",requiresCoordinatedAdoption:true,legacyWritersFenced:false,acknowledgedAt?}`. Unavailable stores report null. It describes activation, never proof of writer adoption.

Directory `metadataWritable` checks store-level update rights, canonical identity, role and activation; the project GET applies the authoritative project override. Unavailable rows return `id:null`, `projects:[]`, `metadataWritable:false`, `writerSafety:null`. These are mutation permissions under existing policy, not a new read-ACL system. Dependency targets are resolved against this same attached-store directory, including subscribed projects and readonly prerequisites. Duplicate immutable IDs, unknown IDs and unavailable stores cannot be selected by an update. Clients cannot supply arbitrary store paths.

## Deliberate compatible activation

Task metadata creation is disabled by default. After every CLI, MCP process, Hook, sync writer and app that can write this store is upgraded, an owner with the existing `manage_config` permission runs `phren task format enable --all-writers-compatible`. This records a versioned acknowledgement tied to the canonical store identity in `.config/task-format.json`; it does not rewrite or relabel any task. `phren task format` reads the status. The shared data layer rejects responsibility/dependency edits until activation, so CLI, TUI, MCP, Hook and web writers use the same gate. Existing task metadata is read and preserved even before activation, and autonomous selection still honors its responsibility and dependencies.

This acknowledgement cannot prevent an older binary from ignoring the activation file. Coordinated compatible-writer adoption is a real prerequisite, including existing long-lived MCP/sync processes. A serving Hook’s capability or a new app version alone is insufficient. No live activation or runtime upgrade has been performed in this source lane. Hook task responses expose `metadataWritable` using activation and existing access rights; a native client must retain drafts and explain unavailable edits when false. Per-project GET rights are authoritative for project-scoped access.

The parser on public main `87fc768a` stops reading continuations at an unknown `Task:` line. Its whole-file renderer then omits that metadata and any subsequent context, claim or issue link. Moving `Task:` to the end would still lose ownership and dependencies. A compatible Hook cannot intercept an older MCP, CLI, app or sync writer with direct access to the files or repository. This source supplies **no enforceable legacy-writer fence**, including after acknowledgement. A marker, capability, advisory lock or new merge driver cannot make an old binary honor a rule it does not implement.

Release is blocked until the integrator records compatible adoption for every writer that can reach each participating store: CLI and long-lived MCP/Hook processes, sync/merge writers, native whole-file editors, and returning offline copies or pending edits. Merely upgrading an executable on disk does not upgrade a running process. Existing work and source pins must be preserved; replacement happens at a coordinated safe boundary, without arbitrary busy-process restarts. If an old writer cannot yet adopt or be excluded from writes under existing owner-authorized controls, leave activation disabled. This is an external adoption prerequisite, not completed source work. No writer inventory, runtime cutover or activation has been performed by this source change.


Phone preflight requires `taskDependencies` and `taskWriterSafety`, the matched store identity, supported acknowledged writerSafety, and current project `metadataWritable:true`. Missing status leaves the draft intact. This acknowledges the separately completed adoption prerequisite; it does not prove adoption.

The combined implementation additionally exposes authenticated `POST /v1/tasks/create` under the tasks module, advertised by `taskAtomicCreate`. It accepts exactly `{storeId,project,stableId,text,responsibility}` and returns the refreshed project document. It checks both add/update rights and activation, then holds graph and document locks to create the stable ID and responsibility in one write. The caller retains the same identity after an uncertain result: matching content is returned without another write; conflicting or archived identities are refused. Raw control characters and embedded BID comments are rejected before title normalization. There is no Agent-then-reassign or whole-file Human fallback. This endpoint is separate from the historical `/v1/tasks/save` proposal, which is not registered. No save-and-launch guarantee is supplied. Legacy Agent capture retains its existing path. Existing task responsibility and dependency edits use only the strict update contract above; it accepts no text, context, revision, current-role or UUID fields. Dependencies omitted means keep, `[]` clears them, and an array replaces the full list (at most 100). Invalid or unavailable references, including retained references in a replacement list, reject the update and leave the draft visible. A fresh GET followed by launch still has a concurrent-change window and is not an atomic task-launch operation.

Phones should preserve unknown metadata when writing older tasks, use stable identities for links, show prerequisite titles, and keep responsibility controls separate from section controls. Integrator owns native iOS implementation; the Android lead owns Android. This core change does not modify either app repository or installed Hooks.

Development CI builds and lints this source. Prepared regression tests, cross-machine sync and native runtime acceptance remain deferred to the consolidated release candidate.

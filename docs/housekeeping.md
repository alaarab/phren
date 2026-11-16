# Housekeeping

Phren Hook keeps an eye on each computer's chores: disk, load, caches, leftover worktrees, idle panes, simulators and docker. It writes a report, shows the items that need you in the owner inbox, and, for a short list of proven-safe caches only, cleans up by itself. Everything else waits for the owner.

This page holds the safety rules and the `GET /v1/housekeeping` contract that the phone and desktop build against. The reasoning behind the design is in the housekeeping audit in the Phren store (`phren/reference/housekeeping-audit-2026-11.md`).

## What ships when

| Slice | What | State |
|---|---|---|
| 1 | Safety rules (`bridge/housekeeping/safety.ts`) | built |
| 2 | Report model, store, `GET /v1/housekeeping`, approve/dismiss/restore, overview badge, `phren housekeeping`, owner-inbox entries | built; warnings from machine health; approve runs `remove-worktree` and `delete-path` |
| 3 | Safe cache auto-clean (the disk-janitor's rules, daily and below 20 GB free) | planned |
| 4 | Worktree and `/tmp` audit (suggest only) | planned |
| 5 | Idle panes, orphan jobs, simulators, docker | planned |
| 6 | Sustained load and memory watch | planned |
| 7 | `housekeeping` MCP tool for the conductor (read, approve), phone screen, doctor check | planned |

New checks only add items, with new `kind` values and wording. Clients must show an item with an unknown `kind` generically, never drop the report.

## Safety rules

These are enforced in one module, `packages/cli/src/bridge/housekeeping/safety.ts`. Every housekeeping check and action goes through it, and its tests replay the 2026-11-08 incident, when a cleanup worker deleted worktrees with unpushed commits and ran `git reset --hard` across about 24 repositories.

1. **Never delete work.** A worktree or repository is kept when it has uncommitted tracked changes, untracked files that aren't ignored, commits on no remote branch (HEAD for a worktree; HEAD and every local branch for a repository), any stash, a rebase, merge, cherry-pick, revert or bisect in progress, a dirty or unpushed submodule, a live process or a pane whose folder is inside it, or a lock. A repository with linked worktrees is kept too. If any of these can't be inspected, it is kept.
2. **Never discard with git.** Housekeeping runs git only through `housekeepingGit`. It allows read-only commands plus `git worktree remove` (never `--force`) and `git worktree prune`. It refuses `reset`, `checkout`, `restore`, `switch`, `clean`, `push`, `branch`, stash changes, `update-ref`, `gc`, any `--force` and any global option. If git refuses a removal, the item stays a suggestion.
3. **Suggest by default.** Only an entry inside an allow-listed cache root (`~/phren-ci-builds` older than 7 days, npm `_cacache` 30 d, `XCTestDevices` 2 d, `DerivedData` 14 d, `iOS DeviceSupport` 90 d, the SwiftPM cache 30 d) that has no process or pane in it can be removed without the owner. Nothing under a protected root is ever touched: `~/Library/Developer/CoreDevice` (DeviceFS is a live view of booted simulators), docker volumes, `~/.phren`, `~/Projects`, `~/Sites` and `~/.ssh`. Symlinks are never followed. Beyond the caches, the owner (never the Hook by itself) may approve deleting a scratch folder they own that has been untouched for a day and is not a checkout, or a checkout's top-level `node_modules` while nothing runs in that checkout. Each removal decides again, against fresh state, just before it acts.

A report's items are clamped the same way: only a cache may be cleaned without the owner, so any other item proposed as automatic becomes a suggestion.

## `GET /v1/housekeeping`

The view of the newest report for this computer, shaped for the phone. Capability: `capabilities.housekeeping: 1` in `/v1/health`. Without it, or on a 404, clients hide housekeeping. The answer covers this computer only; clients ask each computer, as they do for `/v1/resources`. (`?peers=1` adds `peers` for `phren housekeeping`.) If no pass has run yet, the request runs one first, so the answer always has the full shape.

The zod schemas in `packages/cli/src/bridge/housekeeping/report.ts` (`viewSchema`, `approveResultSchema`, `badgeSchema`) are the contract. `packages/cli/fixtures/conformance/housekeeping-report.json` (every area) and `housekeeping-approve.json` are tested against them, and the apps decode those same files. New fields may be added; changing or removing one bumps `schema`.

```ts
interface HousekeepingView {
  computer: { id: string; name: string; aliases: string[] };   // which Hook answered
  schema: 1;
  revision: string;          // opaque; changes whenever any visible item, cleaned entry or dismissal changes
  generatedAt: string;       // ISO
  nextCheckAt?: string;      // ISO, the next scheduled pass
  health: { load1: number; cores: number; memoryUsedBytes: number; memoryTotalBytes: number;
            memoryPressure: "normal" | "warn" | "critical"; diskFreeBytes: number; diskTotalBytes: number; tmpBytes?: number };
  warnings: Warning[];       // severity (high, warn, info), then size, then title
  suggestions: Suggestion[];
  kept: Kept[];              // things Phren deliberately won't touch; show collapsed
  cleaned: Cleaned[];        // the last 14 days
  dismissed?: Dismissed[];   // only with ?dismissed=1
  errors?: Array<{ check: string; message: string }>;   // checks that failed this pass: their items are unknown, not absent
}
type Area = "memory" | "disk" | "sessions" | "worktrees" | "simulators" | "docker";   // tmp counts under disk, load under memory
interface PaneLink { target: { server: string; workspace?: string; tab?: string; pane: string }; label?: string }
interface Warning { id: string; area: Area; severity: "high" | "warn" | "info"; title: string; detail: string; since: string;
  fix?: string; pane?: PaneLink; session?: string; dispatch?: string; notify?: true }
interface Suggestion { id: string; area: Area; kind: string; title: string; target: Target; reason: string; evidence: string[];
  sizeBytes?: number; actionLabel: string; since: string; pane?: PaneLink; session?: string; dispatch?: string }
interface Kept { id: string; area: Area; title: string; target: Target; reason: string }
interface Cleaned { id: string; at: string; area: Area; kind: string; title: string; target: Target;
  freedBytes: number; reportedBytes?: number; by: "auto" | "phone" | "conductor" | "cli" }
interface Dismissed { id: string; section: "warnings" | "suggestions" | "kept"; area: Area; title: string; dismissedAt: string }
interface Target { path?: string; repo?: string; branch?: string; pid?: number; udid?: string; name?: string }
```

- **Ids.** A suggestion or kept item's `id` hashes its kind, target and state fingerprint (16 hex), so a changed state is a new id. Warnings are machine-health findings and keep that finding's id (`disk`, `load:cpu`, `swap`, `orphan:node`, `simulator-clones`, ...) and its wording (`title`, `detail` and `fix`), so the phone and the conductor's `machine_health` name the same thing the same way. Their fingerprint is the severity. Nothing is ever keyed by day.
- **Wording.** `title`, `detail`, `reason` and `actionLabel` are plain sentences from the Hook, ready to show ("Remove worktree", "It has commits that aren't on any remote.").
- **Which findings.** Warnings come from the machine-health checks `swap`, `load`, `memory-hog`, `memory-leak` and `oom` (area memory), `disk`, `orphan` and `stale-lock` (sessions) and `simulator-clones` (simulators). The other machine-health checks (backups, OS updates, crashes) are not housekeeping.
- **`notify: true`** marks the warnings worth waking the owner for: the `disk` warning while free disk is under the 20 GB floor, from its first pass; `swap`, `load`, `memory-hog` and `memory-leak` once they were already there on the previous pass; and, from slice 3, a failed auto-clean. Suggestions never notify. Use the warning's `id` as the notification id. Push: warnings are machine-health findings, and a new `high` finding already sends one APNs push (`PHREN_HEALTH`, at most 3 an hour). That push now carries `phren.housekeeping: { computer, id }`, so an app that knows housekeeping opens the item there, while an older one still opens Resources. There is no second push for the same finding.
- **Gone items** (no longer found, or dismissed) are left out.

### Inventory (`?inventory=1`)

Everything on this computer the owner may want to see and handle, not only what crossed a threshold. Capability: `capabilities.housekeepingInventory: 1`. `GET /v1/housekeeping?inventory=1` adds `inventory`; without the flag it is left out, so the report stays small for the once-a-minute read. Measuring sizes is slow, so the Hook scans in the background (niced) a few minutes after it starts, then hourly, and on `POST /v1/housekeeping/scan`. A request with `?inventory=1` before the first scan has no `inventory` and starts one. A finished scan, or a handled row, changes `revision` and the overview badge's revision, which tells the phone to read it again.

The fixture `fixtures/conformance/housekeeping-report.json` is a full `?inventory=1&dismissed=1` answer with a disabled row in every section. It is tested against `inventorySchema` in `report.ts`.

```ts
interface Inventory {
  collectedAt: string; durationMs: number;
  scanning?: true;           // a scan is running: disable "Measure now"
  stale?: true;              // the scan is over 2 hours old
  worktrees: Array<{ id: string; repo: string; branch?: string; path: string; main: boolean; sizeBytes?: number; lastCommitAt?: string;
    dirty: number; untracked: number; unpushed: number; stashes: number; inProgress?: string; locked?: true;
    sessions: Array<{ pane: PaneLink; agent?: string; title?: string }>; processes: Array<{ pid: number; command?: string }>;
    action: Action }>;                                                                          // sorted by path
  space: Array<{ id: string; area: Area; kind: "cache" | "derived-data" | "xctest-devices" | "device-support" | "simulator" | "docker" | "tmp" | "node_modules";
    title: string; path?: string; udid?: string; sizeBytes: number; lastUsedAt?: string;
    inUse?: string;          // who holds it, e.g. "pid 4242 (xcodebuild)": why allowed is false
    note?: string;           // why a row with no action is never handled here
    action?: Action }>;                                                                         // largest first, at most 500
  sessions: Array<{ id: string; pane: PaneLink; agent?: string; title?: string; project?: string; status?: string; idleSeconds?: number;
    cwd?: string; dispatch?: string; role?: string; receipt?: { id: string; returnRead: boolean }; action: Action }>;   // most idle first
  processes?: Array<{ id: string; name: string; pid: number; processes: number; cpuPercent: number; memoryBytes: number;
    swapBytes?: number; startedAt?: string; command: string;
    pane?: { server: string; pane: string; label?: string; agent?: string }; action: Action }>;   // read live; largest memory + swap first
  errors?: Array<{ check: string; message: string }>;
}
interface Action {
  id: string;                // goes to POST /v1/housekeeping/approve
  kind: "remove-worktree" | "delete-path" | "close-pane" | "end-process" | "shutdown-simulator" | "delete-simulator" | "prune-docker-builder";
  label: string;             // "Remove worktree", "Clear cache", "Delete folder", "Delete node_modules", "Close pane", ...
  allowed: boolean;
  reason?: string;           // when not allowed: a plain sentence; show the button disabled with it
  confirm?: string;          // when allowed: what to show before approving
}
```

- **Worktrees** are every checkout directly under `~/Projects`, `~/Sites`, `~/.cache/fanout-*` and the scratch root (`/private/tmp` or `/tmp`), each repository's linked worktrees, and `.claude/worktrees`. Each has the counts from the safety inspection and the panes and processes running in it. "Remove worktree" is allowed only when the safety rules find nothing to lose. A main checkout (`main: true`) is never allowed.
- **Space** covers entries in the cache roots, scratch folders this user owns, each checkout's `node_modules`, simulators (macOS) and docker.
  - "Clear cache" covers DerivedData, XCTestDevices, phren-ci-builds and DeviceSupport entries.
  - "Delete folder" is for a scratch folder untouched for a day that is not a checkout.
  - "Delete node_modules" needs nothing running in that checkout.
  - "Shut down simulator" or "Delete simulator" needs no xcodebuild running; delete also needs the simulator shut down.
  - "Prune build cache" prunes docker build cache older than a week.
  - The npm and SwiftPM caches, docker images, containers and volumes have no action, and their `note` says why.
- **Sessions** are this computer's agent panes. "Close pane" is refused for the conductor, a working or waiting agent, dispatched work that hasn't returned, and a return that hasn't been read (`receipt.returnRead: false`): the evidence stays (the 2026-11-08 lesson). If the receipts can't be read, every pane stays. `status` is an open set from the agent: `idle`, `working`, `blocked`, `done`, and so on.
- **Processes** are read live on each `?inventory=1` request, not from the scan: the 20 programs holding the most memory plus swap (swap is per process on Linux only), then up to 5 more using half a core or more. A program's helpers count toward the process that started them, so Chromium and its renderers are one row (`processes` is the count) and ending the row ends the browser. CPU on Linux is measured over half a second, since `ps` reports a lifetime average there. "End" (`end-process`) sends SIGTERM to the row's root, waits 5 seconds, then SIGKILLs whatever of the row is left. It is refused for another user's process, Phren Hook and its parents, the conductor, an agent pane's own process (close the pane under Sessions instead), and programs the computer or the owner's session needs (launchd, WindowServer, systemd, sshd, the compositor, the terminal multiplexer, tailscaled and similar). The id hashes the pid, name and exact start time, so a restarted program has a new id. Ending a process frees memory, not disk, so `cleaned` records it with `freedBytes: 0`.
- **Approving:** the action is found in the last scan and re-checked against the disk, the panes and the dispatch receipts at that moment. If something changed, it is `refused` with the reason. A handled row drops out of `inventory` at once and appears in `cleaned`. The id hashes the row's kind, target and state, so a row that changed in a later scan has a new id, and the old one is `gone`.

### Owner actions

These are owner-only: approve, dismiss, restore and `POST /v1/housekeeping/scan`, which returns `{ started: true }`. They are listed in `owner-proof.ts` ROUTES, so once a phone signs, unsigned requests are refused, and agent (`X-Phren-Origin`) and peer origins always get 403. Bodies: `{ ids: string[] (1 to 200), revision?: string, by?: "phone" | "cli" }`.

- `POST /v1/housekeeping/approve` returns `{ results: [{ id, status: "done" | "refused" | "failed" | "gone" | "started", reason?, freedBytes? }], revision }`. A fresh pass runs first, and each id is judged against it, not against the report the phone holds. An id that is no longer present (its state changed) is `gone`, even on a stale `revision`. A kept item or a warning is `refused` with a plain reason. The action then re-checks safety against the disk as it runs ("It has commits that aren't on any remote.", "A process is using it now."). `freedBytes` is the statfs delta of the home volume, before and after. Work that would run past 45 s comes back `started`, and its result lands in `cleaned`. Actions: `remove-worktree` (plain `git worktree remove`), `delete-path` (cache entries, old scratch folders, a checkout's `node_modules`), `close-pane`, `shutdown-simulator`, `delete-simulator` and `prune-docker-builder`; each re-checks first (see Inventory). `end-job` is refused with "This computer's Hook can't do that yet." until slice 5. The conductor's MCP approve (slice 7) uses the same code with `by: "conductor"`.
- `POST /v1/housekeeping/dismiss` returns `{ revision }`. The items stay hidden until their state changes (for a warning, its severity). Unknown ids are ignored.
- `POST /v1/housekeeping/restore` returns `{ revision }` and undoes a dismissal. `GET /v1/housekeeping?dismissed=1` lists the hidden items in `dismissed`.

### Overview badge

A phone that opens `WS /v1/overview` with `resources=1` gets `{type: "resources", resources}` frames. On a Hook with housekeeping, `resources.housekeeping` is `{ revision, warnings, suggestions, worst: "high" | "warn" | "info" | null, freedTodayBytes }`. It is read from the cached view and never runs a pass. Re-fetch `/v1/housekeeping` only when `revision` changes.

### When a pass runs

Every 15 minutes, a minute after the Hook starts, at once when free disk first drops below 20 GB or the computer first becomes `stressed` (checked on the 5-minute health read), and before an approve. Reports are stored in `<bridge>/housekeeping/reports/` and kept 14 days, next to `cleaned.json` (14 days) and `dismissed.json`.

### Owner inbox

Each warning with `notify: true` appears in the owner inbox as a `needs-you` entry whose source is `housekeeping:<id>`. A reworded finding stays one row, and the row resolves itself when the warning goes. This fixes the disk-janitor's daily "This inbox id names another item" failure.

## CLI

`phren housekeeping` prints the newest report and inventory for this computer and every linked one, with each row's action id (`--local` for this one only, `--json` for the raw answer). `phren housekeeping --apply <id,id>` approves rows from the terminal (`by: "cli"`), with the same re-checks. `--scan` starts a scan. `phren housekeeping --dry-run` runs a pass in the current process without the Hook. It stores nothing and acts on nothing, and since the panes are the Hook's to list, it sees processes only.

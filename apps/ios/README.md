# phren for iOS

A native SwiftUI app for agents and project memory. Agents and terminals connect
directly to your computers without GitHub sign-in. For memory, sign in with
GitHub, pick your store repository, and view + manage your findings, notes,
tasks, and review queue — **live**. While an agent works on another machine and
phren's session hooks push commits, the app polls GitHub continuously in the
foreground, so new findings and tasks appear on your phone within seconds.

## Everyday workflow

Your agents capture and use memory while they work. The phone is for checking
their sessions, exploring a project's findings and graph, adjusting skills or
instructions, and adding direction when needed. It does not require approving
every finding or agent action.

The main tabs are **Projects, Agents, Tasks, Search, and Settings**. Tasks is your
workload view: it starts on **Backlog** and remembers your choice of Backlog,
Active, or Done. A compact status menu, optional search, filters (creation age,
priority, project, and store), and sorting share one control row. Sort by task
order, newest, oldest, or priority; the choice is saved.

Task rows show two-line previews and creation dates. Tap the text to read the
full plan, check it to complete, or swipe for **Start**, **Backlog**, and **Done**.
**Select** lets you move several tasks together, including across stores. Bulk
controls appear only while selecting. Older tasks without a recorded date say
**Date unknown**. New tasks retain their creation time through edits and offline
sync. Projects appear above agent setup links; the **More** menu keeps Skills,
Agent instructions, and Live sessions available without scrolling.
The **Agents** tab opens with sessions from every saved computer, grouped with
working and waiting sessions first, followed by idle, done, and other open tabs.
Each compact row names its computer; tap to chat or use its info button for
terminal and session details. Search matches computers, projects, titles, agents,
and folders. Computer connections, Skills, and Agent instructions remain below.

**Settings → Appearance → Theme** offers Charcoal (white text, dark panels,
Phren purple controls), Amethyst (deep violet), Graphite (warm charcoal), and Slate
(cyan and lavender). Charcoal is the default. Create a named custom theme from
any preset or your current palette, then choose background, text, panel, accent,
and link colors with swatches or hex values. Preview before saving; edit,
duplicate, or delete saved themes. Choices persist across launches and apply
throughout the app and terminal while preserving navigation and chat drafts.

Herdr uses a single compact header for back, computer/status, and reconnect.
The terminal starts directly below it; the keyboard stays hidden until requested.
Swipe down on its shortcut row to dismiss the keyboard.

Chat uses compact tool activity and a full-width composer. Its smaller Send
control becomes Stop while an agent works and the draft is empty; typing a new
message brings Send back so you can steer the agent. **Switch agent**, beside
Terminal, opens conversations across saved computers and agents within the
current tab. Each conversation keeps its own draft. Swipe down on the message
box or its icon row to dismiss the keyboard without sending or losing your draft.

**Memory maintenance**, available from Projects and Settings, is optional. Its
overview groups candidates, stale memories, and conflicts by project and store.
Open a project to copy a maintenance request into an agent conversation or
select several entries for manual action. Copying a request does not send it
or change the queue. Individual triage is still available from the filter menu.

## Architecture

**Serverless.** A phren store is a git repo of markdown, and git is phren's
sync layer — so the app talks straight to the GitHub REST API. There is no
phren backend. The GitHub token is stored in the device Keychain and sent only
to GitHub. Optional live sessions use a separate SSH connection to a computer
the user adds, using its private Phren Hook service.

GitHub request paths encode repository names, branches, and file names as
literal path components. Authenticated API redirects stay on
`https://api.github.com`; other hosts, HTTP downgrades, and alternate ports
are refused before forwarding credentials or write bodies.

Web previews use the restricted SSH dispatcher (`phren-hook v1 web`), with
loopback destinations validated by the helper. Phone authorization lines keep
`restrict,pty,command=…` and grant no SSH forwarding: OpenSSH's `permitopen`
does not restrict Unix-socket forwarding, which could bypass the dispatcher.
On each connected computer, install the updated CLI and run
`phren bridge install` to migrate existing Phren keys and install the preview
command together. The legacy `enable-web-previews.py` script now directs users
to that installer without modifying keys. The app checks
`capabilities.webPreview == "ssh-exec"` before opening a preview; older helpers,
including released 0.2.14, show an update instruction. Existing chat and terminal
connections continue to use their current dispatcher commands.

```
apps/ios/
  project.yml            # XcodeGen definition (the .xcodeproj is generated)
  Phren/                 # SwiftUI app target
    AppModel.swift       # root state: auth, store, snapshot, sync status
    AppRuntime.swift     # shared launch mode and preferences domain
    UITestFixtures.swift # isolated bootstrap data, Debug simulators only
    WidgetBridge.swift   # writes the JSON snapshot the widgets read
    Intents/             # App Intents: "Hey Siri, add a task to phren"
    Onboarding/          # welcome → sign-in → repo picker → initial sync
    Features/            # Projects, Agents, Tasks, Search, Settings tabs
                         #   + native Skills, Agent setup and Memory graph screens
  PhrenWidgets/          # WidgetKit extension target (Home Screen + Lock Screen)
  PhrenLive/             # app-only SSH transport (SwiftNIO SSH) + connection tests
  PhrenKit/              # Swift package: everything testable, UI-free
    Sources/PhrenKit/
      Models/            # Finding, Note, PhrenTask, QueueItem — mirror the TS shapes
      Metadata/          # transcribed regexes from content/metadata.ts et al.
      Markdown/          # FindingsFile / ReviewFile / NotesFile / TasksFile
                         #   + JournalFile (team stores), TruthsFile and
                         #   TopicDocument (read-only tiers)
      GitHub/            # REST client + OAuth device flow + PAT validation
      Sync/              # LocalStore cache, pending-ops queue, SyncEngine,
                         #   ColdStore (archived-findings catalogue + cache)
      Search/            # on-device inverted index (live knowledge only)
    Tests/               # fixture-driven tests (see "Fixtures" below)
  scripts/generate-fixtures.mjs
```

Task screens share one filtered/sorted row set per render. Bulk actions resolve
the current writable selection when tapped. Search parses document dates once
when constructing its index and computes their age at query time, keeping
recency current without repeating date parsing on every keystroke.

Live session lists use compact, separated cards. Tap the pin beside a session
to keep it in **Pinned** in the agent overview, and tap it again to unpin.
Project lists put pinned sessions first. Pins stay on this device
across launches and identify the computer, Herdr server, workspace, and tab.
They do not make an offline session available for chat.

An active session has a left activity bar and rotating circle. The circle shows
context usage when the agent reports both current token usage and a context
limit. Hook currently supplies this for unambiguous Codex sessions; other or
unavailable metrics use the status symbol instead of an invented percentage.
The outer arc uses a continuous 0.9-second rotation without a frame timer.
Offline, hidden, and background indicators stop animating; Reduce Motion keeps
them still.

### The format contract

The CLI's markdown formats and mutation semantics are the contract. Every
parser/serializer in `PhrenKit/Sources/PhrenKit/Markdown` is a line-by-line
transcription of the TypeScript in `packages/cli/src`, with doc comments
citing the original file and line. Two rules keep the implementations in
lockstep:

1. **Unknown metadata comments are preserved verbatim** by every serializer.
2. **Fixtures are generated by the real CLI code**, never written by hand.

Mutation tests assert *byte-identical* output: PhrenKit editing a CLI-written
file must produce exactly what the CLI would have produced.

Intentional MVP divergences from the CLI's `addFindingToFile` (all cleaned up
by the CLI on its next run; files remain valid):

- no coreference resolution (`resolveCoref`)
- no automatic finding-type detection (`autoDetectFindingType`)
- exact-normalized-text dedup only (no Jaccard similarity)
- no auto-archive cap enforcement

Secret scanning (`scanForSecrets`) **is** ported — the app refuses to commit
anything the CLI would reject.

### Sync model

The store is split into two tiers. The **hot tier** is mirrored eagerly and
parsed on every sync; the **cold tier** is catalogued for free and downloaded
one document at a time, only when you open it.

#### Hot tier — mirrored

`phren.root.yaml`, `stores.yaml`, `.phren-team.yaml`, and per project directory
`FINDINGS.md`, `tasks.md`, `review.md`, `summary.md`, `CLAUDE.md`, `truths.md`,
`notes/YYYY-MM-DD.md`, and `journal/YYYY-MM-DD-<actor>.md`.

Global and project skills are also mirrored, in both `<scope>/skills/<name>.md`
and `<scope>/skills/<name>/SKILL.md` form. Supporting files inside skill folders
remain on the computer; the phone edits the instruction document only.

The journal is where a team store's findings actually live (see "Team stores"
below). It is the same shape as `notes/` — one small file per day — with an
actor suffix, so it grows with the number of people writing rather than with
the size of what they wrote.

`truths.md` — phren's pinned, always-injected, never-decaying memory — renders
as a read-only section at the head of the Findings tab and is searchable as
its own `truth` kind. Pinning is `phren pin <project> "…"` from a computer;
the app never writes it.

`global/FINDINGS.md` is in the hot tier too and remains **read-only**: it is
the consolidate skill's cross-project output —
often the largest findings file in a store — and the phone has no business
rewriting it. Global skills and `global/CLAUDE.md` are authored content and
can be edited from the app. `LocalStore.isSyncedPath` admits global findings on its own branch rather
than by relaxing `isProjectDirName`, because `isWritablePath` delegates to
that predicate; the split is pinned by negative tests. Every write surface
(add/edit/delete, the voice mic, Siri) asks `isReadOnlyProject` before drawing
a control, and `SyncEngine.enqueue` refuses a non-writable path outright
rather than applying it locally and parking it at flush time.

Reads: `GET git/ref/heads/<branch>` with an `If-None-Match` ETag (304s don't
count against the rate limit) → on change, recursive tree → fetch only changed
blobs. Live mode polls every ~7s while foregrounded.

Startup opens saved stores and cached content before checking GitHub. Losing
reception, timeouts, rate limits and server errors preserve the Keychain token;
foreground sync retries when the connection returns. The last verified GitHub
identity is cached with that token for offline attribution. Only a GitHub 401
requires signing in again, and reconnecting restores the attached stores and
pending edits. Failed writes wait for the next sync attempt, including polls
where the remote head is unchanged. Explicit **Sign out** still removes local data. `PhrenTests`
exercises actual app startup with stalled/failed requests and isolated storage.

#### Cold tier — catalogued, hydrated on demand

Once a project passes its findings cap, the CLI's `autoArchiveToReference`
moves its oldest findings into `reference/topics/<slug>.md`. That is a lot of
content — on one real store, 94% of all finding-bytes — and syncing it eagerly
was measured at **5.5× the 30-day download, 6.9× the cold-start payload and
6.9× the per-poll parse**. So it isn't synced. Instead:

- The recursive tree the engine already fetches carries every blob's path,
  sha **and size**, so `ColdStore` builds a complete catalogue of the archive
  from a response that has already been paid for — zero extra requests, zero
  extra bytes. It persists as `cold-tier.json`.
- A document's text is fetched only when you open that topic.
  `ColdStore.hydration(for:)` is the only way in, so the cached-sha vs
  tree-sha comparison can't be skipped: a topic re-consolidated since you last
  read it is refetched, never rendered stale.
- Oversized blobs are refused *before* the request, on the size the tree
  already reported — 1 MB raw, against a largest observed topic doc of ~341 KB
  (~445 KB base64 through the blobs API). Better a clear message than a
  spinner on a cellular connection.
- Hydrated documents cache under a 4 MB budget with LRU eviction, outside
  `LocalStore`'s mirrored `files/` tree.
- **Cold content never enters `SearchIndex`.** Every entry parsed out of a
  topic doc is stamped `archived`, which the index filters by construction —
  a phone search returns live knowledge, matching the CLI, which strips
  archived content from its own index. There is no separate search over
  hydrated cold docs either.

The Findings tab ends in one row — "Archived 2026-08-01 — 214 findings in 6
topics" — that opens the archive browser. The date comes from the
`<!-- consolidated: … -->` stamp the CLI leaves in the project's own
`FINDINGS.md`, a file already synced; the topic count and byte total come from
the catalogue. The finding count only appears once every topic in the project
has been hydrated at least once, because until then the number lives inside
documents nobody has downloaded. Archived entries are marked as such and have
no edit affordance — they are read-only everywhere else in phren too.

`.config/skill-preferences.json` is the only synced configuration document;
the rest of `.config/` and `reference/` are not synced.

#### Writes

- **Writes**: offline-first. Mutations apply to the local cache instantly,
  queue as domain ops in `pending-ops.json`, and flush FIFO — **coalesced**:
  consecutive queued ops that target the same file are applied to the local
  document in order, serialized once, and pushed as a *single* Contents API
  PUT. One commit per file-batch, not per op: batch-approving 40 review items
  is one commit to `review.md`, not 40 racing the 7s poll. The message is
  `phren: <project>(<kind>) via ios`, with the batch size appended when a
  commit carries more than one op (`phren: myproj(update x12) via ios`).
  A group is always a contiguous prefix of the queue, so ops on different
  files never merge and never reorder.
- **Write conflicts**: a sha conflict on a group triggers refetch → re-apply
  the whole group onto the fresh content → retry (3×), then parks the ops
  in Settings → "Needs attention". Parking is per op, so an item another
  machine already handled parks alone while the rest of the batch commits.
- **Write whitelist**: only `<project>/FINDINGS.md`, `tasks.md`, `review.md`,
  `notes/YYYY-MM-DD.md` and `journal/YYYY-MM-DD-<actor>.md` are writable knowledge
  files, and only for a `<project>` that is a real project directory. Authored
  skills and canonical `CLAUDE.md` are also writable, under a project or
  `global/`. Skill switches write individual keys in `.config/skill-preferences.json`.
  The rest of `.config/`, `phren.root.yaml`, `stores.yaml`, `.phren-team.yaml`,
  `summary.md`, `truths.md`, `reference/`, global findings and every reserved
  directory (`profiles`, `templates`, `scripts`, mirroring the CLI's
  `RESERVED_PROJECT_DIR_NAMES` plus `link.sh`'s store scaffolding) are
  read-only or untouched. The journal is gated on the same project-directory
  predicate as `FINDINGS.md`, which is what keeps a team store from making
  `global/` writable by the back door.

### Skills and agent instructions

Projects → **Skills** opens a searchable library across the selected stores.
Inside a project, the **Skills** button opens just that store's
project and global skills. Its close button returns directly to the project from
the library or skill detail. Saving or cancelling an edit returns to skill detail;
unsaved edits still require an explicit discard before leaving the editor.
Create a skill with its name, description, instructions, store and scope;
read, edit, share or delete an existing skill. Creation checks names without
case sensitivity across both flat and folder formats. Project choices come
only from the selected writable store. Read-only stores have no editing controls.

Each skill has an **Enabled for agents** switch. A project skill's choice
affects that project; a global skill's choice affects all projects. These
are source-scope switches, not project-specific overrides of inherited globals.
The shared file `.config/skill-preferences.json` uses schema 1 and an
`enabledSkills` object keyed by `<scope>:<normalized-name>` with boolean values.
Names are lowercased with one trailing `.md` removed, matching the CLI.
Unknown JSON fields are preserved. Each queued change guards its previous
key value, so edits to different skills merge while conflicting choices are
reported in Settings. An invalid or future settings document cannot be overwritten.

The updated CLI reads these settings before legacy machine-local
`disabledSkills` choices. A key without a shared choice still uses the old
local preference on that computer; the phone labels that state explicitly.
Upgrade the desktop CLI and enable periodic pulls with
`phren config pull-interval 60` to refresh existing managed skill links and
generated instructions after phone changes arrive. A manual sync/link also
applies them. Agent tools may need a new session to reload their skill list.

Projects → **Agent instructions** groups global and project instructions,
with links to each scope's skills. The app edits the canonical store
`CLAUDE.md`; phren's link step derives managed `AGENTS.md` and Copilot mirrors
on the computer. Changes reach linked agents after the computer syncs, and
generated mirrors refresh when phren links the project or its MCP poller pulls. This screen manages
agent setup. **Live sessions** separately reads running Herdr tabs through the
computer's Phren Hook. Hook configuration remains computer-local.
See [agent connection design notes](AGENT_CONNECTIONS.md) for the Phren Hook/Herdr path.
See [iPhone design notes](DESIGN.md) for session density, terminal gestures, and keyboard layout.

Editors keep a separate draft during live refreshes and confirm before
discarding changes. Saves and deletes carry the content the user opened, so
conflict replay cannot silently overwrite another writer. A conflict detected
while editing offers a comparison and merge flow. A conflict found during
upload preserves the queued draft in Settings → Needs attention → Review saved
draft, where its text can be copied or shared. Background pulls preserve
queued files and their original SHAs until flush can check them. Pending queue
schema 2 added guarded authored edits; schema 3 adds individual skill switches.
Schema 1 and 2 queues upgrade while retaining all existing operations.

### Phren Hook and native agent connections

Phren connects directly to **Phren Hook**, the independent helper shipped with
`@phren/cli`. Install it on each computer running your agents:

```sh
npx --yes @phren/cli@0.2.14 bridge install
npx --yes @phren/cli@0.2.14 bridge doctor
```

Requirements: macOS or Linux, Node 20+, Herdr, SSH/Remote Login, and `lsof`.
Use Tailscale to reach the computers away from home. No public gateway, Funnel,
Moshi app, or Moshi helper is required. Existing third-party applications remain
separate and are not uninstalled.

In Phren, open **Agents → Computers**, add the SSH destination, copy the device's
public authorization line, and add it to that user's `~/.ssh/authorized_keys`.
Verify the computer's SSH fingerprint. A key already installed by Phren is
upgraded by `bridge install`, with a backup. Computers, pinned keys, project
mappings, and unsent text/image drafts remain in place during app updates.

The installer creates a LaunchAgent on macOS or a systemd user service on Linux.
For Linux operation after logout, enable lingering for the user with your system
administrator. The bundled helper is copied out of the npm cache into a versioned
folder under `~/.local/share/phren/bridge`; it does not need `npx` at runtime.

```sh
npx --yes @phren/cli@0.2.14 bridge status
npx --yes @phren/cli@0.2.14 bridge update
npx --yes @phren/cli@0.2.14 bridge rollback
npx --yes @phren/cli@0.2.14 bridge uninstall
```

Uninstall stops the background service and removes Phren's agent callbacks.
Local history, images, settings, and backups are preserved. Remove the iPhone's
`phren-iphone` public-key line to revoke its SSH access.

### Agent chat, terminal, and project context

Codex, Claude Code, and GitHub Copilot sessions appear across connected machines.
Select an agent to chat, or open its exact Herdr workspace and pane in the native
terminal. **Project session** offers chat and terminal, with the project's skills,
findings, tasks, and graph available alongside the conversation.

Chat supports saved text/image drafts, image uploads, history, progressive text,
real usage counters, working/waiting state, stop, and repository diffs. Phren
streams newly written transcript rows; it does not invent token counts or claim
per-token output when an agent only writes completed messages. Slash suggestions
are vertical; the full command menu opens the running agent's own terminal menu,
including installed skills and custom commands.

Tool calls expand independently with a short output preview. Open **Full output**
to read lengthy results in pages; First, Previous, Next, and Last keep every line
reachable without laying out the entire result at once. **Copy** includes the
whole output, regardless of the current page.
Expanded patches also use pages, preserving colored changes and line numbers;
**Copy patch** includes all supplied lines.

The installed lifecycle callbacks bind agent session IDs to the exact Herdr pane
and foreground process. On Codex, review new Phren entries in `/hooks`; Codex
requires trust for new hook definitions. Resume existing agents if their version
does not reload hook configuration. Open transcript descriptors also identify
existing conversations without restarting them. An ambiguous identity disables
chat instead of selecting another agent.

Codex and Claude PermissionRequest callbacks can show a native approval while
Phren watches that conversation or the foreground session overview. Only an
explicit answer resolves the pending request. If the phone is not watching,
the normal terminal prompt appears
immediately; unanswered phone requests return to the terminal after 55 seconds.
Question dialogs and unsupported provider interactions use Phren's native
terminal. No agent is launched automatically.

The terminal keyboard opens only from its keyboard button. Taps keep Herdr's
switch control and links clickable; swipe to scroll, pinch to adjust text size,
and hold to select. The compact dock includes arrows, Enter, Backspace, clear
line, clipboard, and agent shortcuts. Holding Ctrl opens the shortcut panels.
The **Uploads** tab offers Photos, Camera, and Files. Phren Hook 0.2.14 identifies
the currently focused pane, then verifies its agent conversation before opening
the attachments as a native chat draft. With older Hooks, choose the destination
session explicitly. Attachments upload only when you press Send.

**Web servers** discovers the user's listening HTTP development apps. Phren opens
previews through an SSH tunnel, so loopback-only apps work from the iPhone.
A bounded activity journal stays on each computer and records status transitions
with project and pane provenance. Generated catch-up summaries are a later feature.

See [Phren Hook setup](../../docs/phren-hook.md) and
[the connection protocol](AGENT_CONNECTIONS.md) for details and validation.

## Running checks deliberately

The iOS GitHub workflow is **manual only**. Pushes and pull requests do not launch
macOS package tests, simulator builds, or native UI tests. From **Actions → iOS →
Run workflow**, the default run checks PhrenKit/SSH, builds the app, and checks the
web graph renderer. Enable **ui_tests** only when you explicitly want the full
native UI suite too. It has a 10-minute step limit; the app job has a 20-minute
limit, package tests have a 10-minute limit, and a new run cancels an older run
on the same branch. Native test artifacts expire after three days.

For normal development, run the affected Swift package tests and targeted
simulator tests locally; record the checks with the change. Changes to shared
markdown formats still require the CLI-generated fixture checks against
PhrenKit. The regular cross-platform CI remains automatic, with 10-minute job
limits and cancellation of superseded runs. Release workflows are already manual.

## Building

Requirements: Xcode 26+ (Swift 6.2; deployment target iOS 17), [XcodeGen](https://github.com/yonaskolb/XcodeGen),
Node 20+ and pnpm (the version in the root package.json).

```bash
pnpm install --frozen-lockfile   # from the repository root; includes graph dependencies
cd apps/ios
xcodegen generate      # produces Phren.xcodeproj from project.yml
open Phren.xcodeproj   # build & run the Phren scheme
```

The app target bundles the shared graph renderer during every build. A clean
checkout therefore includes the renderer automatically, including in CI;
`Phren/Resources/graph/phren-graph.js` remains generated and gitignored.

### Install directly on a paired iPhone

For the same direct-device delivery used by AlphaLens and Mutter, configure
the ignored `apps/ios/Local.deploy.json` from `Local.deploy.json.example`, then:

```bash
python3 apps/ios/scripts/deploy-phone.py
```

Set `device` from `xcrun devicectl list devices` and your Apple development
`team`. Optional `derived_data` reuses a build directory; `--device` overrides
the saved phone. The command builds Release, verifies its signature, installs
the app, and launches `com.phren.ios`, preserving its existing app data.
Each build increments the previous build number in that derived-data directory
for both app and widget. Use `--build-number N` to choose a higher number when
switching build directories or Macs. Settings → About and the installation page
show the version and build, so device updates can be identified unambiguously.
If the phone is away, add `--build-only` to prepare and verify the signed app
without contacting a device, then use the private Tailscale installer below.

For unattended signing, `signing_helper` points to an existing executable that
accepts `unlock` and `lock`: `unlock` prints only the dedicated keychain's path
and prioritizes it, while `lock` relocks it and restores the prior search list.
`signing_lock_directory` must match the shared lock used by other apps with
that helper. This Mac reuses AlphaLens's configured helper and lock; Phren
does not copy credentials, export identities, or alter the login keychain.
The script relocks after success, failure, or interruption and stops Xcode
before cleanup. Omit both helper fields to use Xcode's ordinary signing setup.

This installs a development-signed app directly; it does not upload to
TestFlight. A locked phone may need to be unlocked before the app can launch.

### Install remotely over Tailscale

A provisioned iPhone can install the same development-signed app from a private
HTTPS page. Apple supports [over-the-air manifests for development exports](https://help.apple.com/xcode/mac/current/en.lproj/devde46df08a.html).
Both the Mac and phone must be connected to the tailnet; the phone needs its
existing Developer Mode setup. The hardware UDID must be registered in the app
and widget provisioning profiles. CoreDevice's paired-device discovery is not
required for this delivery path.

After `deploy-phone.py --build-only`, package the signed app. Substitute the
Mac's Tailscale DNS name, the hardware UDID, the build path from that command,
and a new delivery identifier for every build:

```bash
python3 apps/ios/scripts/prepare-ota.py \
  --app /path/to/Release-iphoneos/Phren.app \
  --device-udid YOUR-HARDWARE-UDID \
  --base-url https://YOUR-MAC.YOUR-TAILNET.ts.net/phren-install/BUILD-ID \
  --output "$HOME/Library/Application Support/Phren/PhoneDelivery/site/BUILD-ID" \
  --note 'What changed in this build.'
python3 apps/ios/scripts/serve-ota.py \
  --directory "$HOME/Library/Application Support/Phren/PhoneDelivery/site"
```

Keep the server running (or run it as a user LaunchAgent). In another terminal:

```bash
tailscale serve --bg --set-path /phren-install http://127.0.0.1:18763
```

If Tailscale prints a setup URL, enable HTTPS/Serve there, leave public Funnel
off, and rerun the command. This adds only the `/phren-install` handler; choose
a different path/port if another service already uses it. The loopback server
works with the macOS Tailscale app, which cannot serve directories directly.
See [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve).

Open the build's HTTPS URL in Safari on the iPhone, tap **Install Phren**, and
confirm **Install**. The app updates in place. Keep the Mac awake until the
download finishes, then open Phren from the Home Screen. Downloading the IPA
alone with Taildrop does not trigger installation.

The packager checks the app and widget profiles and verifies signatures before
and after ZIP extraction. The server exposes only installation assets from
the separate delivery directory, with the required manifest/IPA content types.
It never serves the checkout, configuration, or signing keychain. To stop
sharing, run `tailscale serve --set-path /phren-install off` and stop the
loopback server. Remove old build directories when their links are no longer
needed; don't replace files while an installation is downloading.

PhrenKit alone builds and tests anywhere Swift runs (macOS or Linux):

```bash
cd apps/ios/PhrenKit
swift test
```

### Memory graph

Open **Projects → Memory graph**, or use the graph button on a project's
detail screen. The app bundles the same Three.js renderer as the VS Code
extension and web viewer, using the payload contract shared with the terminal
graph. All rendering assets are local; browsing cached data works offline.

The phone provides native store/project menus, All/Findings/Tasks filters,
search, zoom buttons and Fit graph. Drag to orbit, pinch to zoom, and tap a
node for readable details, sharing and a link to its project. Desktop panels
are replaced by these native controls; editing is available in the project's
normal findings and task screens. Bloom is disabled on the phone, and label
widths are constrained for the smaller viewport.

Use the top-left **Back** button to leave the graph. Interactive back swipes
are disabled on this screen so canvas and edge drags stay with the map;
normal back gestures remain available elsewhere in the app.

**Focus connections** in a node's detail sheet limits the view to one or two
steps of actual links. The **Previous focus** control returns to earlier focus
points; the close button restores the full current view. **Options → Save this view**
bookmarks its store, project, filter, and focused node. **Saved views** restores
them after app relaunch using current synced content. These bookmarks stay on
the device; they do not preserve a camera position or copy store content.
Missing stores ask to be reattached; deleted projects/nodes return to a wider
view with an explanation.

One explicitly selected store is rendered at a time. The picker uses full
owner/repository names and node selections carry that identity, so projects
with the same name in different stores cannot be confused. The view rebuilds
after live sync, preserves the camera on content refresh, and refits when the
store or project changes. Loading failures and WebKit process termination
offer a retry instead of leaving a blank canvas.

The graph includes project hubs, current FINDINGS.md bullets, team journals,
and active/queued tasks (including projects with only tasks). Archived blocks
are excluded. Overview limits keep large stores bounded; selecting a project
lifts its per-project finding/task caps. On-device topics use finding tags.
Computer-only fragment/reference indexes and quality scores are not synced.

To run the phone renderer smoke tests at a touch viewport:

```bash
node apps/ios/scripts/bundle-graph.mjs
pnpm exec playwright install chromium
node --test apps/ios/scripts/test-graph.mjs
```

These tests cover local assets, node selection and store attribution, camera
commands, repeated mounts, and missing-renderer recovery. Set
`PHREN_GRAPH_SCREENSHOT=/tmp/graph.png` to save the synthetic test graph image.

`PhrenUITests` exercises native search → focus → save → relaunch → restore in
an iPhone simulator (`xcodebuild test -scheme Phren -destination 'platform=iOS Simulator,name=iPhone 17 Pro'`).
It also checks restoring across stores and changing a skill from computer-local
defaults to an explicit enabled/disabled choice.
It uses isolated synthetic stores and tokenless clients; the fixture entry point
is compiled only in Debug simulator builds. Saved test views use a separate
UserDefaults suite.

## Releasing

The App Group entitlement (`group.com.phren.ios`, shared by `com.phren.ios`
and `com.phren.ios.widgets`) is declared in `project.yml`. The September 2026
release check obtained development provisioning profiles for both targets,
including that group. The archive then stopped at signing-key access
(`errSecInternalComponent`); no TestFlight upload or real-device verification
has completed. Other developer accounts still need their own setup:

1. **Register both App IDs** in the Apple Developer portal → Certificates,
   Identifiers & Profiles → Identifiers: `com.phren.ios` (the app) and
   `com.phren.ios.widgets` (the `PhrenWidgets` extension).
2. **Create the App Group** `group.com.phren.ios` (same section → App Groups),
   then enable it on both App IDs above.
3. **Re-run `xcodegen generate`** and archive. Do **not** hand-edit
   `Phren/Phren.entitlements` or `PhrenWidgets/PhrenWidgets.entitlements` —
   both are gitignored and fully regenerated from the `entitlements:` blocks
   in `project.yml` on every `xcodegen generate`; any manual edit is silently
   overwritten the next time someone runs it.

For local development:

- **Unsigned build** (what CI / release-readiness checks use):
  `CODE_SIGNING_ALLOWED=NO` checks compilation without validating signing
  identities or provisioning profiles:
  ```bash
  xcodebuild -project Phren.xcodeproj -scheme Phren -configuration Release \
    -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build
  ```
- **Signed Debug-to-device build**: select the registered development team
  and connected iPhone in Xcode, enable automatic signing, and run. Retain
  the App Group entitlement so the app and widget can share synced data.

## GitHub OAuth App (one-time owner setup)

Device-flow sign-in needs a registered GitHub **OAuth App**:

1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.
2. Any homepage/callback URL (device flow doesn't use the callback).
3. In the app's settings, **enable "Device Flow"**.
4. Copy `Config/Local.xcconfig.example` to `Config/Local.xcconfig` and set
   `PHREN_GITHUB_CLIENT_ID` to the public client ID and `DEVELOPMENT_TEAM` to
   your Apple team ID. Local configuration is ignored by git. The committed
   `Config/App.xcconfig` optionally includes it; command-line build settings
   can supply the values in CI. No client secret is needed or shipped.

The app reads the ID from its built Info.plist, makes GitHub device sign-in
the primary button when configured, and retains token sign-in as a fallback.
Empty, placeholder, and unexpanded IDs hide device sign-in and fail locally
before any invalid request. Registering the OAuth App remains owner setup.

Once the login keychain permits signing and the App Store Connect app record
exists, the release helper creates an archive and can export or upload it:

```bash
python3 scripts/release.py --build-number 2             # signed archive
python3 scripts/release.py --build-number 3 --export    # signed IPA
python3 scripts/release.py --build-number 4 --upload    # TestFlight upload
```

Run from `apps/ios`. Use the next unused build number. Pass `--team` and
`--client-id` or set the local xcconfig; the helper resolves the effective
Xcode settings before archiving. `--allow-token-sign-in` explicitly permits
a build without OAuth. It never removes the App Group entitlement. Archive
and export files go under `~/Library/Developer/Xcode/Archives/phren/`.
`--upload` sends a build to App Store Connect; it does not submit App Review.
Follow [the device checklist](AppStore/DEVICE_CHECKLIST.md) before release.

Until then, the **personal access token** sign-in path works out of the box:
create a fine-grained PAT with **Contents: Read and write** + **Metadata:
Read** on the store repo.

## Widgets

The `PhrenWidgets` extension (`com.phren.ios.widgets`) puts your memory count
and your top active task on the Home Screen and Lock Screen without opening
the app:

- **systemSmall** — memory count, big numeral.
- **systemMedium** — memory and project counts + top task line + relative last-sync; the
  memory half and task half deep-link separately (`phren://projects`,
  `phren://tasks`).
- **accessoryCircular** / **accessoryRectangular** (Lock Screen) — memory
  count, and memory count + top task line respectively.

The widget does not link PhrenKit or the app target. The app and extension
compile the same small models in `Shared/`, avoiding duplicated JSON contracts.
The glance-widget bridge is a JSON file: `AppModel.refresh()` — where per-store sync status
settles every ~7s live-poll cycle — writes a `WidgetSnapshot` (memory and project
counts, top task, last-sync date, and legacy review fields) to the `group.com.phren.ios`
App Group container through an actor off the main thread, skipping identical
snapshots, then calls `WidgetCenter.shared.reloadAllTimelines()`
**only** when the visible content actually changed, so a quiet poll never
touches the widget refresh budget. Before the app has ever run, the widgets
show an "open phren" state rather than fake numbers or a blank card.

The extension also renders permission Live Activities. Requests received in chat
show an explanation and Deny/Approve buttons on the Lock Screen and Dynamic
Island. Actions authenticate, open Phren, and consume a private, protected
request record before sending the exact answer over pinned SSH. Existing
Keychain protection remains `WhenUnlockedThisDeviceOnly`. Host changes, expiry
and repeated actions are rejected; ambiguous delivery is never retried.
The activity contains display text and an opaque local ID only. Live Activities
do not keep SSH running in the background: receiving new requests while the app
is suspended needs a push relay, which is not currently configured.

Tapping a widget delivers straight to `PhrenApp`'s `onOpenURL` (no
`CFBundleURLTypes` registration needed for widget-originated opens), which
selects the matching tab. Existing `phren://review` links open the optional
maintenance sheet. Old snapshots without a memory count show a dash until the
app writes a fresh snapshot.

Building the widget target requires no extra setup — `xcodegen generate`
declares both the extension and the App Group entitlements for both targets.
The App Group only needs to be provisioned with an actual Apple Developer
account for a **signed** build to a device or for the app and widget to
actually share data; an unsigned `xcodebuild build` (e.g. CI) builds and
embeds the extension fine regardless.

## Siri, Shortcuts, and the Action Button

"Hey Siri, add a task to phren" — from a locked phone, mid-walk, without a
screen. Two App Intents (`Phren/Intents/`) back it:

| Intent | Phrases (every one must contain the app name) |
| --- | --- |
| `AddPhrenTaskIntent` | "Add a task to phren", "Add a phren task", "New phren task", "Queue a task in phren", "Add a task to `<project>` in phren" |
| `AddPhrenNoteIntent` | "Add a note to phren", "Add a phren note", "New phren note", "Capture a thought in phren", "Add a note to `<project>` in phren" |

Siri collects the text itself (`requestValueDialog`: "What's the task?" /
"What should the note say?") and confirms with "Added to `<project>`." Both
appear in the Shortcuts app as **Add Task** / **Add Note** under Capture, so
binding one to the Action Button needs nothing beyond the app being installed.

**Where it lands.** Naming a project is optional; without one the capture goes
to the last project anything was captured into — the same
`VoiceCaptureLastTarget` the in-app voice sheet defaults to, written by both
surfaces — falling back to the first writable project.

**Hearing the name.** Dictation has no entry for "phren" and reliably hears
"friend" or "fren", so `INAlternativeAppNames` in the app's Info.plist
registers both (plus a "fren" pronunciation hint). Project names get the same
treatment in reverse: `ProjectEntityQuery` strips everything but letters and
digits from both the spoken fragment and the slug, so "alpha lens" matches
`alphalens`. Every candidate that survives is returned, best match first —
when "alpha lens" could equally be `alpha-lens-website`, Siri asks instead of
guessing. A single candidate resolves silently.

**How it runs.** `openAppWhenRun` is false: intents execute inside the app's
own process, which the system launches in the background if it isn't already
running. That gives two worlds, and the capture path handles both:

- **App alive** — `AppModel.current` (a weak static hook set in the model's
  init) has open store contexts, so the op goes through the normal
  `AppModel.enqueue`: local cache, pending queue, sync engine, and widget
  snapshot all see it exactly as they would from a tap.
- **Cold background launch** — the App struct is constructed, but `bootstrap()`
  never runs (it's driven by a `.task` on a view, and no scene connects), so
  there are no store contexts. The capture path then opens the target store's
  `LocalStore` itself and hands it to a `SyncEngine` wired to a client that
  refuses every request. `enqueue` still does its usual apply-locally +
  append-to-`pending-ops.json` — the queue file is never written by anything
  but PhrenKit's own code — while the flush it schedules fails instantly and
  leaves the op queued for the next foreground sync.

Capture never requires the network and never reads the Keychain, which is what
lets `authenticationPolicy = .alwaysAllowed` be safe enough to accept: someone
holding a locked phone can dictate a task into the queue, but nothing is read
back, nothing is deleted, and the GitHub token is never touched. The local
files are protected until the first unlock after boot, so a capture attempted
before the phone has ever been unlocked will fail.

## Multiple stores

Settings → Stores → **Add store** attaches any additional repo (personal +
team stores). Each store gets its own local cache, sync engine, and pending-op
queue; the tabs show a **merged view** with store badges and a store filter,
and every mutation routes to the store its item came from.

Semantics, and where they intentionally diverge from the CLI:

- The CLI's cross-store merge is name-keyed and primary-wins — a project that
  exists in two stores silently shows only the first copy. The app keys by
  *(store, project)* and shows both, disambiguated by store badge. No data is
  hidden.
- Stores are never *discovered* from `stores.yaml` — the CLI's registry holds
  local filesystem paths and unnormalized (often SSH) remotes, neither of
  which is actionable on a phone. You add each repo explicitly via the picker.
  The app does read the file, from whichever attached store carries it, for
  the two things it can act on: claim badges and store roles.
- Writes work the same in every store; repos where your token lacks push
  permission are marked **read-only**.
- Removing a store in Settings deletes only this device's local copy.

### Team stores

A store with `role: team` does not line-splice `FINDINGS.md` when a finding is
added. The CLI appends to `<project>/journal/YYYY-MM-DD-<actor>.md` and returns
without touching `FINDINGS.md` (`tools/finding.ts` → `finding/journal.ts`), so
two people capturing findings the same afternoon write two different files and
git merges them instead of conflicting on adjacent lines in one. The app
follows the same rule in both directions:

- `journal/*.md` is in the hot tier and merges into the project's findings, so
  a project whose whole history lives there is no longer invisible. Entries are
  attributed to the actor in the filename and searchable like any other live
  finding.
- Adds (and note promotions) append to *this device's* file for today, byte-
  identical to `appendTeamJournal` — pinned by `JournalFileTests` against
  fixtures the real CLI wrote. Another actor's file is never rewritten.
- Journal entries have no edit or delete: `edit_finding`/`remove_finding`
  splice `FINDINGS.md` in every store (only the add path forks), so the
  controls could only offer a refusal. The log is append-only on both sides —
  nothing rewrites a journal line in place.
- A store's role comes from its own `.phren-team.yaml` first, then from a
  `stores.yaml` entry matching its name. Both are hot-tier files. A role
  nothing declares is left alone rather than guessed: journalling a personal
  store would write files the CLI never compacts.

Legacy single-store installs migrate automatically on first launch.

## Your store must be on GitHub

The app reads the repo that holds your `~/.phren` store. If yours is still
local-only, wire it up from your computer:

```bash
phren team init          # or: phren store add --remote <url>
```

The repo picker probes your recently pushed repos for `phren.root.yaml` and
lists matches under "Phren stores".

## Fixtures

Parser tests run against files generated by the actual CLI:

```bash
pnpm --filter @phren/cli build
node apps/ios/scripts/generate-fixtures.mjs   # regenerates PhrenKit/Tests/PhrenKitTests/Fixtures/
```

Regenerate after any CLI format change; a failing PhrenKit test then flags
exactly which transcription needs updating.

## Not in the MVP

- Editing or retracting a journal entry (the CLI can't either — its lifecycle
  tools address `FINDINGS.md`, and folding a journal into it has no command
  yet, only `materializeTeamFindings` in `finding/journal.ts`)
- `stores.yaml` auto-discovery as an add-store suggestion source
- Hook configuration from the phone

### Coordinated session loading and command suggestions

The Agents overview waits for each computer's first response before revealing its
sections together. An eight-second ceiling keeps an unreachable computer from
blocking the page; pending computers stay labeled Connecting. Returning to cached
sessions avoids a loading flash. Subsequent updates remain independent per host.

Slash suggestions appear vertically above the chat composer, with a command name
and description on each row. The list scrolls within a compact panel. Selecting
a suggestion fills the draft, including a space for arguments, without sending it.
All commands still opens the exact agent's live terminal menu for installed skills
and extension commands.

# Performance Tuning Guide

Practical guide to keeping phren fast as your knowledge base grows.

## 1. Index Performance

### 3-Tier Caching System

The FTS5 index uses three layers of caching to avoid unnecessary rebuilds:

| Tier | Mechanism | What it skips |
|------|-----------|---------------|
| **Sentinel** | `index-sentinel.json` in `.runtime/` stores a hash + timestamp. If no project directory has been modified since the sentinel was written, the entire glob + hash step is skipped. | File discovery, hashing |
| **File hashes** | Per-file content hashes persisted across runs. On cache hit, only files whose hash changed are re-indexed (incremental update). If >20% of tracked files are missing, a full rebuild is forced instead. | Parsing unchanged files |
| **DB cache** | The SQLite FTS5 database is cached to `$TMPDIR/phren-fts-<uid>/<hash>.db`. A sentinel-hit with a valid DB file returns immediately without touching any project files. | Everything |

### When Full Rebuilds Happen

- First run after install (no cache exists)
- Schema version bump (internal `INDEX_SCHEMA_VERSION` changes between releases)
- More than 20% of previously-indexed files are deleted
- Cached DB file is missing or empty (e.g. `/tmp` was cleaned)

### Slow Filesystem Warning

```
PHREN_SLOW_FS_WARN_MS=3000
```

If any index build or filesystem operation exceeds this threshold, a warning is logged. Lower it on fast NVMe storage to catch regressions; raise it on network-mounted home directories.

## 2. Finding Management at Scale

### Caps

| Variable | Default | Purpose |
|----------|---------|---------|
| `PHREN_FINDINGS_CAP` | `20` | Max findings per date section before consolidation triggers |
| `PHREN_CONSOLIDATION_CAP` | `150` | Max total findings before forced consolidation |

### How Consolidation Works

1. Old entries are archived into `<details>` blocks in FINDINGS.md.
2. A `<!-- consolidated: YYYY-MM-DD -->` marker is written after each consolidation pass.
3. The hook-prompt detects when 25+ entries exist after the last marker (or 60 days + 10 entries) and fires a one-time notice.

### Impact on Search

Archived content inside `<details>` and `<!-- phren:archive:start/end -->` blocks is **stripped before FTS5 indexing**. This keeps the index lean and prevents stale findings from polluting search results. The raw text is still in FINDINGS.md if you need it.

## 3. Context Injection Tuning

These variables control how much memory context the `hook-prompt` injects into each prompt:

| Variable | Default | Range | Effect |
|----------|---------|-------|--------|
| `PHREN_CONTEXT_TOKEN_BUDGET` | `550` | 180 -- 10000 | Token budget per hook-prompt search. Higher values inject more context but add latency. |
| `PHREN_CONTEXT_SNIPPET_LINES` | `6` | 2 -- 100 | Max lines per injected snippet. |
| `PHREN_CONTEXT_SNIPPET_CHARS` | `520` | 120 -- 10000 | Max characters per snippet. |
| `PHREN_MAX_INJECT_TOKENS` | `2000` | 200 -- 20000 | Hard cap on total injected tokens across all content in a single prompt. |

### Latency Trade-offs

The hook-prompt runs on every `UserPromptSubmit`. Larger budgets mean more FTS5 results to rank and more text to inject, which adds milliseconds to each prompt cycle. The hook itself has a timeout controlled by:

```
PHREN_HOOK_TIMEOUT_MS=14000   # 14 seconds, applies to all hook subprocesses
```

If context injection is slow, lower `PHREN_CONTEXT_TOKEN_BUDGET` first -- it has the largest impact.

## 4. Concurrency and Locking

### File Locks

All read-modify-write operations on FINDINGS.md and other shared files are wrapped in file locks:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PHREN_FILE_LOCK_MAX_WAIT_MS` | `5000` | Max time to wait for a lock before aborting |
| `PHREN_FILE_LOCK_POLL_MS` | `100` | How often to poll for lock release |
| `PHREN_FILE_LOCK_STALE_MS` | `30000` | Age after which a lock is considered stale (owner PID is checked before force-release) |

### Write Queue

The MCP server serializes all write operations through a single async queue:

- **Max depth**: 50 concurrent pending writes
- **Timeout**: 30 seconds per write operation
- Exceeding depth returns a `Write queue full` error -- the caller should retry

Under heavy concurrent agent load (multiple agents hitting the same phren instance), contention shows up as lock timeouts in `.runtime/debug.log`. Increase `PHREN_FILE_LOCK_MAX_WAIT_MS` if you see these.

## 5. Recommended Profiles

### Small (<1K findings)

Defaults work well. No tuning needed.

```bash
# Just verify health periodically
phren doctor
```

### Medium (1--10K findings)

Consolidation becomes important. Tighten caps and run maintenance regularly.

```bash
export PHREN_FINDINGS_CAP=15
export PHREN_CONSOLIDATION_CAP=100
export PHREN_CONTEXT_TOKEN_BUDGET=400
export PHREN_FILE_LOCK_MAX_WAIT_MS=8000
```

Run consolidation proactively:

```bash
phren maintain consolidate
phren maintain prune
```

### Large (10K+ findings)

Aggressive consolidation, larger lock timeouts, and reduced injection budgets.

```bash
export PHREN_FINDINGS_CAP=10
export PHREN_CONSOLIDATION_CAP=75
export PHREN_CONTEXT_TOKEN_BUDGET=300
export PHREN_MAX_INJECT_TOKENS=1200
export PHREN_FILE_LOCK_MAX_WAIT_MS=15000
export PHREN_FILE_LOCK_STALE_MS=60000
export PHREN_SLOW_FS_WARN_MS=5000
```

Schedule regular maintenance:

```bash
phren maintain consolidate   # deduplicate and archive
phren maintain prune         # delete expired entries
phren maintain govern        # queue stale items for review
```

Consider archiving inactive projects with `phren projects configure <name> --ownership=detached` to remove them from the index entirely.

## 6. Monitoring

### Runtime Files to Watch

All diagnostic files live in `~/.phren/.runtime/`:

| File | What to look for |
|------|-----------------|
| `debug.log` | Lock timeouts, index rebuild failures, write queue errors (requires `PHREN_DEBUG=1`) |
| `audit.log` | Governance events, policy violations, access control decisions |
| `index-events.jsonl` | Index build times and cache hit/miss rates |
| `index-sentinel.json` | Last index hash and timestamp -- stale sentinel means repeated full rebuilds |
| `telemetry.json` | Tool call counts and timing (opt-in via `phren config telemetry on`) |
| `search-history.jsonl` | Recent search queries and result counts |

### Health Checks

```bash
phren doctor          # run all health checks, report issues
phren doctor --fix    # auto-fix what it can (stale locks, missing dirs, broken config)
phren doctor --agents # also check agent-specific hook wiring
```

### Debug Logging

Enable verbose logging to `.runtime/debug.log`:

```bash
export PHREN_DEBUG=1
```

This logs lock acquisition attempts, index cache decisions, write queue activity, and hook execution details. Output goes to both the debug log file and stderr. Disable in production -- it generates significant I/O.

## Phone path measurements (2026-09-21)

These are local Apple silicon host measurements, not iPhone frame times. The
Hook benchmark invokes the real HTTP handler with 24 distinct Codex panes,
5,000 transcript rows per pane and a 500-symbol code index. Herdr IPC and remote
account services are fixtures; transcript files, indexes, response encoding and
account-cache logic are real. Unix socket listeners were denied, so the
standalone bridge harness could not provide end-to-end route timings. Each
route has one cold call and ten warm calls. The table uses paired runs and the
upper middle warm sample, in milliseconds.

| Route | Before cold | After cold | Before warm | After warm |
|---|---:|---:|---:|---:|
| `/v1/health` | 54.54 | 26.75 | 0.14 | 0.05 |
| `/v1/workspaces`, 24 panes | 197.50 | 334.38 | 33.18 | 8.27 |
| `/v1/transcripts/history`, before line 4,500 | 3.24 | 2.67 | 2.29 | 1.45 |
| `/v1/subagents`, no children | 2.03 | 0.86 | 0.41 | 0.47 |
| `/v1/usage`, fixture account services | 0.37 | 0.61 | 0.05 | 0.05 |
| `/v1/code/search`, 500 matching symbols, limit 20 | 76.39 | 14.15 | 53.15 | 3.02 |

Health, history, subagents and usage are controls, not claimed improvements.
Host load varied substantially across runs, and cold overview latency did not
improve consistently. An earlier pair measured overview 39.91 to 23.17 ms and
search 75.80 to 3.54 ms, supporting the warm-path improvements. The usage row excludes real account
service latency and cannot establish how quickly quota providers answer.

**Code search:** warm latency fell from 53.15 to 3.02 ms. In
`packages/code/src/query.ts`, the correlated `bm25` query repeated FTS scoring
for each candidate. Scores now come from one result-set scan. Exact-name,
prefix, score, usage and locale-aware tie ordering stay intact. The route
benchmark and a comparison against the previous correlated scores guard this
change. Applying LIMIT before ranking was rejected because it can omit the
best result or change Unicode tie ordering.

**Workspace overview:** warm latency fell from 33.18 to 8.27 ms. In
`packages/cli/src/bridge/server-routes.ts`, four workers enrich tabs concurrently and a
single pane grouping replaces repeated scans. Response order and target
identity remain unchanged. A deterministic test checks four concurrent branch
lookups, row order, target identity and current steps; route timing has a
generous two-second bound for contended CI. Existing transcript metadata,
context, model, step and child caches remain responsible for freshness.

**Graph download and compilation:** the iOS IIFE fell from 1,999,839 to
1,409,042 bytes (29.5%). `apps/ios/scripts/bundle-graph.mjs` replaces only the
unused `three/webgpu` import with `browser/graph/webgl-only.ts`. The app already
uses WebGL and its bloom composer. The replacement deliberately throws if a
future caller requests WebGPU. A 1,500,000-byte ceiling builds the real app
entrypoint and checks that WebGPU is absent while WebGL remains. Twenty paired
V8 compilation samples gave medians of 42.44 and 21.56 ms. This is a JS
compilation proxy, not Safari or WKWebView first paint. The terminal graph
survey passed before and after; browser rendering tests were blocked by socket
permissions.

**Heavy transcript decoding:** the 1,507,206-byte page fell from 122.32 to
29.71 ms in paired ten-iteration Swift debug runs. In PhrenKit's `AgentChat.swift`,
message text now gets contiguous UTF-8 storage before Character-based
truncation. This avoids repeated NSString bridging while preserving the
64,000-grapheme limit. XCTest measures cover the full decoder and isolated
text preparation; boundary tests include combining marks and family emoji.

**Phone decoding:** workspace envelope validation and Codable decoding now
share one parse in `LiveWorkspaces.read(..., requiringHook: true)` and
`PhrenConnection.fetch`. Thirty paired iterations on a 240-tab, 47,176-byte
response measured 2.06 ms before and 1.58 ms after. The product and protocol
checks, one-MiB bound, duplicate-ID checks and target checks still apply.
See [phone performance](../apps/ios/design/performance.md) for transcript
preparation measurements, decoder fixtures and device-only gaps.

### Rules that keep the phone path fast

- Measure cold and unchanged warm responses separately. Do not attribute
  mocked IPC, quota calls or host timings to real network or device latency.
- Bound work across panes and keep identity validation on each request.
  Preserve file identity, size and modification checks when caching content.
- Keep transcript history on the shared sparse byte-offset index. It already
  reads bounded pages rather than decoding the whole transcript each poll.
- Score search candidates once, then preserve the documented ordering before
  limiting. Do not cache a live database without an invalidation contract.
- Keep the iOS graph on one graphics backend. Any WebGPU adoption must remove
  the explicit build replacement and revisit the bundle ceiling.
- Run `phone-performance.test.ts`, code query tests, graph size checks and
  PhrenKit XCTest measures when changing these paths. Device frame and SSH
  timing marks must accompany claims about perceived phone latency.

The baseline and command logs for this round live in `.scratch/`. CLI build
and lint passed, as did 68 focused Vitest tests. The full bridge run had 374
passing tests, 16 failures, 67 skips and two unhandled socket errors. Most
failures require socket permission; the shell-change timing fixture passed
in isolation, while an untouched secret-redaction fixture still failed.
PhrenKit and PhrenLive results and the blocked iOS build are detailed in the
phone report. This round does not claim a clean full-platform gate.

## Baseline 2026-09-22

The numbers the Phase 2 optimization work is judged against. Nothing was
optimized in this round; it added the counters and the harnesses.

### Hook

**Method.** `GET /v1/metrics` counts Herdr RPCs by method (every `rpc()`
call, failed ones included), identity work (`lsof`/`proc` are process scans,
`probe` a cache miss, `cached` a hit inside `PHREN_IDENTITY_CACHE_MS`,
`reported` a pane whose agent reported its own session id so nothing was
scanned), git child processes by caller and timer ticks by name.
`scripts/bench-hook.mjs` reads it before and after each five-minute scenario
and samples the Hook's cumulative CPU time and RSS with `ps` every 5 s. CPU %
is CPU time over wall time (100 = one core).

The owner's installed Hook was not touched. A second Hook ran from this
round's build with its own `PHREN_BRIDGE_HOME` and an empty temporary
`PHREN_PATH` (modules memory, tasks, hook, git), the real
`PHREN_HERDR_HOME` and the real home, so it read the same live Herdr panes
and transcripts while its schedules, fan-outs, approvals and sockets stayed
separate. Nobody else connected to it, so "idle" is the Hook's own timers.
The chat scenario streamed one live Claude conversation read-only; the
overview scenario polled `GET /v1/workspaces?watchApprovals=1` every 3 s as
the phone does. At the time the default Herdr server had three agent panes,
all reporting their session ids; `ping` goes to each Herdr server directory
found (five). Apple M4, 10 cores.

| Per minute | idle | chat stream | overview every 3 s |
|---|---:|---:|---:|
| Herdr calls, all | 72 | 275.8 | 151.8 |
| `ping` | 60 | 60 | 60 |
| `session.snapshot` | 12 | 131.6 | 31.8 |
| `agent.read` | 0 | 84.2 | 0 |
| `pane.process_info` | 0 | 0 | 60 |
| Identity scans (`lsof`/`proc`) | 0 | 0 | 0 |
| Identity `reported` | 0 | 119.6 | 60 |
| Git spawns (`branch`) | 0 | 0 | 15 |
| Timer `activity` | 12 | 12 | 12 |
| Timer `fanout-messages` | 60 | 59.8 | 60 |
| Timer `opencode-approvals` | 30 | 30 | 29.8 |
| Timer `fanout-blocked` | 12 | 12 | 12 |
| Timer `stream-transcripts` | 0 | 119.6 | 0 |
| CPU % of one core | 0.2 | 0.5 | 0.7 |
| RSS MiB, mean / max | 85.6 / 86.5 | 86.8 / 115.8 | 95.5 / 140.3 |
| Load average, start / end | 3.86 / 4.59 | 4.38 / 9.87 | 13.46 / 3.13 |

Idle and overview are the second run (19:35 to 19:46 local); chat is the
first run (19:24 to 19:30). The first run's overview window overlapped other
workers' builds (load 14 to 21) and gave the same counts with 1.0 % CPU and
a 185.8 MiB RSS peak; the first run's idle window (load 4.0 to 3.5) gave the
same counts, 0.2 % CPU and 103.7 / 134.7 MiB RSS, still holding memory
from a short smoke run's chat stream just before it. The chat stream received 6 frames (92 KB) in five minutes;
overview polls took 174 ms on average.

What the counts say, for the work that follows:

- A chat stream ticks every 500 ms, and every tick takes a full
  `session.snapshot` to revalidate the target, about two a second per open
  chat, plus `agent.read` for the live preview.
- An overview poll costs one snapshot, one `pane.process_info` per agent pane
  (even when the agent reported its session id) and a `git branch` per agent
  cwd whenever the 10 s branch cache has expired.
- Idle, the activity timer pings every Herdr server directory every 5 s.

**Caveats.** The bench Hook ran at normal priority (the installed service runs
at Nice -5) and had no phone or agent lifecycle traffic, so these are
lower bounds for a Hook with clients. Counts are deterministic; CPU and RSS
move with host load. Git spawns count only the Hook's own call sites in
`packages/cli/src/bridge`. Reproduce with a Hook built from this tree:

```bash
node scripts/bench-hook.mjs --socket <bridge-home>/hook.sock --minutes 5
```

### Phone

**Method.** `PhrenUITests/PerformanceBaselineTests`, opt-in with
`TEST_RUNNER_PHREN_RUN_PERF=1`, on the iPhone 17 Pro simulator with a debug
build, run serially under the shared iOS build lock. Each test prints
`PHREN_PERF` wall-clock lines and wraps the measured step in `measure` with
`XCTClockMetric` and `XCTCPUMetric(application:)`, five recorded iterations
after a warm-up. Load average 3.65 at the start and 5.99 at the end
(the build before the tests ran raised the 5-minute average to 9.97).

| Measurement | Clock, s (mean, RSD) | App CPU time, s | App CPU cycles, kC | Instructions, kI |
|---|---:|---:|---:|---:|
| Open heavy chat (`--chat-heavy`), tap row to last message shown | 1.579 (0.5 %) | 0.607 | 2,124,483 | 6,244,667 |
| Heavy chat, 3 swipes down into history then 3 back up | 16.364 (0.7 %) | 4.739 | 13,871,375 | 28,477,638 |
| Open Agents with `--all-sessions-fixture`, tap tab to first card | 1.449 (0.8 %) | 0.222 | 732,039 | 1,778,576 |

The first, cold opens took 1.640 s (chat) and 1.707 s (Agents). The
wall-clock split of the swipes was 8.3 s down and 8.3 s up.

**Caveats.** Clock time includes XCUITest's event synthesis and its wait for
the app to go idle after every tap and swipe, so it is a UI test time, not a
frame time; compare runs with each other, not with a device. App CPU time,
cycles and instructions are the app process alone and are the better signal
for rendering work: the six swipes keep the app busy for 4.7 s of CPU.

## After 2a, 2026-09-22 (Hook polling)

**Method.** The baseline's bench and scenarios, five minutes each, with two
Hooks running side by side so both saw the same Herdr panes, the same live
chat and the same host load: the baseline build and this round's build, each
with its own temporary `PHREN_BRIDGE_HOME` and empty `PHREN_PATH`, neither of
them the owner's installed Hook. The default Herdr server had three Claude
panes, all reporting their session ids; five server directories. Load
average 3.94 at the start and 4.51 at the end (it reached 20.9 during the
chat window from other builds). A second four-minute run of this round's
final build (overview, then chat; load 4.54 to 3.21) gave the same counts.

| Per minute | idle before | idle after | chat before | chat after | overview before | overview after |
|---|---:|---:|---:|---:|---:|---:|
| Herdr calls, all | 72 | 22 | 277.2 | 129 | 151.8 | 29.8 |
| `ping` | 60 | 10 | 60 | 10 | 60 | 10 |
| `session.snapshot` | 12 | 12 | 131.6 | 20 | 31.8 | 19.8 |
| `agent.read` | 0 | 0 | 85.6 | 99 | 0 | 0 |
| `pane.process_info` | 0 | 0 | 0 | 0 | 60 | 0 |
| Identity `reported` | 0 | 0 | 119.6 | 20 | 60 | 60 |
| Git spawns (`branch`) | 0 | 0 | 0 | 0 | 15 | 0.6 |
| CPU % of one core | 0.2 | 0.1 | 0.6 | 0.4 | 0.9 | 0.8 |
| RSS MiB, mean / max | 77.9 / 197 | 52.6 / 80.4 | 91.7 / 143.5 | 105.2 / 186.6 | 116.1 / 169.5 | 99.4 / 155.2 |

Overview polls took 173 ms on average before and 70 ms after (123 ms in the
second run). Timer ticks are unchanged; the opencode sweep ran no times in
any window after (the poll found no opencode pane in the held snapshots).

What changed:

- **Shared snapshot.** Chat and status streams revalidate against one
  `session.snapshot` per Herdr server shared for `PHREN_SNAPSHOT_SHARE_MS`
  (2.5 s), joined while in flight and never kept on failure; identities are
  resolved once per shared snapshot. A pane that disappears or changes
  conversation closes the stream within 2.5 s plus one tick, where it was one
  tick. Sends, keys, launches and the overview take a fresh snapshot, and
  every fresh one refreshes the shared copy. With one chat open: 131.6 to 20
  a minute (6.6x); more chats add none.
- **Probe skip.** The overview asks `pane.process_info` only for a pane whose
  agent does not report its session id, and `paneChatState` reads a pane's
  PIDs once instead of twice.
- **Server list.** The activity timer reuses the running-server list for
  30 s (`PHREN_SERVER_LIST_REUSE_MS`) and reuses a snapshot another reader
  took in the last 4 s: `ping` 60 to 10 a minute (6x).
- **Branch.** Past its ten seconds a cached branch is kept while the
  repository's HEAD file reads the same, up to five minutes: 15 to 0.6 git
  spawns a minute during overview.
- **OpenCode sweep.** Request files are read asynchronously, and the 2 s
  backup poll skips while nothing is held, the watcher is alive and the held
  snapshots show no opencode pane.
- **Periodic pull** (MCP server, not the Hook). The remote check already ran
  once per configured interval; the 5 s tick that notices other clients'
  pulls read HEAD twice per store and now reads it once unless a check ran.

**Not met.** `agent.read` did not fall: the live preview still reads the
pane at most twice a second while Herdr reports the agent working, and never
on a status-only stream, but that status now comes from a snapshot up to
2.5 s old, so a turn's reads can run up to 2.5 s past its end. The 85.6 to 99
difference is that tail plus tick timing, not a new reader.

## Preview stops at the transcript's turn end, 2026-09-22

**Change.** The live preview stops reading the pane as soon as the
transcript says the turn is over (a Claude assistant entry with
`stop_reason: "end_turn"` or a `turn_duration` system record; a Codex
`task_complete`, which stops its delta reads), even while the shared
snapshot still says working, and resumes on the next user prompt (Codex:
the next `task_started`).

**Method.** Two Hooks side by side, neither the owner's installed one: the
build before this change and this build, each with its own temporary
`PHREN_BRIDGE_HOME` and an empty temporary `PHREN_PATH` (modules memory,
tasks, hook, git), the real `PHREN_HERDR_HOME` and home. Both streamed the
same live Claude conversation read-only for five minutes at the same time:

```bash
node scripts/bench-hook.mjs --socket <bridge-home>/hook.sock --minutes 5 \
  --scenarios chat --target default,<workspace>,<tab>,<pane>,claude,<session>
```

The conversation was an orchestrating session whose turns end often while
Herdr keeps reporting it working. `--target` now also takes commas, since
Herdr tab and pane ids contain a colon. Load average 11.8 to 6.1 (first run)
and 4.9 to 15.4 (second).

| Per minute, chat stream | before | after |
|---|---:|---:|
| `agent.read`, first run | 100.6 | 14 |
| `agent.read`, second run | 99.2 | 37 |
| `session.snapshot` | 20.4 / 20.8 | 20.2 / 20.8 |
| Frames received in 5 min | 23 / 19 | 22 / 21 |

The remaining reads are the turns still running. How much this saves
depends on how long a pane keeps reporting working after its transcript
ended the turn; on a session that works without pause it saves only the
tail of each turn.

## After 2b, 2026-09-23 (phone)

**Method.** `PhrenUITests/PerformanceBaselineTests` on the iPhone 17 Pro
simulator, debug build, `PHREN_PERFORMANCE_LOG=1`, serially. Before is
main at `4abb855c`; the counter rows were taken on the same code with only
the counters added (`34fd7e35`). The timed tests are unchanged from the
baseline above. The new `...Work` tests read `PerformanceCounters` (PhrenKit)
through a one-point accessibility probe that computes its value when XCUITest
reads it, so the probe adds no redraws. They print `PHREN_COUNT` lines: the
change over a 10 s idle window (60 s with `TEST_RUNNER_PHREN_PERF_IDLE_SECONDS=60`)
or over three swipes down and three up. `ScrollHitchProbe` runs a display link
only while the chat's scroll phase is not idle and counts frames that arrived
more than half a frame late, and the time past their deadline. Load average
was 12 to 23 for the before timings, 98 falling to 16 for the after timings
(other workers were building), and 3 to 18 for the counters.

| Timed (mean of 5) | Clock s, before | after | App CPU s, before | after | Instructions kI, before | after |
|---|---:|---:|---:|---:|---:|---:|
| Open heavy chat | 1.663 | 1.711 | 0.664 | 0.570 | 7,100,260 | 5,800,512 |
| Heavy chat, 3 swipes down and 3 up | 15.702 | 16.162 | 4.689 | 4.439 | 33,206,028 | 26,047,432 |
| Open Agents, all-sessions fixture | 1.499 | 1.469 | 0.456 | 0.246 | 3,297,285 | 1,799,525 |

| Heavy chat, six swipes | before | after |
|---|---:|---:|
| Chat screen bodies | 41 | 0 |
| Transcript rows bodies | 10 | 6 |
| Preference reads | 662 | 0 |
| Code lines colored | 161 | 0 |
| Hitches | 39 | 8 (8 in a second run) |
| Hitch time, ms | 860 | 208 (177) |
| Frames drawn while moving | 836 | 877 (839) |
| Touch-down to rest, per swipe, ms | 2,500 | 2,502 (2,395) |

**Swipe target not met, and why.** The plan asked for a heavy-fixture swipe
under 0.5 s, from 2.5 s. The 2.5 s is how long the transcript keeps moving:
XCUITest's swipe is a fling, and UIScrollView decelerates for about 2.3 s
after it (about 146 frames per swipe, drawn the whole time). The app is not
busy for those seconds and no rendering change shortens them; changing the
deceleration would change how scrolling feels. What rendering controls is
the frames it misses while moving: hitch time fell from 860 to 208 ms over
six swipes (57 to 14 ms per second of scrolling; Apple treats under 10 as
smooth), with no chat screen redraws and no preference reads. The remaining
CPU (4.4 s) is mostly laying out and drawing the non-lazy transcript as it
moves, plus XCUITest's accessibility snapshots of it between steps.

| Idle, per second (10 s windows) | Agents before | after | Computer page before | after | Heavy chat before | after |
|---|---:|---:|---:|---:|---:|---:|
| Clock ticks and timeline redraws | 2.2 | 0 | 7.0 | 0 | 6.8 | 0 |
| Chat screen bodies | | | | | 4.2 | 0 |
| Preference reads | 0.6 | 0 | 0.6 | 0 | 67.5 | 0 |
| Code lines colored | | | | | 8.8 | 0 |

The heavy chat's idle redraws were the chat screen re-running its body four
times a second (it read about 40 model fields, and the fixture's stream
touched some of them), each body reading preferences about 16 times, and
the computer page underneath still ticking its cards.

| Reads of the Hook, per minute | before | after |
|---|---:|---:|
| Agents, 2 computers: overview | 12 | 0 streamed (6 heartbeat frames), 12 polled on an older Hook |
| Agents, 4 cards: sub-agent trees (2 requests each) | 24 | 8 |
| Computer page, 1 computer: overview | 12 | 6 |
| Computer page, 3 cards: sub-agent trees | 18 | 6 |
| Heavy chat: pane list | 24 | 4 |

Before is the 10 s window's count times six; after is a 60 s window. The
computer page read its computer twice because it ran a monitor of its own
beside the overview's.

**Loops.** Before, 14 loops polled the Hook: the overview per computer
(10 s), the chat's pane list (3 s), project sessions (10 s, every computer
again), each session card's sub-agents (10 s), each drawer row's sub-agents
(10 s), session details' sub-agents (10 s), Herdr workspaces (3 s, the
overview again) and its panes (3 s), web servers (15 s), a simulator screen
(1 to 4 s), account usage rings (60 s) and screen (30 s), a worker's messages
(2 s) and reminders (30 s). After, three loops read the Hook:

1. The overview, per computer: the Hook's `/v1/overview` stream, with a 10 s
   poll only while the stream is down or the Hook predates it. Agents, a
   computer's page, session details, project sessions and Herdr workspaces
   all read it; a Herdr tab's panes are read when its overview row changes.
2. The chat's pane list, per open chat: 15 s while the transcript and status
   streams are both live (they carry activity, prompts and a closed pane),
   3 s otherwise and 2 s while a session starts.
3. `LiveRefresh`: one timer that sleeps until the next job is due, for what
   the Hook does not push: account usage, web servers, a simulator screen,
   sub-agent trees (one read per session for its card, drawer row and
   details, every 10 s while it has running children or conducts, else 30 s),
   a worker's messages and scheduled-prompt reminders. Jobs with one key
   share a run; a job never overlaps itself.

What remains outside them: GitHub store sync (`SyncEngine`, 7 s, not the
Hook), the 3 s approval check that runs only inside a background lease of at
most 150 s, the chat's transcript and status WebSockets, and `AppClock`, a
1 s clock that runs only while an elapsed-time label is on screen. Account
usage's 30 s and the stalled-history notice's 60 s timelines were left.

**Hook side.** The stream takes no Herdr snapshots of its own: it reads the
shared one at most one tick (5 s) old, which the activity timer refreshes
every 5 s. It rebuilds the overview (branches, context, models, steps) when
that snapshot changed or every 10 s, the cadence phones polled at, and sends
nothing when the rows are unchanged. `bench-hook.mjs` was not rerun for this
round.

**Code viewer.** `CodeTextView` colored every line of the file in its body.
It now builds rows lazily, splits the file once per distinct text, and colors
through a cache keyed by language and text (also used by diffs, chat code
fences and the text file viewer). A 2,000-line Swift file: coloring every line
took 61.3 ms per render before; the first render now colors 49 lines and a
second render none (`CodeHighlightingTests`, debug simulator).

**Preferences.** Twenty-five screens read `sessions.live.preferences.v1`
through `@AppStorage` and `LiveSessionPreferences.read` in computed
properties. All views now read `LiveSessionPreferencesStore`, decoded once
per change of the stored bytes; only event-time code (intents, widget,
notification handlers) reads defaults directly.

### Rules that keep the phone fast

- A view body reads no preference JSON. Use `LiveSessionPreferencesStore`.
- Only `ClockText` (and `SessionRelativeTimeLabel`) reads `AppClock`. Do not
  add a `TimelineView` or `Timer` for a state that changes on an event;
  publish the state when it changes, as `LiveHostMonitor.fresh` does.
- A screen does not start its own poll loop. Read the overview from
  `SessionOverviewMonitor.shared`, and put any other periodic read in
  `LiveRefresh` with a key other screens can share.
- `AgentChatView.body` reads no model field. A new chat view takes the
  sub-model it draws (`timelineState`, `composer`, `connection`, `outbox`)
  and a new side effect goes in `ChatModelObservers`. Assign a model field
  only when its value changed.
- Color code through `CodeHighlighting`, whose cache makes a repeat free.
- Run `PerformanceBaselineTests` with `TEST_RUNNER_PHREN_RUN_PERF=1` before
  and after a change to these paths and compare the `PHREN_COUNT` lines.

## CLI test suite, 2026-09-23

`npx vitest run packages/cli` on the Mac mini (10 cores), 263 files and 3,930
cases, after `pnpm build`:

| | Wall | Slowest file |
|---|---|---|
| Before | 75.2 s | `bridge/bridge.test.ts`, 73.3 s |
| After | 49.4 s | `bridge/bridge.2.test.ts`, 31.8 s |

`bridge.test.ts` (124 cases, most of them starting or talking to a real Hook)
and `cli.test.ts` (156 cases that spawn the CLI) ran start to finish in one
worker each, so the suite could not end before them. Their cases now live in
`bridge/bridge.suite.ts` and `cli.suite.ts`, and small entry files run one
shard each (`bridge.test.ts`, `bridge.2.test.ts`, `bridge.3.test.ts`;
`cli.test.ts`, `cli.2.test.ts`). `test-shard.ts` keeps every count-th unit, a
unit being a case or a whole `describe` group, so a group's setup and case
order stay in one shard. A new case goes in the suite file; a group that must
appear in every shard (a shared fixture) is declared with `describeAll`.

The iOS graph bundle phase already runs only when an input changes
(`graph-inputs.xcfilelist`), and a run costs 0.34 s; `release.py` already
generates the project once per checkout.

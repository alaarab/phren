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

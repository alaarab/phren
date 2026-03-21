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

Consider archiving inactive projects with `phren projects configure <name> --ownership=archived` to remove them from the index entirely.

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

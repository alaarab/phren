# Fair Synthetic Benchmark Comparison

Run date: March 10, 2026 local time

These numbers come from fresh reruns in this workspace using the same synthetic corpus pattern. The Cortex run was executed from [`scripts/bench-retrieval-synthetic.ts`](/home/alaarab/cortex/scripts/bench-retrieval-synthetic.ts). The claude-mem run was executed from [`scripts/bench-claude-mem-synthetic.ts`](/home/alaarab/cortex/scripts/bench-claude-mem-synthetic.ts) against already-seeded local stores with `--skip-seed`.

Important caveats:

- These runs were not taken on an otherwise idle workstation, so absolute timings are still host-sensitive.
- The claude-mem rerun skipped SQLite reseeding, but it still incurred Chroma-side backfill/check work before the search path settled.
- This is an identifier-heavy coding-style corpus, not a paraphrase-heavy semantic benchmark.

| Size | Cortex lexical avg query | Cortex hybrid avg query | Cortex warm build | Cortex exact top hits | claude-mem avg query | claude-mem backfill | claude-mem exact top hits |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 5.19 ms | 4.08 ms | 29.50 ms | 12/12 | 221.07 ms | 4,061.58 ms | 0/8 |
| 10,000 | 13.20 ms | 13.29 ms | 243.94 ms | 12/12 | 147.91 ms | 25.11 ms | 0/8 |
| 100,000 | 91.63 ms | 87.95 ms | 2,256.15 ms | 12/12 | 225.11 ms | 3,837.71 ms | 0/8 |

Interpretation:

- Cortex remained much faster on this identifier-heavy synthetic corpus, and exact top-hit behavior stayed perfect across all three sizes.
- claude-mem did not need corpus reseeding on the rerun, but it still paid non-trivial Chroma preparation cost before search, especially at `1k` and `100k`.
- claude-mem kept returning results, but exact ranking stayed weak on these deterministic coding-style needles at every size.
- Cortex's hybrid-gated path stayed close to lexical because the corpus strongly favors exact lexical anchors and lexical rescue usually resolves the query before any semantic fallback matters.

Source files:

- Cortex rerun: [`docs/benchmark-synthetic-results-clean.json`](/home/alaarab/cortex/docs/benchmark-synthetic-results-clean.json)
- claude-mem rerun (`1k`, `10k`): [`docs/benchmark-claude-mem-synthetic-clean-small.json`](/home/alaarab/cortex/docs/benchmark-claude-mem-synthetic-clean-small.json)
- claude-mem rerun (`100k`): [`docs/benchmark-claude-mem-synthetic-clean-100000.json`](/home/alaarab/cortex/docs/benchmark-claude-mem-synthetic-clean-100000.json)

Reproduction notes:

- Persisted benchmark toolchain lives under `.benchmarks/tools/`.
- Persisted claude-mem stores live under `.benchmarks/runs/claude-bench-small` and `.benchmarks/runs/claude-bench-100k`.
- Clean claude-mem reruns should reuse those stores and skip SQLite reseeding:

```bash
/home/alaarab/cortex/.benchmarks/tools/bun/bun-linux-x64-baseline-profile/bun-profile \
  scripts/bench-claude-mem-synthetic.ts \
  --claude-mem-root /home/alaarab/cortex/.benchmarks/tools/claude-mem-src \
  --uvx-path /home/alaarab/cortex/.benchmarks/tools/uv/uv-0.10.9.data/scripts/uvx \
  --root-dir /home/alaarab/cortex/.benchmarks/runs/claude-bench-small \
  --sizes 1000,10000 \
  --skip-seed
```

```bash
/home/alaarab/cortex/.benchmarks/tools/bun/bun-linux-x64-baseline-profile/bun-profile \
  scripts/bench-claude-mem-synthetic.ts \
  --claude-mem-root /home/alaarab/cortex/.benchmarks/tools/claude-mem-src \
  --uvx-path /home/alaarab/cortex/.benchmarks/tools/uv/uv-0.10.9.data/scripts/uvx \
  --root-dir /home/alaarab/cortex/.benchmarks/runs/claude-bench-100k \
  --sizes 100000 \
  --skip-seed
```

- `--skip-seed` avoids rebuilding the SQLite corpus, but claude-mem still performs Chroma-side backfill/check work before the query path settles, so `backfillMs` is expected to remain non-zero.

# Fair Synthetic Benchmark Comparison

Run date: March 9, 2026 local time / March 10, 2026 UTC

These numbers come from fresh reruns in this workspace using the same synthetic corpus pattern and `8` deterministic queries per size. The Cortex run was executed from [`scripts/bench-retrieval-synthetic.ts`](/home/alaarab/cortex/scripts/bench-retrieval-synthetic.ts). The claude-mem run was executed from [`scripts/bench-claude-mem-synthetic.ts`](/home/alaarab/cortex/scripts/bench-claude-mem-synthetic.ts).

Important caveat: these runs were not taken on an otherwise idle workstation. Absolute timings are inflated by host load. The useful signal is the relative shape across the two systems under the same rough machine conditions.

| Size | Cortex lexical avg query | Cortex hybrid avg query | Cortex warm build | Cortex exact top hits | claude-mem avg query | claude-mem backfill | claude-mem exact top hits |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 6.28 ms | 5.26 ms | 32.99 ms | 8/8 | 579.29 ms | 58,407.22 ms | 2/8 |
| 10,000 | 14.93 ms | 13.88 ms | 258.50 ms | 8/8 | 416.65 ms | 325,952.92 ms | 0/8 |
| 100,000 | 88.14 ms | 85.90 ms | 2,127.30 ms | 8/8 | 414.13 ms | 198,871.20 ms | 0/8 |

Interpretation:

- Cortex remained much faster on this identifier-heavy synthetic corpus, both for warm query latency and for one-time index materialization.
- claude-mem kept all queries returning hits, but exact ranking was weak on these deterministic coding-style needles at every size and dropped to `0/8` at `10k` and `100k`.
- claude-mem's dominant operational cost was vector backfill, not the final query step.
- Cortex's hybrid-gated path stayed close to lexical because this corpus strongly favors exact lexical anchors.

Source files:

- Cortex rerun: [`docs/benchmark-synthetic-results-fair.json`](/home/alaarab/cortex/docs/benchmark-synthetic-results-fair.json)
- claude-mem rerun (`1k`, `10k`): [`docs/benchmark-claude-mem-synthetic-fair-small.json`](/home/alaarab/cortex/docs/benchmark-claude-mem-synthetic-fair-small.json)
- claude-mem rerun (`100k`): [`docs/benchmark-claude-mem-synthetic-100000.json`](/home/alaarab/cortex/docs/benchmark-claude-mem-synthetic-100000.json)

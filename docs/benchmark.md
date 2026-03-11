# Benchmark Protocol

This document describes the retrieval benchmark protocol for evaluating cortex's search behavior.

The important constraint: benchmark numbers only mean anything when the run conditions are published alongside them. If you do not state machine, dataset, cache state, and retrieval mode, treat the result as anecdotal.

## Query Types

The benchmark covers 5 query types, each testing a different aspect of the retrieval pipeline:

### 1. Temporal Queries
Queries that depend on time-based context: recent changes, historical decisions, sequence of events.

**Examples:**
- "What changed in the auth module last week?"
- "When was the database migration pattern decided?"
- "What were the most recent performance issues?"

### 2. Factual Queries
Direct lookups for specific facts, configurations, or technical details.

**Examples:**
- "What port does the dev server run on?"
- "Which ORM does the backend use?"
- "What is the minimum Node.js version required?"

### 3. Procedural Queries
How-to questions that require step-by-step or process knowledge.

**Examples:**
- "How do I deploy to production?"
- "What is the release process?"
- "How do I add a new API endpoint?"

### 4. Relational Queries
Questions about connections between concepts, components, or decisions.

**Examples:**
- "Which projects depend on the shared auth library?"
- "What components are affected by changing the database schema?"
- "How does the frontend connect to the API?"

### 5. Contradictory Queries
Queries where the project store contains conflicting or superseded information.

**Examples:**
- "Should we use REST or GraphQL?" (when both are mentioned with different recommendations)
- "Is the cache TTL 30 minutes or 1 hour?"
- "Which testing framework do we use?" (when a migration is in progress)

## Scoring Rubric

Each query result is scored on a 3-point scale:

| Score | Label | Description |
|-------|-------|-------------|
| 2 | Exact match | The top-3 results contain the specific answer or relevant document |
| 1 | Partial match | Related content is found but not the exact answer |
| 0 | No match | No relevant results in top-3 |

**Total score** = sum of all query scores. Maximum = 2 x number of queries.

## Running the Harness

```bash
# Build cortex first
cd ~cortex && npm run build

# Run the benchmark
npx tsx mcp/src/__tests__/benchmark/harness.ts

# Run the live retrieval latency/token benchmark
npm run bench:retrieval -- --cortex-path ~/.cortex

# Run the synthetic large-corpus retrieval benchmark
npm run bench:retrieval:synthetic -- --sizes 1000,10000

# Push to much larger synthetic corpora without touching ~/.cortex
npm run bench:retrieval:synthetic -- --sizes 10000,100000 --queries-per-size 16

# Or via vitest
npm test -- --testPathPattern benchmark
```

The harness outputs a markdown results table showing:
- Query text and type
- Top-3 result summaries
- Score per query
- Total score and percentage

The retrieval runner writes JSON with:
- lexical path latency and token stats
- gated semantic path latency and token stats
- hit and miss counts per mode
- semantic-only and lexical-only hit deltas
- persistent vector-index candidate counts
- per-query top-document summaries

The synthetic retrieval runner writes JSON with:
- cold and warm index-build time per corpus size
- lexical and hybrid retrieval latency per synthetic corpus size
- exact top-hit counts for deterministic generated queries
- generated corpus sizes without touching your real `~/.cortex`

## Published Conditions Template

Every benchmark run should publish:

- Machine hostname, platform, CPU architecture, and Node.js version
- Cortex version or git commit
- Dataset source: toy, LoCoMo-derived, or your own store
- Corpus size: sessions, findings, and projects indexed
- Retrieval mode: FTS5-only, shared rerank, or embeddings-enabled
- Cache state: cold start, warm process, or warm on-disk cache
- Whether a remote sync step was included in the timing

The bundled runners now emit a `conditions` block in their JSON output. If you publish numbers in docs or release notes, copy that block with the results.

## March 9, 2026 Author-Local Retrieval Runs

After the relaxed lexical rescue pass and the long-document overlap fix, the author-local run against the author's `~/.cortex` corpus (139 indexed docs, 10 real queries, Node `v24.13.0`) produced:

- lexical path: `15.93ms` average total latency, `11.91ms` p50, `16.25ms` p95
- gated semantic path: `12.90ms` average total latency, `11.59ms` p50, `16.52ms` p95
- lexical injected tokens: `341.8` average
- gated semantic injected tokens: `341.8` average
- hits: lexical `10/10`, gated semantic `10/10`
- semantic-only hits: `0`
- persistent vector candidate pruning: `8.7` average candidates out of `139` eligible docs (`6.3%` of the corpus)

The widened 16-query run on the same warm store produced:

- lexical path: `14.71ms` average total latency, `12.56ms` p50, `17.45ms` p95
- gated semantic path: `13.60ms` average total latency, `12.45ms` p50, `18.39ms` p95
- lexical injected tokens: `326.0` average
- gated semantic injected tokens: `326.0` average
- hits: lexical `16/16`, gated semantic `16/16`
- semantic-only hits: `0`
- persistent vector candidate pruning: `12.0` average candidates out of `139` eligible docs (`8.6%` of the corpus)

Interpretation:
- the two previously published miss cases now resolve on the live store
- the strengthened lexical path is now good enough on this corpus that the vector gate usually stays closed, so hybrid and lexical timings converge
- the vector index still changes worst-case scaling by shrinking the cosine stage to a small candidate set, but on a 139-doc corpus the cosine math is only about `0.06-0.07ms`; the expensive semantic step is still query embedding when it happens
- these numbers are evidence for this corpus and this query set, not proof that semantic recovery is obsolete everywhere

## Synthetic Large-Corpus Retrieval Runs

The live-store benchmark is useful for real workflow behavior, but it does not answer scaling questions cleanly because every personal cortex store has different shape and hygiene. For scaling work, use the synthetic benchmark:

- it creates a temporary cortex root under your temp directory
- it models each synthetic memory as its own markdown file so indexed document count scales with simulated memory count
- it measures both cold index build time and warm retrieval time
- it never reads or writes your real `~/.cortex` unless you explicitly point it there

Recommended sizes:

- `1000`: sanity check and local dev loop
- `10000`: meaningful medium-scale corpus
- `100000`: stress test for retrieval/index scaling; expect a much slower setup

### March 10, 2026 Synthetic Scaling Run

Checked-in source of truth: `docs/benchmark-synthetic-results.json`

Conditions:

- machine: `QL-PF5A48WS`
- Node: `v24.13.0`
- generator: `synthetic-markdown-memory-files/v1`
- query count: `8` deterministic exact-hit queries per corpus size
- corpus model: one synthetic memory per markdown file

Results:

- `1,000` memories: cold build `419.13ms`, warm build `42.49ms`, lexical retrieval `7.35ms` avg, hybrid retrieval `5.99ms` avg, exact top hits `8/8`
- `10,000` memories: cold build `2273.66ms`, warm build `265.25ms`, lexical retrieval `17.55ms` avg, hybrid retrieval `17.74ms` avg, exact top hits `8/8`
- `100,000` memories: cold build `25284.19ms`, warm build `2777.79ms`, lexical retrieval `113.09ms` avg, hybrid retrieval `110.18ms` avg, exact top hits `8/8`

Interpretation:

- warm retrieval remains comfortably sub-20ms through `10k` synthetic memories
- at `100k`, warm retrieval is still near `110-113ms`, which is noticeable but still practical for a local benchmark path
- warm rebuild time grows materially with corpus size, so synthetic scaling reinforces that index-build cost, not just search latency, should be published with results

When publishing synthetic results, include:

- the synthetic generator version from the JSON output
- corpus size and query count
- whether hybrid search and embeddings were enabled
- cold vs warm index timings

## Results Table

| # | Type | Query | Score | Notes |
|---|------|-------|-------|-------|
| | | | | |

*Fill in after running the harness against your cortex instance.*

## LoCoMo / LongMemEval Benchmark

LoCoMo (Long-Context Memory) is a benchmark for evaluating long-term memory retrieval in conversational AI systems. Our adaptation ingests findings into a temporary cortex instance, builds the FTS5 index, and measures recall@k and MRR (Mean Reciprocal Rank) for keyword-based retrieval queries against the ingested content.

### Running

```bash
# Toy dataset (3 sessions, built-in), good for CI
npm run bench

# Full LoCoMo dataset (download from GitHub first)
npm run bench -- --input locomo.json

# Custom session count and output path
npm run bench -- --sessions 10 --input locomo.json --output results.json
```

To get the full LoCoMo dataset, download it from [snap-stanford/locomo](https://github.com/snap-stanford/locomo) and convert to the expected JSON format (array of `{ id, findings[], questions[{ query, expectedKeyword }] }`).

### Results

This repo does not check in a canonical benchmark result table. Benchmark outputs belong in `docs/benchmark-results.json` for a specific run, and that JSON should be treated as the source of truth for the run conditions.

## Interpreting Results

- **80%+**: Strong on this dataset under these conditions. Do not generalize beyond the published corpus and retrieval mode.
- **60-79%**: Useful but with visible gaps. Check synonym coverage and corpus quality.
- **40-59%**: Needs tuning. Consider better findings hygiene, a different query set, or semantic retrieval.
- **Below 40%**: Validate index health and whether the benchmark is asking for paraphrase recall that pure FTS5 will miss.

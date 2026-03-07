# Benchmark Protocol

This document describes the Section 8 benchmark protocol for evaluating cortex's retrieval quality.

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
cd ~/cortex && npm run build

# Run the benchmark
npx tsx mcp/src/__tests__/benchmark/harness.ts

# Or via vitest
npm test -- --testPathPattern benchmark
```

The harness outputs a markdown results table showing:
- Query text and type
- Top-3 result summaries
- Score per query
- Total score and percentage

## Results Table

| # | Type | Query | Score | Notes |
|---|------|-------|-------|-------|
| | | | | |

*Fill in after running the harness against your cortex instance.*

## LoCoMo / LongMemEval Benchmark

LoCoMo (Long-Context Memory) is a benchmark for evaluating long-term memory retrieval in conversational AI systems. Our adaptation ingests findings into a temporary cortex instance, builds the FTS5 index, and measures recall@k and MRR (Mean Reciprocal Rank) for keyword-based retrieval queries against the ingested content.

### Running

```bash
# Toy dataset (3 sessions, built-in) — good for CI
npm run bench

# Full LoCoMo dataset (download from GitHub first)
npm run bench -- --input locomo.json

# Custom session count and output path
npm run bench -- --sessions 10 --input locomo.json --output results.json
```

To get the full LoCoMo dataset, download it from [snap-stanford/locomo](https://github.com/snap-stanford/locomo) and convert to the expected JSON format (array of `{ id, findings[], questions[{ query, expectedKeyword }] }`).

### Results

| Search Path | recall@1 | recall@3 | recall@5 | MRR | Date |
|-------------|----------|----------|----------|-----|------|
| FTS5        | TBD      | TBD      | TBD      | TBD | -    |
| Hybrid      | TBD      | TBD      | TBD      | TBD | -    |

Results are saved to `docs/benchmark-results.json` by default.

## Interpreting Results

- **80%+**: Excellent retrieval quality. FTS5 and fallback are working well.
- **60-79%**: Good but with gaps. Check if synonym map covers your terminology.
- **40-59%**: Needs tuning. Consider adding more structured findings or expanding synonyms.
- **Below 40%**: Check index health with `cortex doctor` and verify files are being indexed.

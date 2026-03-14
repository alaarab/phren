# Feature Flags

phren uses environment variables as feature flags to control optional behaviors. All flags are enabled by default. Set to `0`, `false`, `off`, or `no` to disable.

## PHREN_FEATURE_AUTO_EXTRACT

**Default:** enabled

Controls automatic memory extraction during the `hook-prompt` lifecycle hook. When enabled, phren mines git history and GitHub signals (PRs, CI runs, issues) for memory candidates once per session per project.

Phren runs this in the background during the UserPromptSubmit hook. He writes candidates to review.md for your review rather than directly to FINDINGS.md. The confidence threshold for auto-acceptance is controlled by `PHREN_MEMORY_AUTO_ACCEPT` (default: 0.75).

**When to disable:**
- In CI environments or automated pipelines where git/GitHub lookups add unwanted latency
- When working in repositories where `gh` CLI is not authenticated
- If extraction is generating too many low-quality candidates

```bash
export PHREN_FEATURE_AUTO_EXTRACT=0
```

## PHREN_FEATURE_DAILY_MAINTENANCE

**Default:** enabled

Controls the daily background maintenance job scheduled during `hook-session-start`. When enabled, phren quietly spawns a background process (once per calendar day) that runs:

- Memory pruning based on retention policy
- Canonical lock enforcement
- Legacy findings migration
- Dead memory cleanup

The maintenance process runs independently and does not block the session. A marker file (`.quality-YYYY-MM-DD`) prevents it from running more than once per day.

**When to disable:**
- On shared machines where background processes are not desired
- During development/testing of phren itself
- If you prefer to run governance commands manually

```bash
export PHREN_FEATURE_DAILY_MAINTENANCE=0
```

## PHREN_FEATURE_PROGRESSIVE_DISCLOSURE

**Default:** disabled

When enabled, the `hook-prompt` lifecycle hook uses a 3-layer progressive disclosure strategy instead of injecting full memory snippets verbatim.

**Layer 1 (always injected):** A compact memory index: one line per result with a `mem:project/filename` ID and a one-line summary (truncated at 80 chars). Injected into every hook-prompt response when 3 or more results are found.

**Layer 2 (on-demand):** Full snippet injection. Still used automatically when 1-2 results are found (targeted queries don't need the index).

**Layer 3 (by ID):** The `get_memory_detail` MCP tool fetches full content for any entry in the compact index by its `mem:project/filename` ID.

**When to enable:**
- If hook-prompt injections are consuming too many context tokens
- In sessions where many knowledge entries match broad prompts
- When you want Claude to decide which memories to expand rather than injecting all of them

```bash
export PHREN_FEATURE_PROGRESSIVE_DISCLOSURE=1
```

## PHREN_EMBEDDING_PROVIDER

**Default:** unset (disabled)

Controls the embedding provider for semantic search fallback. When FTS5 returns fewer than 3 results and this variable is set, phren computes embeddings for the query and corpus documents to find semantically similar matches.

**When to leave this disabled:** if you mostly search by exact identifiers, filenames, commands, project names, or other lexical code-work terms. The lexical path is usually the main path in that workflow, and it is also the faster path in the current measured code-memory benchmarks.

**When it is worth enabling:** if your retrieval misses are mostly paraphrase-heavy, fuzzy, or concept-level queries that share weak lexical overlap with the stored memories.

**Values:**
- **unset** (default): No embedding fallback. Only FTS5 and TF-IDF cosine are used.
- **`api`**: Use OpenAI-compatible embeddings API. Requires `OPENAI_API_KEY` to be set.
- **`local`**: Reserved for future local ONNX embedding support. Currently throws an error.

**Related variables:**
- `OPENAI_API_KEY`: Required when `PHREN_EMBEDDING_PROVIDER=api`. Your OpenAI API key.
- `PHREN_EMBEDDING_MODEL`: The embedding model to use (default: `text-embedding-3-small`). Supports any model available via the OpenAI embeddings endpoint.

Embedding results are cached in `.runtime/embed-cache.db` keyed by SHA-256 hash of the input text. This avoids redundant API calls for repeated queries.

```bash
export PHREN_EMBEDDING_PROVIDER=api
export OPENAI_API_KEY=sk-...
export PHREN_EMBEDDING_MODEL=text-embedding-3-small  # optional
```

## PHREN_FEATURE_SEMANTIC_DEDUP

**Default:** disabled

When enabled, phren calls an LLM to detect paraphrase duplicates that Jaccard similarity misses. For example, "restart the server after env changes" and "reboot the app when environment variables update" are semantically equivalent but score low on word overlap.

The LLM check only runs when Jaccard similarity is between 0.3 and 0.65, overlapping enough to be worth checking but not an obvious duplicate. Results are cached in `.runtime/dedup-cache.json` with a 24-hour TTL.

**Requires:** `PHREN_LLM_KEY` (or `OPENAI_API_KEY`) to be set.

**When to enable:**
- When your team finds many paraphrase duplicates slipping through
- After consolidation, to catch subtle repeats before they accumulate

```bash
export PHREN_FEATURE_SEMANTIC_DEDUP=1
export PHREN_LLM_KEY=sk-...  # or OPENAI_API_KEY
```

## PHREN_FEATURE_SEMANTIC_CONFLICT

**Default:** disabled

When enabled, phren calls an LLM to determine whether a new finding contradicts an existing one about the same fragment. Keyword-based negation detection (the default) misses past-tense conflicts ("we stopped using X") and implicit contradictions.

With this flag, when fragment extraction finds a shared fragment between new and existing findings, the LLM makes the final CONFLICT/OK verdict. Results are cached in `.runtime/conflict-cache.json` with a 7-day TTL.

**Requires:** `PHREN_LLM_KEY` (or `OPENAI_API_KEY`) to be set.

```bash
export PHREN_FEATURE_SEMANTIC_CONFLICT=1
export PHREN_LLM_KEY=sk-...
```

## PHREN_FEATURE_GH_MINING

**Default:** disabled

When enabled, `phren maintain extract` also mines GitHub signals (open PRs, recent CI failures, issues labeled `bug`) in addition to git history. Requires `gh` CLI to be authenticated.

Without this flag, `extract` only mines local git history.

```bash
export PHREN_FEATURE_GH_MINING=1
```

## PHREN_FINDINGS_CAP

**Default:** 20

Maximum number of active findings in FINDINGS.md before auto-archiving kicks in. When a new finding causes the active count to exceed this number, the oldest entries are moved to the project's `reference/` directory automatically.

Set higher to accumulate more findings before archiving, or lower to keep FINDINGS.md lean and force more frequent archiving.

```bash
export PHREN_FINDINGS_CAP=50   # allow up to 50 active findings
export PHREN_FINDINGS_CAP=10   # aggressive archiving
```

## PHREN_FEATURE_AUTO_CAPTURE

**Default:** disabled

Controls automatic insight extraction from conversation transcripts at session end. When enabled, the Stop hook reads the `transcript_path` from the Stop hook JSON payload, parses JSONL assistant messages, and runs keyword-heuristic extraction to identify findings worth saving.

This is pure heuristic extraction -- no LLM call, no Ollama, no external dependencies required. Extracted findings are written directly to FINDINGS.md for the active project.

Phren offers this during the `phren init` walkthrough. When you opt in, `PHREN_FEATURE_AUTO_CAPTURE=1` is written to `~/.phren/.env`.

**When to enable:**
- When you want passive memory capture without manual `add_finding` calls
- For teams that want every session to leave a trace without changing developer workflow
- When running long sessions where important patterns might be missed

**When to disable:**
- If auto-captured findings are too noisy for your workflow
- In CI or automated environments where conversation transcripts are not meaningful

```bash
export PHREN_FEATURE_AUTO_CAPTURE=1
```

## How Feature Flags Work

The `isFeatureEnabled` function in `cli.ts` reads the named environment variable. If the value is `0`, `false`, `off`, or `no` (case-insensitive, trimmed), the feature is disabled. Any other value, or if the variable is not set, means the feature is enabled.

This convention applies to all `PHREN_FEATURE_*` variables.

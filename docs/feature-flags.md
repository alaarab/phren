# Feature Flags

phren uses environment variables as feature flags to control optional behaviors. Defaults are mixed — some flags ship on, some ship off; each section below states its own default. A flag that defaults to enabled is turned off by setting it to `0`, `false`, `off`, or `no`; a flag that defaults to disabled is turned on by setting it to `1` (or any value other than that disable list).

## Precedence with management presets

The [management preset](footprint.md) is the coarse control; these flags are the fine control. When they disagree, precedence (strongest first) is:

1. `PHREN_FEATURE_*` env vars and `~/.phren/.env` lines — always win at runtime for the automations they gate.
2. Explicit per-capability booleans in `install-preferences.json`.
3. The preset bundle (`managed` / `assisted` / `manual`).
4. Built-in `managed` defaults (when no preset is set).

The `manual` preset writes `PHREN_FEATURE_AUTO_CAPTURE=0`, `PHREN_FEATURE_AUTO_EXTRACT=0`, and `PHREN_FEATURE_DAILY_MAINTENANCE=0` into `~/.phren/.env` at install so its automations stay off; you can flip any of them back on individually there.

## PHREN_FEATURE_NATIVE_MEMORY

Default: **off**. When on, phren also indexes Claude Code's own memory files (`~/.claude/projects/*/memory/*.md`) and can inject them as context. Off by default since 0.2.0: phren indexes phren, and Claude's memory directory is Claude's. Set `PHREN_FEATURE_NATIVE_MEMORY=1` to restore the old behaviour.

## PHREN_FEATURE_TOOL_HOOK

**Default:** enabled

**Read this one even if you skip the rest — it's the flag most likely to affect day-to-day performance.** It controls whether phren registers Claude Code's `PostToolUse` hook at all. With it enabled (the default), phren spawns a `phren hook-tool` subprocess after every `Read`, `Write`, `Edit`, `Bash`, `Glob`, and `Grep` tool call in the session (`cli/session-tool-hook.ts`'s `handleHookTool`), to log tool activity and opportunistically scrape explicit `[type] ...`-tagged findings out of tool output into the review queue.

Because those six tools make up the bulk of tool calls in most coding sessions, this means a subprocess spawn on nearly every turn. The other three lifecycle hooks (`UserPromptSubmit`, `Stop`, `SessionStart`) are unaffected by this flag and keep running either way.

**This flag is read when phren (re)writes your hook configuration, not live per tool call.** Set it before running `phren init`, or change it and run `phren hooks-mode on` afterward to force an unconditional hook re-sync — toggling the env var after the `PostToolUse` entry is already in `settings.json` has no effect until the hook list is regenerated. (`phren doctor --fix` only rewrites hooks when it separately detects stale/ephemeral entrypoints, so it isn't a reliable way to pick up this change on its own.)

**When to disable:**
- Sessions with heavy tool-call volume where subprocess-spawn latency adds up
- You don't rely on passive tool-output scraping and only ever add findings explicitly (`add_finding`, `phren add-finding`)

```bash
export PHREN_FEATURE_TOOL_HOOK=0
phren hooks-mode on   # force a hook re-sync so the change takes effect
```

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

## PHREN_FEATURE_GIT_CONTEXT_FILTER

**Default:** disabled

When enabled, `rankResults` (`shared/retrieval.ts`) sorts documents whose file matches one of the current git diff's changed files (staged or unstaged) ahead of everything else, before the usual findings-first / recency / score ordering. Git context (current branch and changed files) comes from `getGitContext` (`cli/session-git.ts`).

**When to enable:**
- Large multi-project stores where hook-prompt or search results are dominated by content unrelated to what you're actively editing

```bash
export PHREN_FEATURE_GIT_CONTEXT_FILTER=1
```

## PHREN_FEATURE_HYBRID_SEARCH

**Default:** enabled

Controls the TF-IDF cosine-similarity fallback (`shared/search-fallback.ts`'s `cosineFallback`). When FTS5 full-text search returns fewer than 3 results for a query, phren additionally scores the corpus (capped at 10,000 docs for latency) by cosine similarity over TF-IDF vectors and folds in matches above a 0.15 similarity threshold. This catches near-miss lexical matches FTS5's ranking alone doesn't surface, with no embedding endpoint or Ollama required.

This is independent from the embedding-based semantic fallback documented right below: hybrid search is local and lexical (TF-IDF), the embedding fallback is model-based and requires an endpoint.

**When to disable:**
- Very large corpora where scoring the full doc set adds latency you'd rather avoid (the 10,000-doc cap limits this, but it's still extra work on every sparse query)
- If cosine-fallback matches are lower signal than just returning fewer results for your workflow

```bash
export PHREN_FEATURE_HYBRID_SEARCH=0
```

## PHREN_EMBEDDING_API_URL

**Default:** unset (disabled)

Controls the embedding endpoint for semantic search fallback. When `PHREN_EMBEDDING_API_URL` is set and FTS5 returns fewer than 3 results, phren computes embeddings for the query and corpus documents to find semantically similar matches. Takes priority over Ollama when set.

**When to leave this disabled:** if you mostly search by exact identifiers, filenames, commands, project names, or other lexical code-work terms. The lexical path is usually the main path in that workflow, and it is also the faster path in the current measured code-memory benchmarks.

**When it is worth enabling:** if your retrieval misses are mostly paraphrase-heavy, fuzzy, or concept-level queries that share weak lexical overlap with the stored memories.

**Related variables:**
- `PHREN_EMBEDDING_API_URL`: OpenAI-compatible `/embeddings` endpoint (e.g. `https://api.openai.com/v1`). Used for both hook retrieval and MCP search.
- `PHREN_EMBEDDING_API_KEY`: Bearer token for the embedding endpoint. Required when using a cloud embedding provider.
- `PHREN_EMBEDDING_MODEL`: The embedding model to use (default: `nomic-embed-text`). When using a cloud API like OpenAI, set `PHREN_EMBEDDING_MODEL=text-embedding-3-small` explicitly. Supports any model available via the configured endpoint.

Embedding results are cached in `.runtime/embed-cache.db` keyed by SHA-256 hash of the input text. This avoids redundant API calls for repeated queries.

```bash
export PHREN_EMBEDDING_API_URL=https://api.openai.com/v1
export PHREN_EMBEDDING_API_KEY=sk-...
export PHREN_EMBEDDING_MODEL=text-embedding-3-small  # optional
```

## PHREN_FEATURE_QUERY_CORRELATION

**Default:** disabled

When enabled, phren logs which queries led to which documents being selected (and later marked "helpful" via feedback) to `.runtime/query-correlations.jsonl` (a rolling last-500-entry window). Future queries that share at least 2 overlapping tokens (3+ characters each) with a past query get those historically-correlated documents surfaced; entries previously marked helpful count double toward the correlation score.

This is a lightweight, local, no-LLM alternative for recurring query patterns — it does not require an embedding endpoint or Ollama.

**When to enable:**
- Repetitive query patterns in a project, where the same handful of documents keep being relevant to similarly-worded prompts

```bash
export PHREN_FEATURE_QUERY_CORRELATION=1
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

## PHREN_FEATURE_AGENTS

**Default:** disabled

Shows the coding agents running on this machine on the shell's knowledge graph. phren does not spawn or supervise them; it asks whatever is already running them and joins each one onto a phren project by the directory it is working in, using the same project detection the hooks use (so a git worktree resolves to the repository it came from).

Two providers ship built in and are used when available:

- **Herdr** — `herdr agent list`, which reports every agent pane, its status, its directory and which one is focused. Answers in a few milliseconds.
- **phren-agent** — agents from `phren-agent --multi`, published to `.runtime/agents/`.

Anything that prints the same record shape is a provider, so tmux or Zellij users need a few lines of shell rather than a change to phren.

In the Graph view, `a` toggles the overlay, `Tab` cycles agents, and `↵` brings the highlighted agent to the front through its own host. Agents appear as a coloured marker beside the project they are working in — green while working, grey when done, red on error — and are listed in the details pane.

Off by default because it runs an external binary on a timer. With no provider available the overlay never appears.

```bash
export PHREN_FEATURE_AGENTS=1
export PHREN_HERDR_TIMEOUT_MS=3000   # optional, clamped to 250–30000
```

## PHREN_FEATURE_FACT_EXTRACT

**Default:** disabled

When enabled, every new finding (`add_finding`) is passed to an LLM (`PHREN_LLM_ENDPOINT`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`, checked in that order) to extract a single structured preference or fact — "prefers X", "uses Y", "avoids Z", or "decided to X because Y" — stored in the project's `preferences.json` and surfaced in `session_start`. Unlike `PHREN_FEATURE_SEMANTIC_DEDUP`/`PHREN_FEATURE_SEMANTIC_CONFLICT` above (which only call an LLM on a narrow band of ambiguous cases), this calls an LLM on **every** finding — a real per-write cost, not a cached edge-case check.

If enabled without any of the LLM env vars set, this is a silent no-op rather than an error.

**When to enable:**
- You want a running, queryable summary of stated preferences/decisions, separate from FINDINGS.md prose

```bash
export PHREN_FEATURE_FACT_EXTRACT=1
export ANTHROPIC_API_KEY=sk-ant-...   # or OPENAI_API_KEY / PHREN_LLM_ENDPOINT
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

The `isFeatureEnabled(envName, defaultValue)` helper (`utils-helpers.ts`, re-exported via `utils.ts`) reads the named environment variable. If the value is `0`, `false`, `off`, or `no` (case-insensitive, trimmed), the feature is disabled regardless of `defaultValue`. If the variable is not set at all, the feature falls back to `defaultValue` — `true` for flags that ship on, `false` for flags that ship off (see each flag's **Default** above).

This convention applies to all `PHREN_FEATURE_*` variables. `PHREN_FEATURE_HYBRID_SEARCH` (`shared/search-fallback.ts`) implements the same on/off check inline instead of calling the shared helper, but follows the identical `0`/`false`/`off`/`no`-disables, default-otherwise convention.

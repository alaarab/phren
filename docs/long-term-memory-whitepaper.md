# Long-Term Memory For Coding Agents: Architecture, Tradeoffs, and Evaluation

Version: 1.0  
Date: March 6, 2026  
Scope: Cortex design justification + comparative analysis against selected alternatives

## Abstract
Long-term memory for coding agents is no longer optional for multi-session software work. Without persistent memory, agents repeatedly consume tokens reconstructing architecture, conventions, and prior decisions, while humans shoulder context management overhead. This whitepaper formalizes the design rationale behind Cortex’s memory architecture, compares it with three relevant alternatives (Supermemory, claude-mem, and GitHub Copilot Memory), and defines a reproducible evaluation protocol for quality, cost, latency, governance, and operational burden.

Cortex adopts a markdown-native, git-backed memory substrate with hook-driven lifecycle automation and local FTS5 indexing. The central design claim is that memory systems for engineering workflows should optimize for auditability, portability, and controllable token overhead, not just retrieval quality. The analysis argues that this choice dominates when teams value ownership and low lock-in, while managed memory platforms can dominate when cross-system ingestion and hosted operations are primary requirements.

## 1. Problem Definition
Coding-agent memory must solve four distinct problems simultaneously:

1. Persistence: preserve high-value context across sessions and machines.
2. Retrieval: deliver relevant context at prompt time under token constraints.
3. Governance: prevent stale/incorrect memory from degrading behavior.
4. Operability: keep maintenance and integration costs acceptable.

Most failures come from optimizing one axis in isolation (for example, strong recall with weak provenance, or rich capture with uncontrolled prompt overhead).

## 2. Requirements For A Production Memory Layer
A production memory system for coding agents should satisfy:

- Deterministic scope boundaries (project/repo/user/tenant).
- Provenance and inspectability of stored memory.
- Explicit forgetting/retention semantics.
- Bounded prompt-time token injection.
- Failure isolation: memory subsystem failures should not block core coding flow.
- Cross-machine reproducibility.
- Minimal platform lock-in.

## 3. Methodological Lens
This paper evaluates systems using six dimensions:

1. Representation: how memory is stored (files, SQL, vector store, managed service).
2. Capture Path: when/how memory is created (hooks, agent actions, asynchronous workers).
3. Retrieval Path: how context is selected and injected.
4. Governance and Forgetting: staleness handling, validation, TTL/expiry, manual controls.
5. Economics: token overhead, compute/storage, and human maintenance time.
6. Portability and Control: migration risk, vendor dependence, and auditability.

### 3.1 Research Grounding
The evaluation framework is informed by retrieval and memory literature:

- RAG formalizes parametric + non-parametric memory composition [1].
- Self-RAG highlights adaptive retrieval over fixed retrieval for factuality/citation quality [2].
- MemoryBank emphasizes forgetting/refresh dynamics for long-horizon interaction [3].
- MemGPT frames hierarchical memory management under bounded context windows [4].

These are not one-to-one implementations of developer tooling, but they provide stable principles for practical system design.

## 4. Cortex Architecture (Current)
### 4.1 Storage and Ownership Model
Cortex stores memory in project markdown files (`CLAUDE.md`, `summary.md`, `LEARNINGS.md`, `backlog.md`) under user-controlled git repositories, then builds a local SQLite FTS5 index for retrieval ([README.md](/home/alaarab/cortex/README.md), [shared.ts](/home/alaarab/cortex/mcp/src/shared.ts)).

Rationale:
- Files are inspectable, diffable, and mergeable.
- Git history provides provenance and rollback.
- No mandatory external memory service or vector DB dependency.

### 4.2 Capture and Lifecycle
Cortex uses lifecycle hooks (`hook-prompt`, `hook-session-start`, `hook-stop`) to automate context injection and persistence ([cli.ts](/home/alaarab/cortex/mcp/src/cli.ts), [hooks.ts](/home/alaarab/cortex/mcp/src/hooks.ts)).

Rationale:
- Reduces reliance on agent self-discipline to call memory tools.
- Aligns memory actions to natural session lifecycle.
- Supports graceful degradation (best-effort operations, non-blocking wrapper behavior).

### 4.3 Retrieval and Token Budgeting
Cortex retrieval is bounded by explicit defaults:

- Prompt injection token budget default: ~550 tokens.
- Snippet line budget default: 6 lines.
- Snippet character budget default: 520 chars.
- Candidate narrowing and top-k capped before injection.

These limits are configurable via environment variables (`CORTEX_CONTEXT_TOKEN_BUDGET`, `CORTEX_CONTEXT_SNIPPET_LINES`, `CORTEX_CONTEXT_SNIPPET_CHARS`) ([cli.ts](/home/alaarab/cortex/mcp/src/cli.ts), [index.ts](/home/alaarab/cortex/mcp/src/index.ts)).

Rationale:
- Makes prompt overhead predictable.
- Enforces budget-aware relevance selection.
- Avoids silent context bloat.

### 4.4 Governance and Forgetting
Cortex includes policy defaults for TTL, retention, confidence thresholds, and decay:

- `ttlDays=120`, `retentionDays=365`
- `autoAcceptThreshold=0.75`
- `minInjectConfidence=0.35`
- decay factors (`d30`, `d60`, `d90`, `d120`)

([shared.ts](/home/alaarab/cortex/mcp/src/shared.ts)).

It also supports queueing suspicious memory (`MEMORY_QUEUE.md`) and role-based access controls.

Rationale:
- Memory quality degrades without active forgetting/governance.
- Role controls reduce accidental policy drift in team use.

## 5. Comparative Analysis
Data in this section is based on publicly documented behavior as of March 6, 2026.

### 5.1 Supermemory
Observed design characteristics:

- Managed Memory API and SDK-centric integration model [5].
- API creation flow supports metadata + `containerTags` partitioning and asynchronous status [6][7].
- Explicit filtering concepts (`containerTags`, metadata filters) and graph-centric semantics [8][9].
- Graph-memory model includes update/extends/derives relationships and automatic forgetting behavior [9].
- Public benchmark tooling (MemoryBench) exists for comparative provider runs [10].

Implications:
- Strong for hosted multi-tenant apps needing ingestion and provider-level benchmarking.
- Faster time-to-market for API-native products.
- Higher platform dependency relative to file-native approaches.

### 5.2 claude-mem
Observed design characteristics:

- Hook-driven architecture with multiple lifecycle stages (`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `SessionEnd`) [11][12].
- SQLite + FTS5 core storage and optional ChromaDB semantic layer [11][13][14].
- Hybrid search path combining FTS5 queries with semantic similarity [14].
- Worker-based asynchronous processing and queueing patterns [12].

Implications:
- Architecturally close to Cortex in hook-first philosophy.
- Strong local control and extensibility for Claude-centric workflows.
- Added runtime complexity from worker processes and optional vector stack.

### 5.3 GitHub Copilot Memory
Observed design characteristics:

- Repository-scoped memories, validated against current codebase before use [15][16].
- Automatic expiry after 28 days [15][16].
- Cross-surface use across coding agent, code review, and CLI [15].
- Repository owners can review/delete memories; enterprise/organization policies control enablement [16].
- Rollout changed materially in early 2026 (public preview to default-on for Pro/Pro+) [15][17].

Implications:
- Tight integration for GitHub-native workflows.
- Low setup overhead where Copilot is already standard.
- Limited portability/audit granularity versus explicit file-native memory repos.

### 5.4 Comparative Matrix

| Dimension | Cortex | Supermemory | claude-mem | Copilot Memory |
|---|---|---|---|---|
| Primary substrate | Markdown + git + local FTS5 | Managed API/service + metadata/tag model | SQLite/FTS5 (+ optional ChromaDB) | Managed GitHub-native repository memory |
| Capture trigger | Lifecycle hooks + tools | API calls / connectors | Lifecycle hooks + worker queue | Copilot feature actions in repo |
| Retrieval control | Explicit token/line/char budgets | API-level retrieval tuning | Hybrid FTS + semantic retrieval | Managed by Copilot policy/feature behavior |
| Forgetting model | Configurable TTL/retention/decay | Graph updates + automatic forgetting semantics | Hook/worker + DB lifecycle | 28-day automatic expiry |
| Auditability | High (file diffs + git history) | Medium (API records, service-centric) | Medium-high (local DB) | Medium (UI + platform logs/settings) |
| Lock-in risk | Low | Medium-high | Low-medium | Medium-high (platform scoped) |
| Operational overhead | Medium (self-managed files/hooks) | Low-medium (managed service) | Medium-high (worker + DB ops) | Low (managed) |

## 6. Cost Model (Tokens, Time, Money)
### 6.1 Token Overhead Model
Let:

- `N` = number of prompts per month
- `T_i` = injected context tokens per prompt
- `T_b` = configured budget cap (Cortex default ~550)
- `p_in` = input token price (model/provider specific)

Then monthly memory-injection token cost upper bound is:

`Cost_injection <= N * T_b * p_in`

Expected cost is lower with sparse retrieval:

`Expected_Cost_injection = N * E[T_i] * p_in`, with `E[T_i] << T_b` when relevance filtering skips injection.

Cortex’s explicit budget makes this analyzable before deployment; systems without a clear cap can drift upward unpredictably.

### 6.2 Human-Time Cost Model
Total operating cost includes human maintenance time:

`Total_Cost = Token_Cost + Compute_Cost + Storage_Cost + (Engineer_Hours * Loaded_Rate)`

In practice, teams often underestimate `Engineer_Hours` from drift cleanup, staleness triage, and integration breakage. File-native systems may have slightly higher setup cost but lower migration risk and better forensic debugging.

## 7. Why Cortex Chose This Path
The Cortex path is justified by the following design priorities:

1. Ownership-first memory: Memory is plain files under user control, not opaque service state.
2. Auditability: Every memory mutation is inspectable through git diff/history.
3. Bounded context economics: Injection is explicitly budgeted and configurable.
4. Lifecycle automation: Hooks reduce behavioral variance across agents/sessions.
5. Governance primitives: TTL, retention, workflow approvals, and queue triage are first-class.
6. Interoperability: MCP tools and CLI offer the same operational core.

This is a deliberate tradeoff: Cortex favors transparency and control over maximum managed convenience.

## 8. Where Alternatives Can Be Better
Cortex is not universally dominant.

- Choose Supermemory when you need rapid hosted deployment, external ingestion/connectors, and API-native product embedding.
- Choose Copilot Memory when your workflow is deeply GitHub-native and you want minimal setup/operations.
- Choose claude-mem when you want local hook-driven memory with richer in-process worker pipelines tailored to Claude workflows.

## 9. Evaluation Protocol For Future Benchmarks
To evaluate objectively against alternatives, run a controlled benchmark with fixed task suites and equal model settings.

### 9.1 Task Categories
- Long-horizon debugging (multi-session dependency tracing)
- Architecture-constrained feature implementation
- Regression triage with stale-memory distractors
- Cross-file convention adherence
- Long-form explanation with citation correctness

### 9.2 Metrics
- Retrieval relevance: Precision@k, Recall@k
- Grounding quality: citation validity rate
- Behavioral quality: task success rate, defect rate
- Efficiency: average injected tokens/prompt, latency p50/p95
- Robustness: stale-memory contamination rate
- Governance burden: manual interventions per 100 tasks

### 9.3 Controls
- Same base model family/version
- Same repositories and branch states
- Same task prompts and acceptance criteria
- Fixed run count with randomized task order

### 9.4 Threats To Validity
- Feature rollouts can change behavior quickly (especially preview features).
- Vendor-side hidden heuristics may confound attribution.
- Benchmarks can overfit to particular repositories or coding styles.

## 10. Reproducibility Package (Included)
To move from conceptual comparison to publishable empirical evidence, this whitepaper now includes a benchmark artifact pack in:

- `docs/whitepaper-artifacts/benchmark-protocol.md`
- `docs/whitepaper-artifacts/trials-template.csv`
- `docs/whitepaper-artifacts/summary-template.csv`
- `docs/whitepaper-artifacts/cost-model-template.csv`
- `docs/whitepaper-artifacts/failures-template.csv`
- `docs/whitepaper-artifacts/report-template.md`
- `docs/whitepaper-artifacts/analysis-guide.md`

### 10.1 Minimum Sample Guidance
- Baseline recommendation: >= 40 tasks, paired across compared systems.
- Prefer >= 3 repositories to avoid single-repo bias.
- Preserve randomization seeds and manifest all version identifiers.

### 10.2 Publication Readiness Checklist
A results set is publication-ready when it includes:

1. raw per-trial data
2. endpoint summary table with confidence intervals
3. pairwise significance/effect-size table
4. failure taxonomy counts
5. explicit threats-to-validity section
6. reproducibility metadata (model versions, SHAs, seeds)

## 11. Risks and Mitigations
- Risk: Context over-injection increases cost and distracts generation.  
  Mitigation: strict budgeting + top-k capping + snippet compaction.

- Risk: Stale memory degrades output quality.  
  Mitigation: validation/queueing/expiry and manual curation paths.

- Risk: Hidden platform behavior changes.  
  Mitigation: explicit changelog tracking and regression benchmark runs.

- Risk: Operational fragility from hooks.  
  Mitigation: timeouts, best-effort execution, and fallback commands.

## 12. Conclusion
The core design decision in Cortex is not merely “store memory.” It is to optimize memory for engineering accountability: inspectable state, deterministic budgets, and governance-ready lifecycle automation. This makes Cortex a strong default for teams that prioritize controllability, reproducibility, and low lock-in.

Managed alternatives can outperform on convenience and service-level capabilities, but often at the cost of portability and transparent control. A rigorous benchmark program should therefore compare not only answer quality, but also operational economics and governance resilience over time.

## References
[1] Lewis et al., *Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks*, arXiv:2005.11401, 2020/2021. https://arxiv.org/abs/2005.11401

[2] Asai et al., *Self-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection*, arXiv:2310.11511, 2023. https://arxiv.org/abs/2310.11511

[3] Zhong et al., *MemoryBank: Enhancing Large Language Models with Long-Term Memory*, arXiv:2305.10250, 2023. https://arxiv.org/abs/2305.10250

[4] Packer et al., *MemGPT: Towards LLMs as Operating Systems*, arXiv:2310.08560, 2023/2024. https://arxiv.org/abs/2310.08560

[5] Supermemory docs introduction. https://supermemory.ai/docs/introduction

[6] Supermemory memory creation APIs (`/v3/memories`/`/v3/documents`), metadata/container tags, async status. https://supermemory.ai/docs/memory-api/creation/adding-memories

[7] Supermemory auto multi-modal detection and API processing notes. https://supermemory.ai/docs/memory-api/features/auto-multi-modal

[8] Supermemory filtering/container-tags concepts. https://supermemory.ai/docs/memory-api/features/filtering

[9] Supermemory graph memory concepts (updates/extends/derives, automatic forgetting). https://supermemory.ai/docs/concepts/graph-memory

[10] Supermemory MemoryBench quickstart/repository. https://supermemory.ai/docs/memorybench/quickstart and https://github.com/supermemoryai/memorybench

[11] Claude-mem architecture overview (hooks, SQLite/FTS5, optional ChromaDB). https://docs.claude-mem.ai/architecture/overview

[12] Claude-mem hooks architecture/lifecycle stages. https://docs.claude-mem.ai/hooks-architecture

[13] Claude-mem database architecture (SQLite, FTS5, WAL). https://docs.claude-mem.ai/architecture/database

[14] Claude-mem search architecture (FTS5 queries, hybrid ChromaDB similarity). https://docs.claude-mem.ai/architecture/search-architecture

[15] GitHub Changelog (March 4, 2026): Copilot Memory default-on for Pro/Pro+ public preview; repo scope; validation; 28-day expiry. https://github.blog/changelog/2026-03-04-copilot-memory-now-on-by-default-for-pro-and-pro-users-in-public-preview/

[16] GitHub Docs: Managing and curating Copilot Memory (policy controls, enablement, deletion, 28-day deletion note). https://docs.github.com/en/copilot/how-tos/use-copilot-agents/copilot-memory

[17] GitHub Changelog (Jan 15, 2026): Agentic memory public preview announcement and behavior summary. https://github.blog/changelog/2026-01-15-agentic-memory-for-github-copilot-is-in-public-preview/

[18] Cortex repository references: [README.md](/home/alaarab/cortex/README.md), [mcp/src/cli.ts](/home/alaarab/cortex/mcp/src/cli.ts), [mcp/src/shared.ts](/home/alaarab/cortex/mcp/src/shared.ts), [mcp/src/hooks.ts](/home/alaarab/cortex/mcp/src/hooks.ts), [mcp/src/index.ts](/home/alaarab/cortex/mcp/src/index.ts).

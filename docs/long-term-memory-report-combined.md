# Long-Term Memory Report (Combined Package)

Generated: 2026-03-06

This document combines the whitepaper and all benchmark appendices into one place.

---

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

---

## Appendix A: Benchmark Protocol

# Long-Term Memory Benchmark Protocol (v1.0)

## Purpose
This protocol operationalizes the whitepaper into a reproducible benchmark for comparing coding-agent memory systems (for example: Cortex, Supermemory-backed stack, claude-mem, Copilot Memory workflows).

## 1. Experimental Unit
One **trial** is a single model run on a single task with one memory system configuration.

- Unit of randomization: `task_id`
- Unit of analysis: `trial_id`
- Blocking factor: repository/project (`repo_id`)

## 2. Fixed Controls
Hold these constant across systems:

- Base model family/version
- Temperature/top_p/max_tokens
- Repository commit SHA at trial start
- Tool permissions and network policies
- Prompt text and acceptance criteria
- Runtime timeout limits

If a variable cannot be held constant, record it explicitly in metadata and treat as a covariate.

## 3. Task Set Design
Use at least 40 tasks, balanced across categories:

1. Long-horizon debugging
2. Feature implementation with architecture constraints
3. Regression triage with stale-memory distractors
4. Convention/style adherence
5. Documentation synthesis with citation checks

Each task card must include:

- `task_id`
- objective
- required files/areas
- acceptance tests/checklist
- expected memory utility (high/medium/low)
- estimated complexity (1-5)

## 4. Assignment Strategy
Use blocked randomization per repo:

- For each `repo_id`, shuffle tasks with fixed seed.
- Assign each task to every system (paired design) when feasible.
- Randomize run order to reduce temporal effects.

Recommended seeds:

- Assignment seed: `20260306`
- Prompt-order seed: `20260307`

## 5. Data Collection Schema
Capture a row per trial with at least:

- IDs: `trial_id`, `task_id`, `repo_id`, `system_name`, `run_timestamp`
- Quality: `task_success` (0/1), `defect_count`, `citation_valid_rate`
- Retrieval: `retrieved_items`, `relevant_items`, `precision_at_k`, `recall_at_k`
- Efficiency: `injected_tokens`, `prompt_tokens_total`, `completion_tokens_total`
- Performance: `latency_ms_p50`, `latency_ms_p95`
- Governance: `stale_memory_incidents`, `manual_interventions`
- Ops: `setup_minutes`, `maintenance_minutes_weekly`

Use the provided CSV templates in this folder.

## 6. Metric Definitions
### 6.1 Task Success
`task_success = 1` only if all acceptance criteria pass (tests/checklist/manual validation).

### 6.2 Defect Count
Number of post-run defects found in produced changes.

### 6.3 Citation Valid Rate
`valid_citations / total_citations`

### 6.4 Retrieval Precision@k
`precision_at_k = relevant_retrieved_at_k / k`

### 6.5 Retrieval Recall@k
`recall_at_k = relevant_retrieved_at_k / total_relevant_available`

### 6.6 Token Overhead Ratio
`token_overhead_ratio = injected_tokens / prompt_tokens_total`

### 6.7 Governance Load
`governance_load = manual_interventions / trials`

## 7. Statistical Analysis Plan
### 7.1 Primary Endpoints
- `task_success_rate`
- `injected_tokens_mean`
- `latency_ms_p95`
- `citation_valid_rate_mean`

### 7.2 Secondary Endpoints
- `defect_count_mean`
- `precision_at_k_mean`
- `recall_at_k_mean`
- `governance_load`

### 7.3 Tests
For paired task-level comparisons:

- Binary outcomes (`task_success`): McNemar test or paired bootstrap CI.
- Continuous skewed outcomes (`injected_tokens`, `latency`): Wilcoxon signed-rank + bootstrap CIs.
- Effect size: Cliff's delta (or paired standardized difference).

### 7.4 Confidence Intervals
Use non-parametric bootstrap (10,000 resamples) for key mean/median differences.

Report:

- point estimate
- 95% CI
- p-value (when applicable)
- effect size

### 7.5 Multiple Comparisons
If comparing >2 systems, control false discovery (Holm-Bonferroni) on primary endpoints.

## 8. Bias and Validity Controls
- Blind evaluators to `system_name` when scoring outputs where possible.
- Use a holdout task split not touched during protocol tuning.
- Track and report dropped/failed trials with reasons.
- Run inter-rater agreement on at least 20% of manually scored trials.

## 9. Failure Taxonomy
Classify each failure into one dominant class:

1. Retrieval miss (relevant memory not injected)
2. Retrieval noise (irrelevant memory injected)
3. Stale memory contamination
4. Governance/policy failure
5. Tooling/runtime failure
6. Model reasoning failure (memory-independent)

## 10. Reporting Requirements
A benchmark report is complete only if it contains:

- full environment manifest
- protocol version and seeds
- endpoint tables with CIs
- threats-to-validity section
- raw artifact links (CSV + logs)

## 11. Minimal Reproducibility Bundle
Store these artifacts per benchmark run:

- `manifest.json` (model/tool versions, git SHAs)
- `trials.csv` (per-trial rows)
- `summary.csv` (aggregates)
- `failures.csv` (taxonomy)
- `report.md` (human-readable conclusions)


---

## Appendix B: Analysis Guide

# Analysis Guide For Benchmark Artifacts

## Inputs
- `trials-template.csv` (filled with trial rows)
- `summary-template.csv` (derived)
- `failures-template.csv` (filled with failure taxonomy)
- `cost-model-template.csv` (filled with economics parameters)

## 1. Derived Per-Trial Fields
Compute when missing:

- `citation_valid_rate = citations_valid / citations_total` (if `citations_total > 0`, else blank)
- `precision_at_k = relevant_retrieved_at_k / k` (if `k > 0`)
- `recall_at_k = relevant_retrieved_at_k / relevant_items` (if `relevant_items > 0`)
- `token_overhead_ratio = injected_tokens / prompt_tokens_total` (if `prompt_tokens_total > 0`)

## 2. System-Level Aggregates
For each `system_name`:

- `task_success_rate_mean = mean(task_success)`
- `defect_count_mean = mean(defect_count)`
- `citation_valid_rate_mean = mean(citation_valid_rate)`
- `precision_at_k_mean = mean(precision_at_k)`
- `recall_at_k_mean = mean(recall_at_k)`
- `injected_tokens_mean = mean(injected_tokens)`
- `latency_ms_p95_mean = mean(latency_ms_p95)`

## 3. Bootstrap CI Procedure
For each endpoint and system:

1. Resample trial rows with replacement (size = n).
2. Compute endpoint mean for resample.
3. Repeat 10,000 times.
4. CI = 2.5th and 97.5th percentiles.

For pairwise differences:

1. Pair by `task_id` where both systems have runs.
2. Resample paired rows.
3. Compute difference in endpoint means.
4. Take percentile CI.

## 4. Effect Size (Cliff's Delta)
For two systems A and B on endpoint x:

`delta = (count(a > b) - count(a < b)) / (n_a * n_b)`

Interpretation (rule-of-thumb):
- |delta| < 0.147: negligible
- < 0.33: small
- < 0.474: medium
- >= 0.474: large

## 5. Monthly Cost Estimation
For each system row in `cost-model-template.csv`:

`token_cost_estimate_usd = ((n_prompts * avg_prompt_tokens_total)/1000 * input_token_price_per_1k) + ((n_prompts * avg_completion_tokens)/1000 * output_token_price_per_1k)`

`human_cost_estimate_usd = (setup_hours + maintenance_hours_month) * loaded_rate_usd_hour`

`total_cost_estimate_usd = token_cost_estimate_usd + human_cost_estimate_usd`

## 6. Minimal QA Checks
- No duplicate `trial_id` values.
- `task_success` in {0,1}.
- `citations_valid <= citations_total`.
- `relevant_retrieved_at_k <= min(k, relevant_items)`.
- Missing values documented in report.

## 7. Reproducibility Checklist
- Save analysis code hash/commit in report.
- Save random seeds.
- Save exact model/version identifiers.
- Archive raw and processed files together.


---

## Appendix C: Report Template

# Long-Term Memory Benchmark Report

Date: YYYY-MM-DD  
Protocol Version: v1.0  
Run ID: <run-id>

## 1. Executive Summary
- Best system on task success:
- Best system on token efficiency:
- Best system on governance load:
- Decision recommendation:

## 2. Experimental Configuration
- Repositories:
- Models:
- Systems compared:
- Number of tasks:
- Number of trials:
- Randomization seeds:

## 3. Primary Results
| System | Task Success Rate | 95% CI | Mean Injected Tokens | 95% CI | Latency p95 (ms) | Citation Valid Rate |
|---|---:|---|---:|---|---:|---:|
| Cortex |  |  |  |  |  |  |
| System B |  |  |  |  |  |  |
| System C |  |  |  |  |  |  |

## 4. Secondary Results
| System | Defect Count (mean) | Precision@k | Recall@k | Stale Incidents | Manual Interventions |
|---|---:|---:|---:|---:|---:|
| Cortex |  |  |  |  |  |
| System B |  |  |  |  |  |
| System C |  |  |  |  |  |

## 5. Pairwise Statistical Comparisons
| Comparison | Endpoint | Effect Size | 95% CI | p-value | Significant (Y/N) |
|---|---|---:|---|---:|---|
| Cortex vs System B | Task Success |  |  |  |  |
| Cortex vs System B | Injected Tokens |  |  |  |  |
| Cortex vs System C | Task Success |  |  |  |  |
| Cortex vs System C | Injected Tokens |  |  |  |  |

## 6. Cost Analysis
| System | Token Cost (USD/month) | Human Cost (USD/month) | Total Cost (USD/month) |
|---|---:|---:|---:|
| Cortex |  |  |  |
| System B |  |  |  |
| System C |  |  |  |

## 7. Failure Taxonomy
| Failure Class | Cortex | System B | System C |
|---|---:|---:|---:|
| Retrieval miss |  |  |  |
| Retrieval noise |  |  |  |
| Stale contamination |  |  |  |
| Governance failure |  |  |  |
| Tool/runtime failure |  |  |  |
| Model reasoning failure |  |  |  |

## 8. Threats To Validity
- Internal validity:
- External validity:
- Construct validity:
- Statistical conclusion validity:

## 9. Recommendation
- Preferred default:
- Exceptions / when to choose alternatives:
- Required mitigations before rollout:

## 10. Artifact Links
- `manifest.json`:
- `trials.csv`:
- `summary.csv`:
- `failures.csv`:
- `analysis notebook/script`:


---

## Appendix D: CSV Schemas

### cost-model-template.csv

```csv
system_name,period_month,n_prompts,avg_injected_tokens,avg_prompt_tokens_total,input_token_price_per_1k,output_token_price_per_1k,avg_completion_tokens,token_cost_estimate_usd,setup_hours,maintenance_hours_month,loaded_rate_usd_hour,human_cost_estimate_usd,total_cost_estimate_usd
```

### failures-template.csv

```csv
trial_id,system_name,task_id,failure_class,severity,description,root_cause,memory_related,preventable,next_action
```

### summary-template.csv

```csv
system_name,n_trials,task_success_rate_mean,task_success_rate_ci_low,task_success_rate_ci_high,defect_count_mean,defect_count_ci_low,defect_count_ci_high,citation_valid_rate_mean,citation_valid_rate_ci_low,citation_valid_rate_ci_high,precision_at_k_mean,recall_at_k_mean,injected_tokens_mean,injected_tokens_ci_low,injected_tokens_ci_high,token_overhead_ratio_mean,latency_ms_p50_mean,latency_ms_p95_mean,stale_memory_incidents_total,manual_interventions_total,setup_minutes_mean,maintenance_minutes_weekly_mean
```

### trials-template.csv

```csv
trial_id,run_timestamp,repo_id,task_id,system_name,model_name,model_version,commit_sha,task_category,task_complexity,task_success,defect_count,citations_total,citations_valid,citation_valid_rate,retrieved_items,relevant_items,relevant_retrieved_at_k,k,precision_at_k,recall_at_k,injected_tokens,prompt_tokens_total,completion_tokens_total,token_overhead_ratio,latency_ms_p50,latency_ms_p95,stale_memory_incidents,manual_interventions,setup_minutes,maintenance_minutes_weekly,notes
```


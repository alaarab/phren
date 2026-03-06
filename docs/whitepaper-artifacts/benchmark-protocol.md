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


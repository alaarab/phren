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


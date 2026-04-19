/** Cost tracking for LLM API usage. */
import { lookupPricing } from "./models.js";
export function createCostTracker(model, budget = null, provider) {
    const { pricing, metered } = lookupPricing(model, provider);
    const tracker = {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
        budget,
        metered,
        recordUsage(inputTokens, outputTokens) {
            tracker.totalInputTokens += inputTokens;
            tracker.totalOutputTokens += outputTokens;
            tracker.totalCost +=
                (inputTokens / 1_000_000) * pricing.inputPer1M +
                    (outputTokens / 1_000_000) * pricing.outputPer1M;
        },
        isOverBudget() {
            return tracker.metered && budget !== null && tracker.totalCost >= budget;
        },
        formatCost() {
            const tokens = `${tracker.totalInputTokens + tracker.totalOutputTokens} tokens`;
            if (!tracker.metered) {
                return `included (${tokens})`;
            }
            const cost = tracker.totalCost < 0.01
                ? `$${tracker.totalCost.toFixed(4)}`
                : `$${tracker.totalCost.toFixed(2)}`;
            const budgetStr = budget !== null ? ` / $${budget.toFixed(2)} budget` : "";
            return `${cost} (${tokens}${budgetStr})`;
        },
        formatTurnCost(inputTokens, outputTokens) {
            if (!tracker.metered)
                return "included";
            const turnCost = (inputTokens / 1_000_000) * pricing.inputPer1M +
                (outputTokens / 1_000_000) * pricing.outputPer1M;
            return turnCost < 0.01
                ? `$${turnCost.toFixed(4)}`
                : `$${turnCost.toFixed(2)}`;
        },
    };
    return tracker;
}

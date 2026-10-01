/** Cost tracking for LLM API usage. */
import { lookupPricing, type ModelPricing } from "./models.js";

export interface CostTracker {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  budget: number | null;
  metered: boolean;
  recordUsage(inputTokens: number, outputTokens: number): void;
  isOverBudget(): boolean;
  formatCost(): string;
  formatTurnCost(inputTokens: number, outputTokens: number): string;
}

/** Price a model and endpoint, with PHREN_AGENT_PRICE_IN/OUT/CACHE (USD per 1M) taking precedence. */
export function resolvePricing(model: string, provider?: string, baseUrl?: string): { pricing: ModelPricing; metered: boolean } {
  const looked = lookupPricing(model, provider, baseUrl);
  const env = (key: string): number | undefined => {
    const raw = process.env[key];
    if (raw === undefined || raw === "") return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  const input = env("PHREN_AGENT_PRICE_IN");
  const output = env("PHREN_AGENT_PRICE_OUT");
  const cacheRead = env("PHREN_AGENT_PRICE_CACHE");
  if (input === undefined && output === undefined && cacheRead === undefined) return looked;
  // An explicit price means the user is paying per token, even on a route
  // the catalog calls included.
  const cache = cacheRead ?? looked.pricing.cacheReadPer1M;
  return {
    pricing: {
      inputPer1M: input ?? looked.pricing.inputPer1M,
      outputPer1M: output ?? looked.pricing.outputPer1M,
      ...(cache !== undefined ? { cacheReadPer1M: cache } : {}),
    },
    metered: true,
  };
}

export function createCostTracker(model: string, budget: number | null = null, provider?: string, baseUrl?: string): CostTracker {
  const { pricing, metered } = resolvePricing(model, provider, baseUrl);

  const tracker: CostTracker = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    budget,
    metered,

    recordUsage(inputTokens: number, outputTokens: number) {
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

    formatTurnCost(inputTokens: number, outputTokens: number) {
      if (!tracker.metered) return "included";
      const turnCost =
        (inputTokens / 1_000_000) * pricing.inputPer1M +
        (outputTokens / 1_000_000) * pricing.outputPer1M;
      return turnCost < 0.01
        ? `$${turnCost.toFixed(4)}`
        : `$${turnCost.toFixed(2)}`;
    },
  };

  return tracker;
}

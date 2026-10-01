/** Cost tracking for LLM API usage. */
import { lookupPricing, type ModelPricing } from "./models.js";

export interface CostTracker {
  /** Uncached input tokens. */
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Input tokens served from the provider's prompt cache. */
  totalCacheReadTokens: number;
  totalCost: number;
  budget: number | null;
  metered: boolean;
  recordUsage(inputTokens: number, outputTokens: number, cacheReadTokens?: number): void;
  isOverBudget(): boolean;
  formatCost(): string;
  formatTurnCost(inputTokens: number, outputTokens: number, cacheReadTokens?: number): string;
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
  // Without a cache price, hits bill as ordinary input (no discount assumed).
  const cacheReadPer1M = pricing.cacheReadPer1M ?? pricing.inputPer1M;
  const price = (input: number, output: number, cacheRead: number) =>
    (input / 1_000_000) * pricing.inputPer1M +
    (output / 1_000_000) * pricing.outputPer1M +
    (cacheRead / 1_000_000) * cacheReadPer1M;

  const tracker: CostTracker = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCost: 0,
    budget,
    metered,

    recordUsage(inputTokens: number, outputTokens: number, cacheReadTokens = 0) {
      tracker.totalInputTokens += inputTokens;
      tracker.totalOutputTokens += outputTokens;
      tracker.totalCacheReadTokens += cacheReadTokens;
      tracker.totalCost += price(inputTokens, outputTokens, cacheReadTokens);
    },

    isOverBudget() {
      return tracker.metered && budget !== null && tracker.totalCost >= budget;
    },

    formatCost() {
      const total = tracker.totalInputTokens + tracker.totalOutputTokens + tracker.totalCacheReadTokens;
      const cached = tracker.totalCacheReadTokens > 0 ? `, ${tracker.totalCacheReadTokens} cached` : "";
      const tokens = `${total} tokens${cached}`;
      if (!tracker.metered) {
        return `included (${tokens})`;
      }
      const cost = tracker.totalCost < 0.01
        ? `$${tracker.totalCost.toFixed(4)}`
        : `$${tracker.totalCost.toFixed(2)}`;
      const budgetStr = budget !== null ? ` / $${budget.toFixed(2)} budget` : "";
      return `${cost} (${tokens}${budgetStr})`;
    },

    formatTurnCost(inputTokens: number, outputTokens: number, cacheReadTokens = 0) {
      if (!tracker.metered) return "included";
      const turnCost = price(inputTokens, outputTokens, cacheReadTokens);
      return turnCost < 0.01
        ? `$${turnCost.toFixed(4)}`
        : `$${turnCost.toFixed(2)}`;
    },
  };

  return tracker;
}

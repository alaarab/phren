/** Cost tracking for LLM API usage. */
import { lookupPricing, type ModelPricing } from "./models.js";
import type { TokenUsage } from "./providers/types.js";
import { overridesFor } from "./model-overrides.js";

export interface CostTracker {
  /** Uncached input tokens. */
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Input tokens served from the provider's prompt cache. */
  totalCacheReadTokens: number;
  /** Input tokens written to the provider's prompt cache (Anthropic reports these). */
  totalCacheWriteTokens: number;
  totalCost: number;
  budget: number | null;
  metered: boolean;
  recordUsage(inputTokens: number, outputTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number): void;
  isOverBudget(): boolean;
  formatCost(): string;
  formatTurnCost(inputTokens: number, outputTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number): string;
}

/**
 * Price a model and endpoint. The --price-* flags (when this is the model
 * they were given for), then PHREN_AGENT_PRICE_IN/OUT/CACHE (USD per 1M),
 * take precedence over the catalog.
 */
export function resolvePricing(model: string, provider?: string, baseUrl?: string): { pricing: ModelPricing; metered: boolean } {
  const looked = lookupPricing(model, provider, baseUrl);
  const env = (key: string): number | undefined => {
    const raw = process.env[key];
    if (raw === undefined || raw === "") return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  const flags = overridesFor(model);
  const input = flags.priceIn ?? env("PHREN_AGENT_PRICE_IN");
  const output = flags.priceOut ?? env("PHREN_AGENT_PRICE_OUT");
  const cacheRead = flags.priceCache ?? env("PHREN_AGENT_PRICE_CACHE");
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

/** Prompt-cache writes cost this much more than ordinary input. */
export const CACHE_WRITE_MULTIPLIER = 1.25;

export function createCostTracker(model: string, budget: number | null = null, provider?: string, baseUrl?: string): CostTracker {
  const { pricing, metered } = resolvePricing(model, provider, baseUrl);
  // Without a cache price, hits bill as ordinary input (no discount assumed).
  const cacheReadPer1M = pricing.cacheReadPer1M ?? pricing.inputPer1M;
  // Cache writes bill at 1.25x input (Anthropic's 5-minute cache, the one
  // the agent asks for); providers that cache implicitly report none.
  const cacheWritePer1M = pricing.inputPer1M * CACHE_WRITE_MULTIPLIER;
  const price = (input: number, output: number, cacheRead: number, cacheWrite: number) =>
    (input / 1_000_000) * pricing.inputPer1M +
    (output / 1_000_000) * pricing.outputPer1M +
    (cacheRead / 1_000_000) * cacheReadPer1M +
    (cacheWrite / 1_000_000) * cacheWritePer1M;

  const tracker: CostTracker = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalCost: 0,
    budget,
    metered,

    recordUsage(inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0) {
      tracker.totalInputTokens += inputTokens;
      tracker.totalOutputTokens += outputTokens;
      tracker.totalCacheReadTokens += cacheReadTokens;
      tracker.totalCacheWriteTokens += cacheWriteTokens;
      tracker.totalCost += price(inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);
    },

    isOverBudget() {
      return tracker.metered && budget !== null && tracker.totalCost >= budget;
    },

    formatCost() {
      const total = tracker.totalInputTokens + tracker.totalOutputTokens + tracker.totalCacheReadTokens + tracker.totalCacheWriteTokens;
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

    formatTurnCost(inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0) {
      if (!tracker.metered) return "included";
      const turnCost = price(inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);
      return turnCost < 0.01
        ? `$${turnCost.toFixed(4)}`
        : `$${turnCost.toFixed(2)}`;
    },
  };

  return tracker;
}

/** Record one response's usage, every bucket included. */
export function recordTokenUsage(tracker: CostTracker, usage: TokenUsage): void {
  tracker.recordUsage(usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens);
}

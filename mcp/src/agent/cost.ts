/** Cost tracking for LLM API usage. */

interface ModelPricing {
  inputPer1M: number;   // $ per 1M input tokens
  outputPer1M: number;  // $ per 1M output tokens
}

// Pricing table — prefix match (most specific wins)
const PRICING: [string, ModelPricing][] = [
  // Anthropic
  ["claude-opus-4",       { inputPer1M: 15,   outputPer1M: 75 }],
  ["claude-sonnet-4",     { inputPer1M: 3,    outputPer1M: 15 }],
  ["claude-haiku-4",      { inputPer1M: 0.80, outputPer1M: 4 }],
  ["claude-3-5-sonnet",   { inputPer1M: 3,    outputPer1M: 15 }],
  ["claude-3-5-haiku",    { inputPer1M: 0.80, outputPer1M: 4 }],
  ["claude-3-opus",       { inputPer1M: 15,   outputPer1M: 75 }],
  // OpenAI
  ["gpt-5",              { inputPer1M: 2.50, outputPer1M: 10 }],
  ["gpt-4.1",            { inputPer1M: 2,    outputPer1M: 8 }],
  ["gpt-4o",             { inputPer1M: 2.50, outputPer1M: 10 }],
  ["gpt-4-turbo",        { inputPer1M: 10,   outputPer1M: 30 }],
  ["gpt-4",              { inputPer1M: 30,   outputPer1M: 60 }],
  ["o3",                 { inputPer1M: 2,    outputPer1M: 8 }],
  ["o4-mini",            { inputPer1M: 1.10, outputPer1M: 4.40 }],
  // OpenRouter prefixed
  ["anthropic/claude-opus-4",     { inputPer1M: 15,   outputPer1M: 75 }],
  ["anthropic/claude-sonnet-4",   { inputPer1M: 3,    outputPer1M: 15 }],
  ["anthropic/claude-haiku-4",    { inputPer1M: 0.80, outputPer1M: 4 }],
  ["openai/gpt-4o",               { inputPer1M: 2.50, outputPer1M: 10 }],
  // Local (free)
  ["ollama",             { inputPer1M: 0, outputPer1M: 0 }],
];

PRICING.sort((a, b) => b[0].length - a[0].length); // longest prefix first

function lookupPricing(model: string): ModelPricing {
  const lower = model.toLowerCase();
  for (const [prefix, pricing] of PRICING) {
    if (lower.startsWith(prefix)) return pricing;
  }
  // Default fallback — assume mid-tier pricing
  return { inputPer1M: 3, outputPer1M: 15 };
}

export interface CostTracker {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  budget: number | null;
  recordUsage(inputTokens: number, outputTokens: number): void;
  isOverBudget(): boolean;
  formatCost(): string;
  formatTurnCost(inputTokens: number, outputTokens: number): string;
}

export function createCostTracker(model: string, budget: number | null = null): CostTracker {
  const pricing = lookupPricing(model);

  const tracker: CostTracker = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    budget,

    recordUsage(inputTokens: number, outputTokens: number) {
      tracker.totalInputTokens += inputTokens;
      tracker.totalOutputTokens += outputTokens;
      tracker.totalCost +=
        (inputTokens / 1_000_000) * pricing.inputPer1M +
        (outputTokens / 1_000_000) * pricing.outputPer1M;
    },

    isOverBudget() {
      return budget !== null && tracker.totalCost >= budget;
    },

    formatCost() {
      const cost = tracker.totalCost < 0.01
        ? `$${tracker.totalCost.toFixed(4)}`
        : `$${tracker.totalCost.toFixed(2)}`;
      const tokens = `${tracker.totalInputTokens + tracker.totalOutputTokens} tokens`;
      const budgetStr = budget !== null ? ` / $${budget.toFixed(2)} budget` : "";
      return `${cost} (${tokens}${budgetStr})`;
    },

    formatTurnCost(inputTokens: number, outputTokens: number) {
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

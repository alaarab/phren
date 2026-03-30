export type ProviderId = "openrouter" | "anthropic" | "openai" | "openai-codex" | "ollama";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

export interface ModelCatalogEntry {
  id: string;
  provider: ProviderId;
  label: string;
  contextWindow: number;
  maxOutputTokens: number;
  reasoningDefault: ReasoningEffort | null;
  reasoningRange: ReasoningEffort[];
  pricing?: ModelPricing;
  metered?: boolean;
}

export const REASONING_LEVELS: ReasoningEffort[] = ["low", "medium", "high", "xhigh"];

const BUILTIN_MODELS: Record<ProviderId, ModelCatalogEntry[]> = {
  anthropic: [
    {
      id: "claude-sonnet-4-20250514",
      provider: "anthropic",
      label: "Sonnet 4",
      contextWindow: 200_000,
      maxOutputTokens: 16_384,
      reasoningDefault: "medium",
      reasoningRange: ["low", "medium", "high"],
      pricing: { inputPer1M: 3, outputPer1M: 15 },
    },
    {
      id: "claude-opus-4-20250514",
      provider: "anthropic",
      label: "Opus 4",
      contextWindow: 200_000,
      maxOutputTokens: 32_768,
      reasoningDefault: "high",
      reasoningRange: ["low", "medium", "high", "xhigh"],
      pricing: { inputPer1M: 15, outputPer1M: 75 },
    },
    {
      id: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      label: "Haiku 4.5",
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
      reasoningDefault: null,
      reasoningRange: [],
      pricing: { inputPer1M: 0.8, outputPer1M: 4 },
    },
  ],
  openrouter: [
    {
      id: "anthropic/claude-sonnet-4-20250514",
      provider: "openrouter",
      label: "Sonnet 4",
      contextWindow: 200_000,
      maxOutputTokens: 16_384,
      reasoningDefault: "medium",
      reasoningRange: ["low", "medium", "high"],
      pricing: { inputPer1M: 3, outputPer1M: 15 },
    },
    {
      id: "anthropic/claude-opus-4-20250514",
      provider: "openrouter",
      label: "Opus 4",
      contextWindow: 200_000,
      maxOutputTokens: 32_768,
      reasoningDefault: "high",
      reasoningRange: ["low", "medium", "high", "xhigh"],
      pricing: { inputPer1M: 15, outputPer1M: 75 },
    },
    {
      id: "openai/gpt-4o",
      provider: "openrouter",
      label: "GPT-4o",
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      reasoningDefault: null,
      reasoningRange: [],
      pricing: { inputPer1M: 2.5, outputPer1M: 10 },
    },
    {
      id: "openai/o4-mini",
      provider: "openrouter",
      label: "o4-mini",
      contextWindow: 128_000,
      maxOutputTokens: 100_000,
      reasoningDefault: "medium",
      reasoningRange: ["low", "medium", "high"],
      pricing: { inputPer1M: 1.1, outputPer1M: 4.4 },
    },
    {
      id: "google/gemini-2.5-pro",
      provider: "openrouter",
      label: "Gemini 2.5 Pro",
      contextWindow: 1_000_000,
      maxOutputTokens: 8_192,
      reasoningDefault: "medium",
      reasoningRange: ["low", "medium", "high"],
      pricing: { inputPer1M: 1.25, outputPer1M: 10 },
    },
    {
      id: "google/gemini-2.5-flash",
      provider: "openrouter",
      label: "Gemini 2.5 Flash",
      contextWindow: 1_000_000,
      maxOutputTokens: 8_192,
      reasoningDefault: "medium",
      reasoningRange: ["low", "medium", "high"],
      pricing: { inputPer1M: 0.15, outputPer1M: 0.6 },
    },
    {
      id: "deepseek/deepseek-r1",
      provider: "openrouter",
      label: "DeepSeek R1",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      reasoningDefault: "high",
      reasoningRange: ["medium", "high"],
      pricing: { inputPer1M: 0.55, outputPer1M: 2.19 },
    },
    {
      id: "deepseek/deepseek-v3",
      provider: "openrouter",
      label: "DeepSeek V3",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      reasoningDefault: null,
      reasoningRange: [],
      pricing: { inputPer1M: 0.27, outputPer1M: 1.1 },
    },
    {
      id: "meta-llama/llama-4-maverick",
      provider: "openrouter",
      label: "Llama 4 Maverick",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      reasoningDefault: null,
      reasoningRange: [],
      pricing: { inputPer1M: 0.5, outputPer1M: 0.7 },
    },
    {
      id: "qwen/qwen3-235b",
      provider: "openrouter",
      label: "Qwen 3 235B",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      reasoningDefault: "medium",
      reasoningRange: ["low", "medium", "high"],
      pricing: { inputPer1M: 0.8, outputPer1M: 2.4 },
    },
  ],
  openai: [
    {
      id: "gpt-5.4",
      provider: "openai",
      label: "GPT-5.4",
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      reasoningDefault: "medium",
      reasoningRange: ["low", "medium", "high", "xhigh"],
      pricing: { inputPer1M: 2.5, outputPer1M: 15 },
    },
    {
      id: "gpt-4o",
      provider: "openai",
      label: "GPT-4o",
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      reasoningDefault: null,
      reasoningRange: [],
      pricing: { inputPer1M: 2.5, outputPer1M: 10 },
    },
    {
      id: "o4-mini",
      provider: "openai",
      label: "o4-mini",
      contextWindow: 200_000,
      maxOutputTokens: 100_000,
      reasoningDefault: "medium",
      reasoningRange: ["low", "medium", "high"],
      pricing: { inputPer1M: 1.1, outputPer1M: 4.4 },
    },
    {
      id: "o3",
      provider: "openai",
      label: "o3",
      contextWindow: 200_000,
      maxOutputTokens: 100_000,
      reasoningDefault: "high",
      reasoningRange: ["low", "medium", "high", "xhigh"],
      pricing: { inputPer1M: 2, outputPer1M: 8 },
    },
  ],
  "openai-codex": [
    {
      id: "gpt-5.4",
      provider: "openai-codex",
      label: "GPT-5.4",
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      reasoningDefault: "medium",
      reasoningRange: ["low", "medium", "high", "xhigh"],
      metered: false,
    },
    {
      id: "gpt-4o",
      provider: "openai-codex",
      label: "GPT-4o",
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      reasoningDefault: null,
      reasoningRange: [],
      metered: false,
    },
    {
      id: "o4-mini",
      provider: "openai-codex",
      label: "o4-mini",
      contextWindow: 200_000,
      maxOutputTokens: 100_000,
      reasoningDefault: "medium",
      reasoningRange: ["low", "medium", "high"],
      metered: false,
    },
    {
      id: "o3",
      provider: "openai-codex",
      label: "o3",
      contextWindow: 200_000,
      maxOutputTokens: 100_000,
      reasoningDefault: "high",
      reasoningRange: ["low", "medium", "high", "xhigh"],
      metered: false,
    },
  ],
  ollama: [
    {
      id: "qwen2.5-coder:14b",
      provider: "ollama",
      label: "Qwen 2.5 Coder 14B",
      contextWindow: 32_000,
      maxOutputTokens: 8_192,
      reasoningDefault: null,
      reasoningRange: [],
      pricing: { inputPer1M: 0, outputPer1M: 0 },
      metered: false,
    },
    {
      id: "llama3.2",
      provider: "ollama",
      label: "Llama 3.2",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      reasoningDefault: null,
      reasoningRange: [],
      pricing: { inputPer1M: 0, outputPer1M: 0 },
      metered: false,
    },
    {
      id: "deepseek-r1:14b",
      provider: "ollama",
      label: "DeepSeek R1 14B",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      reasoningDefault: "medium",
      reasoningRange: ["medium", "high"],
      pricing: { inputPer1M: 0, outputPer1M: 0 },
      metered: false,
    },
  ],
};

const LEGACY_OUTPUT_LIMITS: Array<[string, number]> = [
  ["claude-opus-4", 32_768],
  ["claude-sonnet-4", 16_384],
  ["claude-haiku-4", 8_192],
  ["claude-3-5-sonnet", 8_192],
  ["claude-3-5-haiku", 8_192],
  ["claude-3-opus", 4_096],
  ["gpt-4.1", 32_768],
  ["gpt-4o", 16_384],
  ["gpt-4-turbo", 4_096],
  ["gpt-5", 128_000],
  ["o3", 100_000],
  ["o4-mini", 100_000],
  ["gemini-2.5", 8_192],
  ["deepseek", 8_192],
  ["llama-4", 8_192],
  ["qwen", 8_192],
];

const LEGACY_PRICING: Array<[string, ModelPricing]> = [
  ["claude-opus-4", { inputPer1M: 15, outputPer1M: 75 }],
  ["claude-sonnet-4", { inputPer1M: 3, outputPer1M: 15 }],
  ["claude-haiku-4", { inputPer1M: 0.8, outputPer1M: 4 }],
  ["claude-3-5-sonnet", { inputPer1M: 3, outputPer1M: 15 }],
  ["claude-3-5-haiku", { inputPer1M: 0.8, outputPer1M: 4 }],
  ["claude-3-opus", { inputPer1M: 15, outputPer1M: 75 }],
  ["gpt-5", { inputPer1M: 2.5, outputPer1M: 10 }],
  ["gpt-4.1", { inputPer1M: 2, outputPer1M: 8 }],
  ["gpt-4o", { inputPer1M: 2.5, outputPer1M: 10 }],
  ["gpt-4-turbo", { inputPer1M: 10, outputPer1M: 30 }],
  ["gpt-4", { inputPer1M: 30, outputPer1M: 60 }],
  ["o3", { inputPer1M: 2, outputPer1M: 8 }],
  ["o4-mini", { inputPer1M: 1.1, outputPer1M: 4.4 }],
  ["anthropic/claude-opus-4", { inputPer1M: 15, outputPer1M: 75 }],
  ["anthropic/claude-sonnet-4", { inputPer1M: 3, outputPer1M: 15 }],
  ["anthropic/claude-haiku-4", { inputPer1M: 0.8, outputPer1M: 4 }],
  ["openai/gpt-4o", { inputPer1M: 2.5, outputPer1M: 10 }],
  ["google/gemini-2.5-pro", { inputPer1M: 1.25, outputPer1M: 10 }],
  ["google/gemini-2.5-flash", { inputPer1M: 0.15, outputPer1M: 0.6 }],
  ["deepseek/deepseek-r1", { inputPer1M: 0.55, outputPer1M: 2.19 }],
  ["deepseek/deepseek-v3", { inputPer1M: 0.27, outputPer1M: 1.1 }],
  ["deepseek-r1", { inputPer1M: 0.55, outputPer1M: 2.19 }],
  ["deepseek-v3", { inputPer1M: 0.27, outputPer1M: 1.1 }],
  ["meta-llama/llama-4-maverick", { inputPer1M: 0.5, outputPer1M: 0.7 }],
  ["qwen/qwen3-235b", { inputPer1M: 0.8, outputPer1M: 2.4 }],
  ["gemini-2.5-pro", { inputPer1M: 1.25, outputPer1M: 10 }],
  ["gemini-2.5-flash", { inputPer1M: 0.15, outputPer1M: 0.6 }],
  ["ollama", { inputPer1M: 0, outputPer1M: 0 }],
];

LEGACY_OUTPUT_LIMITS.sort((a, b) => b[0].length - a[0].length);
LEGACY_PRICING.sort((a, b) => b[0].length - a[0].length);

export function normalizeProviderId(provider: string | undefined): ProviderId | undefined {
  if (!provider) return undefined;
  if (provider === "codex") return "openai-codex";
  if (
    provider === "openrouter" ||
    provider === "anthropic" ||
    provider === "openai" ||
    provider === "openai-codex" ||
    provider === "ollama"
  ) {
    return provider;
  }
  return undefined;
}

export function normalizeReasoningEffort(raw: string | null | undefined): ReasoningEffort | undefined {
  if (!raw) return undefined;
  const value = raw.toLowerCase();
  if (value === "max") return "xhigh";
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") return value;
  return undefined;
}

export function getDefaultModel(provider: ProviderId): string {
  return BUILTIN_MODELS[provider][0].id;
}

export function getBuiltinModels(provider: ProviderId): ModelCatalogEntry[] {
  return BUILTIN_MODELS[provider].map((entry) => ({
    ...entry,
    reasoningRange: [...entry.reasoningRange],
    pricing: entry.pricing ? { ...entry.pricing } : undefined,
  }));
}

export function getModelMetadata(provider: string | undefined, model: string): ModelCatalogEntry | undefined {
  const normalizedProvider = normalizeProviderId(provider);

  if (normalizedProvider) {
    const direct = BUILTIN_MODELS[normalizedProvider].find((entry) => entry.id === model);
    if (direct) return direct;
  }

  for (const entries of Object.values(BUILTIN_MODELS)) {
    const direct = entries.find((entry) => entry.id === model);
    if (direct) return direct;
  }

  return undefined;
}

export function getDefaultReasoningEffort(provider: string | undefined, model: string): ReasoningEffort | undefined {
  return getModelMetadata(provider, model)?.reasoningDefault ?? undefined;
}

export function getReasoningRange(provider: string | undefined, model: string): ReasoningEffort[] {
  return [...(getModelMetadata(provider, model)?.reasoningRange ?? [])];
}

export function lookupMaxOutputTokens(model: string, provider?: string): number {
  const metadata = getModelMetadata(provider, model);
  if (metadata) return metadata.maxOutputTokens;

  const lower = model.toLowerCase();
  for (const [prefix, limit] of LEGACY_OUTPUT_LIMITS) {
    if (lower.startsWith(prefix)) return limit;
  }
  return 8_192;
}

export function lookupPricing(model: string, provider?: string): { pricing: ModelPricing; metered: boolean } {
  const normalizedProvider = normalizeProviderId(provider);
  if (normalizedProvider === "openai-codex") {
    return { pricing: { inputPer1M: 0, outputPer1M: 0 }, metered: false };
  }

  const metadata = getModelMetadata(provider, model);
  if (metadata?.pricing) {
    return { pricing: metadata.pricing, metered: metadata.metered ?? true };
  }
  if (metadata?.metered === false) {
    return { pricing: { inputPer1M: 0, outputPer1M: 0 }, metered: false };
  }

  const lower = model.toLowerCase();
  for (const [prefix, pricing] of LEGACY_PRICING) {
    if (lower.startsWith(prefix)) return { pricing, metered: true };
  }

  return { pricing: { inputPer1M: 3, outputPer1M: 15 }, metered: true };
}

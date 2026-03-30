import type { LlmProvider } from "./types.js";
import { OpenRouterProvider, OpenAiProvider } from "./openrouter.js";
import { AnthropicProvider } from "./anthropic.js";
import { OllamaProvider } from "./ollama.js";
import { CodexProvider } from "./codex.js";
import { hasCodexToken } from "./codex-auth.js";
import { resolveApiKey } from "@phren/cli/auth/profiles";
import {
  getDefaultModel,
  getDefaultReasoningEffort,
  lookupMaxOutputTokens,
  normalizeProviderId,
  normalizeReasoningEffort,
} from "../models.js";

function normalizeProviderSelection(
  overrideProvider?: string,
  overrideModel?: string,
): { provider?: string; model?: string } {
  let provider = normalizeProviderId(overrideProvider ?? process.env.PHREN_AGENT_PROVIDER);
  let model = overrideModel;

  if (model) {
    if ((!provider || provider === "openai") && model.startsWith("openai/")) {
      provider = "openai";
      model = model.slice("openai/".length);
    } else if ((!provider || provider === "openai-codex") && model.startsWith("openai-codex/")) {
      provider = "openai-codex";
      model = model.slice("openai-codex/".length);
    }
  }

  return { provider, model };
}

export function resolveProvider(
  overrideProvider?: string,
  overrideModel?: string,
  overrideMaxOutput?: number,
  overrideReasoning?: string,
): LlmProvider {
  const { provider: explicit, model: normalizedModel } = normalizeProviderSelection(overrideProvider, overrideModel);
  const normalizedReasoning = normalizeReasoningEffort(overrideReasoning ?? process.env.PHREN_AGENT_REASONING);
  const openRouterKey = resolveApiKey("openrouter", "OPENROUTER_API_KEY");
  const anthropicKey = resolveApiKey("anthropic", "ANTHROPIC_API_KEY");
  const openAiKey = resolveApiKey("openai", "OPENAI_API_KEY");

  // Resolve max output tokens: CLI override > model lookup > default 8192
  const resolveLimit = (provider: string, model: string) => overrideMaxOutput ?? lookupMaxOutputTokens(model, provider);
  const resolveReasoning = (provider: string, model: string) => normalizedReasoning ?? getDefaultReasoningEffort(provider, model);

  // Prefer Codex subscription and GPT-5.4 when available.
  if (explicit === "openai-codex" || (!explicit && hasCodexToken())) {
    const model = normalizedModel ?? getDefaultModel("openai-codex");
    return new CodexProvider(model, resolveLimit("openai-codex", model), resolveReasoning("openai-codex", model));
  }

  if (explicit === "openai" || (!explicit && openAiKey)) {
    if (!openAiKey) throw new Error("OpenAI credentials are required. Set OPENAI_API_KEY or run 'phren auth set-key openai'.");
    const model = normalizedModel ?? getDefaultModel("openai");
    return new OpenAiProvider(openAiKey, model, undefined, resolveLimit("openai", model), resolveReasoning("openai", model));
  }

  if (explicit === "openrouter" || (!explicit && openRouterKey)) {
    if (!openRouterKey) throw new Error("OpenRouter credentials are required. Set OPENROUTER_API_KEY or run 'phren auth set-key openrouter'.");
    const model = normalizedModel ?? getDefaultModel("openrouter");
    return new OpenRouterProvider(openRouterKey, model, undefined, resolveLimit("openrouter", model));
  }

  if (explicit === "anthropic" || (!explicit && anthropicKey)) {
    if (!anthropicKey) throw new Error("Anthropic credentials are required. Set ANTHROPIC_API_KEY or run 'phren auth set-key anthropic'.");
    const model = normalizedModel ?? getDefaultModel("anthropic");
    return new AnthropicProvider(anthropicKey, model, resolveLimit("anthropic", model));
  }

  if (explicit === "ollama" || (!explicit && process.env.PHREN_OLLAMA_URL && process.env.PHREN_OLLAMA_URL !== "off")) {
    const model = normalizedModel ?? getDefaultModel("ollama");
    return new OllamaProvider(model, process.env.PHREN_OLLAMA_URL, resolveLimit("ollama", model));
  }

  // Last resort: try Ollama at default URL
  if (!explicit) {
    const model = normalizedModel ?? getDefaultModel("ollama");
    return new OllamaProvider(model, undefined, resolveLimit("ollama", model));
  }

  throw new Error(
    `Unknown provider "${explicit}". Supported: openrouter, anthropic, openai, openai-codex, ollama.\n` +
    "Set one of: OPENROUTER_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, or run 'phren auth login' for Codex.",
  );
}

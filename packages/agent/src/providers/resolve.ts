import type { LlmProvider } from "./types.js";
import { OpenRouterProvider, OpenAiProvider } from "./openrouter.js";
import { AnthropicProvider } from "./anthropic.js";
import { OllamaProvider } from "./ollama.js";
import { CodexProvider } from "./codex.js";
import { ReplayProvider } from "./replay.js";
import { codexConfiguredModel, hasCodexToken } from "./codex-auth.js";
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

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

export interface ResolveOptions {
  /** Endpoint for openai-compat (required there) or an override for deepseek. */
  baseUrl?: string;
}

export function resolveProvider(
  overrideProvider?: string,
  overrideModel?: string,
  overrideMaxOutput?: number,
  overrideReasoning?: string,
  options: ResolveOptions = {},
): LlmProvider {
  // Keyless replay of a recorded session — takes precedence over everything
  // so regression tests can run the real binary with no credentials at all.
  if (process.env.PHREN_AGENT_REPLAY) {
    return ReplayProvider.fromEventLog(process.env.PHREN_AGENT_REPLAY);
  }

  // Generic OpenAI-compatible endpoint: not a catalog provider, so it is
  // handled before normalization and needs an explicit model.
  const rawProvider = (overrideProvider ?? process.env.PHREN_AGENT_PROVIDER)?.toLowerCase();
  if (rawProvider === "openai-compat" || rawProvider === "compat") {
    const baseUrl = (options.baseUrl ?? process.env.PHREN_AGENT_BASE_URL)?.replace(/\/+$/, "");
    if (!baseUrl) {
      throw new Error("openai-compat needs an endpoint: pass --base-url <url> or set PHREN_AGENT_BASE_URL (e.g. https://host/v1).");
    }
    if (!overrideModel) throw new Error("openai-compat needs --model <id> (the endpoint's model name).");
    const key = process.env.PHREN_AGENT_API_KEY ?? "";
    const reasoning = normalizeReasoningEffort(overrideReasoning ?? process.env.PHREN_AGENT_REASONING);
    return new OpenAiProvider(key, overrideModel, baseUrl, overrideMaxOutput, reasoning).withName("openai-compat", overrideMaxOutput);
  }

  const { provider: explicit, model: normalizedModel } = normalizeProviderSelection(overrideProvider, overrideModel);
  if (rawProvider && !explicit) {
    // A typo must not silently fall through to auto-detection.
    throw new Error(
      `Unknown provider "${rawProvider}". Supported: openai-codex, openai, openrouter, anthropic, deepseek, openai-compat, ollama.`,
    );
  }
  const normalizedReasoning = normalizeReasoningEffort(overrideReasoning ?? process.env.PHREN_AGENT_REASONING);
  const openRouterKey = resolveApiKey("openrouter", "OPENROUTER_API_KEY");
  const anthropicKey = resolveApiKey("anthropic", "ANTHROPIC_API_KEY");
  const openAiKey = resolveApiKey("openai", "OPENAI_API_KEY");

  // Resolve max output tokens: CLI override > model lookup > default 8192
  const resolveLimit = (provider: string, model: string) => overrideMaxOutput ?? lookupMaxOutputTokens(model, provider);
  const resolveReasoning = (provider: string, model: string) => normalizedReasoning ?? getDefaultReasoningEffort(provider, model);

  // Prefer Codex subscription and GPT-5.4 when available.
  if (explicit === "openai-codex" || (!explicit && hasCodexToken())) {
    const model = normalizedModel ?? codexConfiguredModel() ?? getDefaultModel("openai-codex");
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
    return new OpenRouterProvider(openRouterKey, model, undefined, resolveLimit("openrouter", model), resolveReasoning("openrouter", model));
  }

  if (explicit === "anthropic" || (!explicit && anthropicKey)) {
    if (!anthropicKey) throw new Error("Anthropic credentials are required. Set ANTHROPIC_API_KEY or run 'phren auth set-key anthropic'.");
    const model = normalizedModel ?? getDefaultModel("anthropic");
    return new AnthropicProvider(
      anthropicKey,
      model,
      resolveLimit("anthropic", model),
      true,
      resolveReasoning("anthropic", model),
    );
  }

  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  if (explicit === "deepseek" || (!explicit && deepseekKey)) {
    if (!deepseekKey) throw new Error("DeepSeek credentials are required. Set DEEPSEEK_API_KEY.");
    const model = normalizedModel ?? getDefaultModel("deepseek");
    const baseUrl = (options.baseUrl ?? DEEPSEEK_BASE_URL).replace(/\/+$/, "");
    return new OpenAiProvider(deepseekKey, model, baseUrl, resolveLimit("deepseek", model), resolveReasoning("deepseek", model))
      .withName("deepseek", overrideMaxOutput ?? lookupMaxOutputTokens(model, "deepseek"));
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
    `Unknown provider "${explicit}". Supported: openai-codex, openai, openrouter, anthropic, deepseek, openai-compat, ollama.\n` +
    "Set one of: OPENROUTER_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY, or run 'phren auth login' for Codex.",
  );
}

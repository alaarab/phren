import type { LlmProvider } from "./types.js";
import { overridesFor } from "../model-overrides.js";
import { OpenRouterProvider, OpenAiProvider } from "./openrouter.js";
import { AnthropicProvider } from "./anthropic.js";
import { OllamaProvider } from "./ollama.js";
import { CodexProvider } from "./codex.js";
import { ReplayProvider } from "./replay.js";
import { codexConfiguredModel, hasCodexToken } from "./codex-auth.js";
import { resolveConnector } from "../provider-connectors.js";
import { acceptsNoReasoning, isDeepSeekRoute } from "./openai-compat.js";
import { OpenAiResponsesProvider } from "./openai-responses.js";
import {
  getModelMetadata,
  getDiscoveredModels,
  getDefaultModel,
  getDefaultReasoningEffort,
  lookupMaxOutputTokens,
  normalizeProviderId,
  normalizeReasoningEffort,
  type ReasoningEffort,
} from "../models.js";

function normalizeSelectedReasoning(raw: string | undefined): ReasoningEffort | undefined {
  if (!raw) return undefined;
  const effort = normalizeReasoningEffort(raw);
  if (!effort) throw new Error(`Unknown reasoning effort "${raw}".`);
  return effort;
}

/** Validate before changing the active provider, so status matches the request. */
function selectedEffort(provider: string, model: string, raw: string | undefined): ReasoningEffort | undefined {
  const effort = normalizeSelectedReasoning(raw);
  if (!effort) return getDefaultReasoningEffort(provider, model);
  if (effort === "none" && !isDeepSeekRoute(provider, model) && provider !== "anthropic"
    && !((provider === "openai" || provider === "openai-codex") && acceptsNoReasoning(model))) {
    throw new Error(`${provider}/${model} does not advertise reasoning off; choose a supported effort or omit --reasoning.`);
  }
  const metadata = getModelMetadata(provider, model);
  if (metadata && !metadata.reasoningRange.includes(effort) && effort !== "none") {
    throw new Error(`${provider}/${model} does not support reasoning ${effort}. Supported: ${metadata.reasoningRange.join(", ") || "model default only"}.`);
  }
  return effort;
}

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

/**
 * The DeepSeek endpoint this session started on, when it was not the default
 * (a proxy via --base-url). /model switches resolve the provider again with
 * no options, so a switch back to a DeepSeek model would otherwise go to
 * api.deepseek.com. Kept per provider rather than read from
 * PHREN_AGENT_BASE_URL, which a session started on openai-compat sets to its
 * relay: a DeepSeek key must never be sent there.
 */
let sessionDeepSeekUrl: string | undefined;

/** Remember the session's provider endpoint for later /model switches. */
export function keepSessionEndpoint(provider: Pick<LlmProvider, "name" | "baseUrl">): void {
  sessionDeepSeekUrl = provider.name === "deepseek" && provider.baseUrl && provider.baseUrl !== DEEPSEEK_BASE_URL
    ? provider.baseUrl
    : undefined;
}

/**
 * DeepSeek's endpoint: an explicit option, else the session's own DeepSeek
 * endpoint, else PHREN_AGENT_BASE_URL when the environment also names
 * DeepSeek as the provider, else DeepSeek's API.
 */
function deepSeekBaseUrl(options: ResolveOptions): string {
  const fromEnv = normalizeProviderId(process.env.PHREN_AGENT_PROVIDER) === "deepseek"
    ? process.env.PHREN_AGENT_BASE_URL
    : undefined;
  return resolveConnector("deepseek", options.baseUrl ?? sessionDeepSeekUrl ?? fromEnv).baseUrl ?? DEEPSEEK_BASE_URL;
}

export interface ResolveOptions {
  /** Endpoint for openai-compat (required there) or an override for deepseek. */
  baseUrl?: string;
  /** Context window in tokens, overriding the catalog (else the model's --context-window, else PHREN_AGENT_CONTEXT_WINDOW). */
  contextWindow?: number;
}

/** A positive integer token count from a flag or env value, else undefined. */
export function parseTokenCount(raw: string | number | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = typeof raw === "number" ? raw : Number(String(raw).replace(/_/g, ""));
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export function resolveProvider(
  overrideProvider?: string,
  overrideModel?: string,
  overrideMaxOutput?: number,
  overrideReasoning?: string,
  options: ResolveOptions = {},
): LlmProvider {
  const provider = resolveCatalogProvider(overrideProvider, overrideModel, overrideMaxOutput, overrideReasoning, options);
  // The catalog can't know every relay's window (and compaction keys off
  // it): an explicit option wins, then --context-window when this is the
  // model it was given for, then PHREN_AGENT_CONTEXT_WINDOW for any model.
  const contextWindow = options.contextWindow
    ?? overridesFor(provider.model).contextWindow
    ?? parseTokenCount(process.env.PHREN_AGENT_CONTEXT_WINDOW);
  if (contextWindow) provider.contextWindow = contextWindow;
  return provider;
}

function resolveCatalogProvider(
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
    const connector = resolveConnector("openai-compat", options.baseUrl);
    const baseUrl = connector.baseUrl;
    if (!baseUrl) {
      throw new Error("openai-compat needs an endpoint: pass --base-url <url> or set PHREN_AGENT_BASE_URL (e.g. https://host/v1).");
    }
    const model = overrideModel ?? connector.model ?? getDiscoveredModels("openai-compat")?.find(model => model.catalogSource !== "fallback")?.id;
    if (!model) throw new Error("openai-compat needs --model <id> (the endpoint's model name).");
    // OpenCode's configured Go/Zen connector can be reused without copying
    // its key into a second Phren-specific variable. No key is ever printed.
    const key = connector.apiKey ?? "";
    const reasoning = selectedEffort("openai-compat", model, overrideReasoning ?? process.env.PHREN_AGENT_REASONING);
    return new OpenAiProvider(key, model, baseUrl, overrideMaxOutput, reasoning).withName("openai-compat", overrideMaxOutput);
  }

  const { provider: explicit, model: normalizedModel } = normalizeProviderSelection(overrideProvider, overrideModel);
  if (rawProvider && !explicit) {
    // A typo must not silently fall through to auto-detection.
    throw new Error(
      `Unknown provider "${rawProvider}". Supported: openai-codex, openai, openrouter, anthropic, deepseek, openai-compat, ollama.`,
    );
  }
  const openRouter = resolveConnector("openrouter", explicit === "openrouter" ? options.baseUrl : undefined);
  const anthropic = resolveConnector("anthropic", explicit === "anthropic" ? options.baseUrl : undefined);
  const openAi = resolveConnector("openai", explicit === "openai" ? options.baseUrl : undefined);
  const openRouterKey = openRouter.apiKey;
  const anthropicKey = anthropic.apiKey;
  const openAiKey = openAi.apiKey;

  // Resolve max output tokens: CLI override > model lookup > default 8192
  const resolveLimit = (provider: string, model: string) => overrideMaxOutput ?? lookupMaxOutputTokens(model, provider);
  const resolveReasoning = (provider: string, model: string) => selectedEffort(provider, model, overrideReasoning ?? process.env.PHREN_AGENT_REASONING);

  // Prefer the installed Codex subscription and its selected model when available.
  if (explicit === "openai-codex" || (!explicit && hasCodexToken())) {
    const model = normalizedModel ?? codexConfiguredModel() ?? getDefaultModel("openai-codex");
    return new CodexProvider(model, resolveLimit("openai-codex", model), resolveReasoning("openai-codex", model));
  }

  if (explicit === "openai" || (!explicit && openAi.configured)) {
    if (!openAiKey) throw new Error("OpenAI credentials are required. Set OPENAI_API_KEY or run 'phren auth set-key openai'.");
    const model = normalizedModel ?? openAi.model ?? getDefaultModel("openai");
    const Provider = /^(gpt-[56]|o[134])(?:[.-]|$)/.test(model) ? OpenAiResponsesProvider : OpenAiProvider;
    return new Provider(openAiKey, model, openAi.baseUrl, resolveLimit("openai", model), resolveReasoning("openai", model));
  }

  if (explicit === "openrouter" || (!explicit && openRouter.configured)) {
    if (!openRouterKey) throw new Error("OpenRouter credentials are required. Set OPENROUTER_API_KEY or run 'phren auth set-key openrouter'.");
    const model = normalizedModel ?? openRouter.model ?? getDefaultModel("openrouter");
    return new OpenRouterProvider(openRouterKey, model, openRouter.baseUrl, resolveLimit("openrouter", model), resolveReasoning("openrouter", model));
  }

  if (explicit === "anthropic" || (!explicit && anthropic.configured)) {
    if (!anthropicKey) throw new Error("Anthropic credentials are required. Set ANTHROPIC_API_KEY or run 'phren auth set-key anthropic'.");
    const model = normalizedModel ?? anthropic.model ?? getDefaultModel("anthropic");
    return new AnthropicProvider(
      anthropicKey,
      model,
      resolveLimit("anthropic", model),
      true,
      resolveReasoning("anthropic", model),
      anthropic.baseUrl,
    );
  }

  const deepseek = resolveConnector("deepseek");
  const deepseekKey = deepseek.apiKey;
  if (explicit === "deepseek" || (!explicit && deepseek.configured)) {
    if (!deepseekKey) throw new Error("DeepSeek credentials are required. Set DEEPSEEK_API_KEY.");
    const model = normalizedModel ?? deepseek.model ?? getDefaultModel("deepseek");
    const baseUrl = deepSeekBaseUrl(options);
    return new OpenAiProvider(deepseekKey, model, baseUrl, resolveLimit("deepseek", model), resolveReasoning("deepseek", model))
      .withName("deepseek", overrideMaxOutput ?? lookupMaxOutputTokens(model, "deepseek"));
  }

  if (!explicit && resolveConnector("openai-compat").configured) {
    return resolveCatalogProvider("openai-compat", normalizedModel, overrideMaxOutput, overrideReasoning, options);
  }

  const local = resolveConnector("ollama");
  if (explicit === "ollama" || (!explicit && local.configured)) {
    const model = normalizedModel ?? local.model ?? getDefaultModel("ollama");
    return new OllamaProvider(model, local.baseUrl, resolveLimit("ollama", model));
  }

  // Last resort: try Ollama at default URL
  if (!explicit) {
    const model = normalizedModel ?? local.model ?? getDefaultModel("ollama");
    return new OllamaProvider(model, undefined, resolveLimit("ollama", model));
  }

  throw new Error(
    `Unknown provider "${explicit}". Supported: openai-codex, openai, openrouter, anthropic, deepseek, openai-compat, ollama.\n` +
    "Set one of: OPENROUTER_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY, or run 'phren auth login' for Codex.",
  );
}

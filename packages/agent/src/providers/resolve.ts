import type { LlmProvider } from "./types.js";
import { OpenRouterProvider, OpenAiProvider } from "./openrouter.js";
import { AnthropicProvider } from "./anthropic.js";
import { OllamaProvider } from "./ollama.js";
import { CodexProvider } from "./codex.js";
import { hasCodexToken } from "./codex-auth.js";
import { lookupMaxOutputTokens } from "../cost.js";

export function resolveProvider(overrideProvider?: string, overrideModel?: string, overrideMaxOutput?: number): LlmProvider {
  const explicit = overrideProvider ?? process.env.PHREN_AGENT_PROVIDER;

  // Resolve max output tokens: CLI override > model lookup > default 8192
  const resolveLimit = (model: string) => overrideMaxOutput ?? lookupMaxOutputTokens(model);

  if (explicit === "openrouter" || (!explicit && process.env.OPENROUTER_API_KEY)) {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error("OPENROUTER_API_KEY is required for OpenRouter provider.");
    const model = overrideModel ?? "anthropic/claude-sonnet-4-20250514";
    return new OpenRouterProvider(key, overrideModel, undefined, resolveLimit(model));
  }

  if (explicit === "anthropic" || (!explicit && process.env.ANTHROPIC_API_KEY)) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("ANTHROPIC_API_KEY is required for Anthropic provider.");
    const model = overrideModel ?? "claude-sonnet-4-20250514";
    return new AnthropicProvider(key, overrideModel, resolveLimit(model));
  }

  if (explicit === "openai" || (!explicit && process.env.OPENAI_API_KEY)) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY is required for OpenAI provider.");
    const model = overrideModel ?? "gpt-4o";
    return new OpenAiProvider(key, overrideModel, undefined, resolveLimit(model));
  }

  // Codex: uses your ChatGPT subscription directly — no API key, no middleman
  if (explicit === "codex" || (!explicit && hasCodexToken())) {
    const model = overrideModel ?? "gpt-5.2-codex";
    return new CodexProvider(overrideModel, resolveLimit(model));
  }

  if (explicit === "ollama" || (!explicit && process.env.PHREN_OLLAMA_URL && process.env.PHREN_OLLAMA_URL !== "off")) {
    const model = overrideModel ?? "qwen2.5-coder:14b";
    return new OllamaProvider(overrideModel, process.env.PHREN_OLLAMA_URL, resolveLimit(model));
  }

  // Last resort: try Ollama at default URL
  if (!explicit) {
    const model = overrideModel ?? "qwen2.5-coder:14b";
    return new OllamaProvider(overrideModel, undefined, resolveLimit(model));
  }

  throw new Error(
    `Unknown provider "${explicit}". Supported: openrouter, anthropic, openai, codex, ollama.\n` +
    "Set one of: OPENROUTER_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, or run 'phren-agent auth login' for Codex.",
  );
}

import { OpenRouterProvider, OpenAiProvider } from "./openrouter.js";
import { AnthropicProvider } from "./anthropic.js";
import { OllamaProvider } from "./ollama.js";
import { CodexProvider } from "./codex.js";
import { hasCodexToken } from "./codex-auth.js";
export function resolveProvider(overrideProvider, overrideModel) {
    const explicit = overrideProvider ?? process.env.PHREN_AGENT_PROVIDER;
    if (explicit === "openrouter" || (!explicit && process.env.OPENROUTER_API_KEY)) {
        const key = process.env.OPENROUTER_API_KEY;
        if (!key)
            throw new Error("OPENROUTER_API_KEY is required for OpenRouter provider.");
        return new OpenRouterProvider(key, overrideModel);
    }
    if (explicit === "anthropic" || (!explicit && process.env.ANTHROPIC_API_KEY)) {
        const key = process.env.ANTHROPIC_API_KEY;
        if (!key)
            throw new Error("ANTHROPIC_API_KEY is required for Anthropic provider.");
        return new AnthropicProvider(key, overrideModel);
    }
    if (explicit === "openai" || (!explicit && process.env.OPENAI_API_KEY)) {
        const key = process.env.OPENAI_API_KEY;
        if (!key)
            throw new Error("OPENAI_API_KEY is required for OpenAI provider.");
        return new OpenAiProvider(key, overrideModel);
    }
    // Codex: uses your ChatGPT subscription directly — no API key, no middleman
    if (explicit === "codex" || (!explicit && hasCodexToken())) {
        return new CodexProvider(overrideModel);
    }
    if (explicit === "ollama" || (!explicit && process.env.PHREN_OLLAMA_URL && process.env.PHREN_OLLAMA_URL !== "off")) {
        return new OllamaProvider(overrideModel, process.env.PHREN_OLLAMA_URL);
    }
    // Last resort: try Ollama at default URL
    if (!explicit) {
        return new OllamaProvider(overrideModel);
    }
    throw new Error(`Unknown provider "${explicit}". Supported: openrouter, anthropic, openai, codex, ollama.\n` +
        "Set one of: OPENROUTER_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, or run 'phren-agent auth login' for Codex.");
}

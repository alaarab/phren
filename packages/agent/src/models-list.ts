/**
 * `phren-agent models --json`: the models this computer can run, for the
 * phren Hook's model picker. Only providers with credentials here are
 * listed, in the order auto-detection picks them, so the first is the
 * default. Each id is `<provider>/<model>`; the Hook passes it back as
 * `--provider` and `--model`. Loads no agent runtime and makes no request.
 */
import { resolveApiKey } from "@phren/cli/auth/profiles";
import { codexConfiguredModel, hasCodexToken } from "./providers/codex-auth.js";
import { getBuiltinModels, getDefaultModel, type ProviderId } from "./models.js";

export interface ListedModel {
  id: string;
  name: string;
  provider: ProviderId;
  description: string;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts: string[];
}

const PROVIDER_NAMES: Partial<Record<ProviderId, string>> = {
  "openai-codex": "ChatGPT subscription",
  openai: "OpenAI API",
  openrouter: "OpenRouter",
  anthropic: "Anthropic API",
  deepseek: "DeepSeek API",
  ollama: "Ollama",
};

/** Providers with credentials on this computer, in resolveProvider's order.
 * openai-compat needs an endpoint and model of its own, so it is never listed. */
export function credentialedProviders(env: NodeJS.ProcessEnv = process.env): ProviderId[] {
  const providers: ProviderId[] = [];
  if (hasCodexToken()) providers.push("openai-codex");
  if (resolveApiKey("openai", "OPENAI_API_KEY")) providers.push("openai");
  if (resolveApiKey("openrouter", "OPENROUTER_API_KEY")) providers.push("openrouter");
  if (resolveApiKey("anthropic", "ANTHROPIC_API_KEY")) providers.push("anthropic");
  if (env.DEEPSEEK_API_KEY) providers.push("deepseek");
  if (env.PHREN_OLLAMA_URL && env.PHREN_OLLAMA_URL !== "off") providers.push("ollama");
  return providers;
}

export function listModels(providers: ProviderId[] = credentialedProviders()): ListedModel[] {
  const models: ListedModel[] = [];
  for (const provider of providers) {
    const entries = getBuiltinModels(provider);
    // Codex's own config can name a model the catalog doesn't have yet.
    const configured = provider === "openai-codex" ? codexConfiguredModel() : undefined;
    if (configured && !entries.some(entry => entry.id === configured)) {
      entries.unshift({ ...entries[0], id: configured, label: configured });
    }
    const preferred = configured ?? getDefaultModel(provider);
    for (const entry of entries) {
      models.push({
        id: `${provider}/${entry.id}`,
        name: entry.label,
        provider,
        description: PROVIDER_NAMES[provider] ?? provider,
        ...(!models.some(model => model.isDefault) && entry.id === preferred ? { isDefault: true } : {}),
        ...(entry.reasoningDefault && entry.reasoningDefault !== "none" ? { defaultReasoningEffort: entry.reasoningDefault } : {}),
        supportedReasoningEfforts: entry.reasoningRange.filter(level => level !== "none"),
      });
    }
  }
  return models;
}

export function printModels(args: string[]): void {
  const models = listModels();
  if (args.includes("--json")) { console.log(JSON.stringify({ models })); return; }
  if (!models.length) { console.log("No provider credentials found. See phren-agent --help."); return; }
  for (const model of models) console.log(`${model.isDefault ? "*" : " "} ${model.id.padEnd(48)} ${model.name} (${model.description})`);
}

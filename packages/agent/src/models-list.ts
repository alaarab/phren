/**
 * `phren-agent models --json`: the models this computer can run, for the
 * phren Hook's model picker. Only providers with credentials here are
 * listed, in the order auto-detection picks them, so the first is the
 * default. Each id is `<provider>/<model>`; the Hook passes it back as
 * `--provider` and `--model`. The bin refreshes the bounded catalogue cache
 * before calling this formatter; it never starts a completion.
 */
import { resolveConnector } from "./provider-connectors.js";
import { codexConfiguredModel } from "./providers/codex-auth.js";
import { getBuiltinModels, getDefaultModel, getDiscoveredModels, type ProviderId } from "./models.js";
import { catalogStatusFor, credentialedProviders as discoveredCredentialedProviders, refreshModelCatalogs } from "./model-discovery.js";

export interface ListedModel {
  id: string;
  name: string;
  provider: ProviderId;
  description: string;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts: string[];
  catalogStatus?: "live" | "cached" | "stale" | "offline";
}

const PROVIDER_NAMES: Partial<Record<ProviderId, string>> = {
  "openai-codex": "ChatGPT subscription",
  openai: "OpenAI API",
  openrouter: "OpenRouter",
  anthropic: "Anthropic API",
  deepseek: "DeepSeek API",
  "openai-compat": "OpenAI-compatible endpoint",
  ollama: "Ollama",
};

/** Providers with credentials/connectors on this computer, in resolveProvider's order. */
export function credentialedProviders(env: NodeJS.ProcessEnv = process.env): ProviderId[] {
  return discoveredCredentialedProviders(env);
}

export function listModels(providers: ProviderId[] = credentialedProviders()): ListedModel[] {
  const models: ListedModel[] = [];
  for (const provider of providers) {
    const entries = getDiscoveredModels(provider) ?? getBuiltinModels(provider);
    // Codex's own config can name a model the catalog doesn't have yet.
    const configured = provider === "openai-codex" ? codexConfiguredModel() : resolveConnector(provider).model;
    if (configured && !entries.some(entry => entry.id === configured)) {
      entries.unshift({ provider, id: configured, label: configured, reasoningDefault: null, reasoningRange: [] });
    }
    const preferred = configured ?? entries[0]?.id ?? getDefaultModel(provider);
    for (const entry of entries) {
      models.push({
        id: `${provider}/${entry.id}`,
        name: entry.label,
        provider,
        description: PROVIDER_NAMES[provider] ?? provider,
        catalogStatus: entries[0]?.catalogSource === "fallback" ? "offline" : catalogStatusFor(provider),
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
  if (args.includes("--json")) {
    const statuses = Object.fromEntries([...new Set(models.map((model) => model.provider))].map((provider) => [provider, catalogStatusFor(provider)]));
    console.log(JSON.stringify({ models, catalogStatus: statuses }));
    return;
  }
  if (!models.length) { console.log("No provider credentials found. See phren-agent --help."); return; }
  for (const model of models) console.log(`${model.isDefault ? "*" : " "} ${model.id.padEnd(48)} ${model.name} (${model.description})`);
}

export async function refreshModelsCommand(args: string[]): Promise<void> {
  await refreshModelCatalogs(args.includes("--refresh"));
  printModels(args);
}

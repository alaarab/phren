/** One connection resolver for model discovery, inference and auth status.
 * Keys stay in memory; status output never serializes a connection object. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { resolveApiKey } from "@phren/cli/auth/profiles";
import { hasCodexToken } from "./providers/codex-auth.js";
import type { ProviderId } from "./models.js";

export interface ProviderConnector {
  provider: ProviderId;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  configured: boolean;
  authSource: "env" | "profile" | "codex-cli" | "opencode" | "local" | "none";
}
const ORDER: ProviderId[] = ["openai-codex", "openai", "openrouter", "anthropic", "deepseek", "openai-compat", "ollama"];
const DEFAULT_URLS: Partial<Record<ProviderId, string>> = {
  openai: "https://api.openai.com/v1", openrouter: "https://openrouter.ai/api/v1",
  anthropic: "https://api.anthropic.com", deepseek: "https://api.deepseek.com", ollama: "http://localhost:11434",
};
const KEY_ENV: Partial<Record<ProviderId, string>> = {
  openai: "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY", anthropic: "ANTHROPIC_API_KEY",
  deepseek: "DEEPSEEK_API_KEY", "openai-compat": "PHREN_AGENT_API_KEY",
};
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function readObject(file: string): Record<string, unknown> {
  try {
    const raw = readFileSync(file, "utf8");
    return raw.length <= 1_048_576 ? object(JSON.parse(raw)) : {};
  } catch { return {}; }
}
function endpoint(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const url = new URL(raw);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Provider endpoints must be HTTP(S) URLs without embedded credentials, query parameters or fragments. Use apiKeyEnv for keys.");
  }
  return raw.replace(/\/+$/, "");
}

/** Explicit connection config wins; existing Phren and OpenCode API-key
 * credentials are reused without copying or exposing them. OpenCode OAuth
 * tokens are not treated as API keys. Codex keeps its existing OAuth flow. */
export function resolveConnector(provider: ProviderId, overrideBaseUrl?: string, env: NodeJS.ProcessEnv = process.env): ProviderConnector {
  const config = readObject(env.PHREN_AGENT_PROVIDERS_CONFIG || path.join(homedir(), ".phren-agent", "providers.json"));
  const own = object(object(config.providers)[provider]);
  const dataHome = env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
  const auth = readObject(path.join(dataHome, "opencode", "auth.json"));
  const openCodeConfig = readObject(env.OPENCODE_CONFIG || path.join(env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "opencode", "opencode.json"));
  const go = object(auth["opencode-go"]);
  const defaultGo = provider === "openai-compat" && !overrideBaseUrl && !env.PHREN_AGENT_BASE_URL && !env.OPENCODE_BASE_URL && !own.baseUrl
    && go.type === "api" && !!text(go.key);
  const imported = text(own.opencodeProvider) ?? (defaultGo ? "opencode-go" : provider);
  const importedAuth = object(auth[imported]);
  const importedOptions = object(object(object(openCodeConfig.provider)[imported]).options);
  const keyEnv = text(own.apiKeyEnv) ?? KEY_ENV[provider];
  const envKey = keyEnv ? text(env[keyEnv]) ?? (provider === "openai-compat" && !own.apiKeyEnv ? text(env.OPENCODE_API_KEY) : undefined) : undefined;
  const profileKey = ["openai", "openrouter", "anthropic"].includes(provider) && !own.apiKeyEnv
    ? resolveApiKey(provider as "openai" | "openrouter" | "anthropic", KEY_ENV[provider]!) ?? undefined : undefined;
  const importedKey = importedAuth.type === "api" ? text(importedAuth.key) : undefined;
  const apiKey = own.apiKeyEnv ? envKey : envKey ?? profileKey ?? importedKey;
  const envUrl = provider === "openai-compat" ? text(env.PHREN_AGENT_BASE_URL) ?? text(env.OPENCODE_BASE_URL)
    : provider === "ollama" ? (env.PHREN_OLLAMA_URL === "off" ? undefined : text(env.PHREN_OLLAMA_URL))
      : provider === "deepseek" && env.PHREN_AGENT_PROVIDER === "deepseek" ? text(env.PHREN_AGENT_BASE_URL) : undefined;
  const baseUrl = endpoint(overrideBaseUrl ?? envUrl ?? text(own.baseUrl) ?? text(importedOptions.baseURL)
    ?? (provider === "openai-compat" && imported === "opencode-go" ? "https://opencode.ai/zen/go/v1" : DEFAULT_URLS[provider]));
  let authSource: ProviderConnector["authSource"] = envKey ? "env" : profileKey ? "profile" : importedKey ? "opencode" : "none";
  let configured = !!apiKey;
  if (provider === "openai-codex") { configured = hasCodexToken(); authSource = configured ? "codex-cli" : "none"; }
  if (provider === "ollama") { configured = env.PHREN_OLLAMA_URL !== "off" && (!!env.PHREN_OLLAMA_URL || Object.keys(own).length > 0); authSource = "local"; }
  if (provider === "openai-compat") configured = !!baseUrl; // local compatible servers may be keyless
  if (own.enabled === false) configured = false;
  return { provider, baseUrl, apiKey, model: text(own.model), configured, authSource };
}

export function configuredProviders(env: NodeJS.ProcessEnv = process.env): ProviderId[] {
  return ORDER.filter(provider => resolveConnector(provider, undefined, env).configured);
}

export function providerAuthStatuses(): Array<Omit<ProviderConnector, "apiKey">> {
  return ORDER.map(provider => {
    const { apiKey: _key, ...status } = resolveConnector(provider);
    return status;
  });
}

/**
 * Provider management: auth, model registry, live switching.
 *
 * /provider        — show configured providers + auth status
 * /provider add    — interactive provider setup (enter key, auth login, etc.)
 * /provider switch — change active provider mid-session
 * /model add <id>  — add a custom model to the catalog
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { ReasoningLevel } from "./model-picker.js";
import { getBuiltinModels, getDiscoveredModels, type ProviderId } from "../models.js";
import { catalogStatusFor } from "../model-discovery.js";
import { providerAuthStatuses } from "../provider-connectors.js";
export type { ReasoningLevel } from "./model-picker.js";

const CONFIG_DIR = path.join(os.homedir(), ".phren-agent");
const PROVIDERS_FILE = path.join(CONFIG_DIR, "providers.json");

// ── Provider status ─────────────────────────────────────────────────────────

export interface ProviderStatus {
  name: string;
  configured: boolean;
  authMethod: "api-key" | "oauth" | "local" | "none";
  authSource?: "env" | "profile" | "codex-cli" | "opencode" | "local" | "none";
  keyEnvVar?: string;
  models: string[];
  catalogStatus?: "live" | "cached" | "stale" | "offline";
}

function modelIds(provider: ProviderId): string[] {
  return (getDiscoveredModels(provider) ?? getBuiltinModels(provider)).map((model) => model.id);
}

export function getProviderStatuses(): ProviderStatus[] {
  return providerAuthStatuses().map((status) => ({
    name: status.provider,
    configured: status.configured,
    authMethod: status.provider === "openai-codex" ? "oauth" : status.provider === "ollama" ? "local" : "api-key",
    authSource: status.authSource,
    ...((status.provider === "openai" || status.provider === "openrouter" || status.provider === "anthropic") ? { keyEnvVar: `${status.provider === "openrouter" ? "OPENROUTER" : status.provider.toUpperCase()}_API_KEY` } : {}),
    ...(status.provider === "deepseek" ? { keyEnvVar: "DEEPSEEK_API_KEY" } : {}),
    ...(status.provider === "openai-compat" ? { keyEnvVar: "PHREN_AGENT_API_KEY" } : {}),
    models: modelIds(status.provider),
    catalogStatus: catalogStatusFor(status.provider),
  }));
}

// ── Custom model registry ───────────────────────────────────────────────────

interface CustomModelEntry {
  id: string;
  provider: string;
  label: string;
  contextWindow: number;
  reasoning: ReasoningLevel;
  reasoningRange: ReasoningLevel[];
  addedAt: string;
}

interface ProvidersConfig {
  customModels: CustomModelEntry[];
  [key: string]: unknown;
}

function loadConfig(): ProvidersConfig {
  try {
    const config = JSON.parse(fs.readFileSync(process.env.PHREN_AGENT_PROVIDERS_CONFIG || PROVIDERS_FILE, "utf-8"));
    return config && typeof config === "object" && !Array.isArray(config)
      ? { ...config, customModels: Array.isArray(config.customModels) ? config.customModels : [] }
      : { customModels: [] };
  } catch {
    return { customModels: [] };
  }
}

function saveConfig(config: ProvidersConfig): void {
  const file = process.env.PHREN_AGENT_PROVIDERS_CONFIG || PROVIDERS_FILE;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export function addCustomModel(
  id: string,
  provider: string,
  opts?: {
    label?: string;
    contextWindow?: number;
    reasoning?: ReasoningLevel;
    reasoningRange?: ReasoningLevel[];
  },
): CustomModelEntry {
  const config = loadConfig();
  // Remove existing with same id
  config.customModels = config.customModels.filter((m) => m.id !== id);
  const entry: CustomModelEntry = {
    id,
    provider,
    label: opts?.label ?? id,
    contextWindow: opts?.contextWindow ?? 128_000,
    reasoning: opts?.reasoning ?? null,
    reasoningRange: opts?.reasoningRange ?? [],
    addedAt: new Date().toISOString(),
  };
  config.customModels.push(entry);
  saveConfig(config);
  return entry;
}

export function removeCustomModel(id: string): boolean {
  const config = loadConfig();
  const before = config.customModels.length;
  config.customModels = config.customModels.filter((m) => m.id !== id);
  if (config.customModels.length === before) return false;
  saveConfig(config);
  return true;
}

export function getCustomModels(): CustomModelEntry[] {
  return loadConfig().customModels;
}

// ── Format helpers for CLI display ──────────────────────────────────────────

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

export function formatProviderList(): string {
  const statuses = getProviderStatuses();
  const lines: string[] = [`\n  ${BOLD}Providers${RESET}\n`];

  for (const p of statuses) {
    const icon = p.configured ? `${GREEN}●${RESET}` : `${RED}○${RESET}`;
    const auth = p.configured ? `${GREEN}configured${RESET}` : p.authMethod === "oauth"
      ? `${DIM}run: phren auth login${RESET}`
      : p.keyEnvVar
        ? `${DIM}set ${p.keyEnvVar} or configure providers.json${RESET}`
        : `${DIM}local${RESET}`;
    const source = p.configured && p.authSource && p.authSource !== "none"
      ? `${DIM}${p.authSource}${RESET}`
      : null;
    const modelCount = `${DIM}${p.models.length} models${p.catalogStatus && p.catalogStatus !== "offline" ? `, ${p.catalogStatus}` : ""}${RESET}`;
    lines.push(`  ${icon} ${BOLD}${p.name}${RESET}  ${auth}${source ? `  ${source}` : ""}  ${modelCount}`);
  }

  const custom = getCustomModels();
  if (custom.length > 0) {
    lines.push(`\n  ${DIM}Custom models: ${custom.map((m) => m.id).join(", ")}${RESET}`);
  }

  lines.push(`\n  ${DIM}/provider add${RESET} to configure  ${DIM}/model add <id>${RESET} to add model\n`);
  return lines.join("\n");
}

export function formatModelAddHelp(): string {
  return `${DIM}Usage: /model add <model-id> [provider=X] [context=128000] [reasoning=low|medium|high|xhigh]

Examples:
  /model add meta-llama/llama-3.1-405b provider=openrouter context=128000
  /model add claude-3-haiku-20240307 provider=anthropic
  /model add codestral:latest provider=ollama reasoning=medium${RESET}`;
}

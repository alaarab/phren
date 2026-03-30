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
import { hasCodexToken } from "../providers/codex-auth.js";
import { getAuthStatusEntries } from "@phren/cli/auth/profiles";
import type { ReasoningLevel } from "./model-picker.js";
import { getBuiltinModels } from "../models.js";
export type { ReasoningLevel } from "./model-picker.js";

const CONFIG_DIR = path.join(os.homedir(), ".phren-agent");
const PROVIDERS_FILE = path.join(CONFIG_DIR, "providers.json");

// ── Provider status ─────────────────────────────────────────────────────────

export interface ProviderStatus {
  name: string;
  configured: boolean;
  authMethod: "api-key" | "oauth" | "local" | "none";
  authSource?: "env" | "profile" | "codex-cli" | "none";
  keyEnvVar?: string;
  models: string[];
}

export function getProviderStatuses(): ProviderStatus[] {
  const auth = new Map(getAuthStatusEntries().map((entry) => [entry.provider, entry]));
  return [
    {
      name: "openrouter",
      configured: auth.get("openrouter")?.configured ?? false,
      authMethod: "api-key",
      authSource: auth.get("openrouter")?.source ?? "none",
      keyEnvVar: "OPENROUTER_API_KEY",
      models: getBuiltinModels("openrouter").map((model) => model.id),
    },
    {
      name: "anthropic",
      configured: auth.get("anthropic")?.configured ?? false,
      authMethod: "api-key",
      authSource: auth.get("anthropic")?.source ?? "none",
      keyEnvVar: "ANTHROPIC_API_KEY",
      models: getBuiltinModels("anthropic").map((model) => model.id),
    },
    {
      name: "openai",
      configured: auth.get("openai")?.configured ?? false,
      authMethod: "api-key",
      authSource: auth.get("openai")?.source ?? "none",
      keyEnvVar: "OPENAI_API_KEY",
      models: getBuiltinModels("openai").map((model) => model.id),
    },
    {
      name: "openai-codex",
      configured: hasCodexToken(),
      authMethod: "oauth",
      authSource: auth.get("openai-codex")?.source ?? "none",
      models: getBuiltinModels("openai-codex").map((model) => model.id),
    },
    {
      name: "ollama",
      configured: (process.env.PHREN_OLLAMA_URL ?? "").toLowerCase() !== "off",
      authMethod: "local",
      models: getBuiltinModels("ollama").map((model) => model.id),
    },
  ];
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
}

function loadConfig(): ProvidersConfig {
  try {
    return JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf-8"));
  } catch {
    return { customModels: [] };
  }
}

function saveConfig(config: ProvidersConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${PROVIDERS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
  fs.renameSync(tmp, PROVIDERS_FILE);
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
        ? `${DIM}set ${p.keyEnvVar} or phren auth set-key ${p.name}${RESET}`
        : `${DIM}local${RESET}`;
    const source = p.configured && p.authSource && p.authSource !== "none"
      ? `${DIM}${p.authSource}${RESET}`
      : null;
    const modelCount = `${DIM}${p.models.length} models${RESET}`;
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

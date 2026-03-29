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
import type { ModelEntry, ReasoningLevel } from "./model-picker.js";
export type { ReasoningLevel } from "./model-picker.js";

const CONFIG_DIR = path.join(os.homedir(), ".phren-agent");
const PROVIDERS_FILE = path.join(CONFIG_DIR, "providers.json");

// ── Provider status ─────────────────────────────────────────────────────────

export interface ProviderStatus {
  name: string;
  configured: boolean;
  authMethod: "api-key" | "oauth" | "local" | "none";
  keyEnvVar?: string;
  models: string[];
}

export function getProviderStatuses(): ProviderStatus[] {
  return [
    {
      name: "openrouter",
      configured: !!process.env.OPENROUTER_API_KEY,
      authMethod: "api-key",
      keyEnvVar: "OPENROUTER_API_KEY",
      models: ["anthropic/claude-sonnet-4", "anthropic/claude-opus-4", "openai/gpt-4o", "openai/o4-mini", "google/gemini-2.5-pro", "deepseek/deepseek-r1"],
    },
    {
      name: "anthropic",
      configured: !!process.env.ANTHROPIC_API_KEY,
      authMethod: "api-key",
      keyEnvVar: "ANTHROPIC_API_KEY",
      models: ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-haiku-4-5-20251001"],
    },
    {
      name: "openai",
      configured: !!process.env.OPENAI_API_KEY,
      authMethod: "api-key",
      keyEnvVar: "OPENAI_API_KEY",
      models: ["gpt-4o", "o4-mini", "o3"],
    },
    {
      name: "codex",
      configured: hasCodexToken(),
      authMethod: "oauth",
      models: ["gpt-4o", "o4-mini", "o3"],
    },
    {
      name: "ollama",
      configured: (process.env.PHREN_OLLAMA_URL ?? "").toLowerCase() !== "off",
      authMethod: "local",
      models: ["qwen2.5-coder:14b", "llama3.2", "deepseek-r1:14b"],
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

/** Get all models for a provider (built-in + custom). */
export function getAllModelsForProvider(provider: string, currentModel?: string): ModelEntry[] {
  // Import dynamically to avoid circular dep
  const { getAvailableModels } = require("./model-picker.js") as typeof import("./model-picker.js");
  const builtIn = getAvailableModels(provider, currentModel);

  // Add custom models for this provider
  const custom = getCustomModels().filter((m) => m.provider === provider);
  for (const c of custom) {
    if (!builtIn.some((b) => b.id === c.id)) {
      builtIn.push({
        id: c.id,
        provider: provider as ModelEntry["provider"],
        label: c.label + " ★",
        reasoning: c.reasoning,
        reasoningRange: c.reasoningRange,
        contextWindow: c.contextWindow,
      });
    }
  }

  return builtIn;
}

// ── Format helpers for CLI display ──────────────────────────────────────────

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

export function formatProviderList(): string {
  const statuses = getProviderStatuses();
  const lines: string[] = [`\n  ${BOLD}Providers${RESET}\n`];

  for (const p of statuses) {
    const icon = p.configured ? `${GREEN}●${RESET}` : `${RED}○${RESET}`;
    const auth = p.configured ? `${GREEN}configured${RESET}` : p.authMethod === "oauth"
      ? `${DIM}run: phren agent auth login${RESET}`
      : p.keyEnvVar
        ? `${DIM}set ${p.keyEnvVar}${RESET}`
        : `${DIM}local${RESET}`;
    const modelCount = `${DIM}${p.models.length} models${RESET}`;
    lines.push(`  ${icon} ${BOLD}${p.name}${RESET}  ${auth}  ${modelCount}`);
  }

  const custom = getCustomModels();
  if (custom.length > 0) {
    lines.push(`\n  ${DIM}Custom models: ${custom.map((m) => m.id).join(", ")}${RESET}`);
  }

  lines.push(`\n  ${DIM}/provider add${RESET} to configure  ${DIM}/model add <id>${RESET} to add model\n`);
  return lines.join("\n");
}

export function formatModelAddHelp(): string {
  return `${DIM}Usage: /model add <model-id> [provider=X] [context=128000] [reasoning=low|medium|high|max]

Examples:
  /model add meta-llama/llama-3.1-405b provider=openrouter context=128000
  /model add claude-3-haiku-20240307 provider=anthropic
  /model add codestral:latest provider=ollama reasoning=medium${RESET}`;
}

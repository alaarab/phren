/**
 * Interactive model picker with inline reasoning effort slider.
 *
 * /model opens a navigable picker:
 *   ▸ claude-sonnet-4-20250514          ◐◐◐○○ medium
 *     claude-opus-4-20250514            ●●●●● high
 *     gpt-4o                            ◐◐◐○○ medium
 *     o4-mini                           ●●●○○ high
 *     qwen2.5-coder:14b                 ───── n/a
 *
 * Up/Down to navigate, Left/Right to adjust reasoning, Enter to select, Esc to cancel.
 */
import { pickerRows, pickerWindow, movePicker, moveReasoning } from "./picker-navigation.js";
import * as readline from "node:readline";
import { getBuiltinModels, getDiscoveredModels, normalizeProviderId, REASONING_LEVELS, type ProviderId, type ReasoningEffort } from "../models.js";
import { catalogStatusFor, discoverAllProviders, discoverProvider, type CatalogStatus } from "../model-discovery.js";

const ESC = "\x1b[";
const s = {
  bold: (t: string) => `${ESC}1m${t}${ESC}0m`,
  dim: (t: string) => `${ESC}2m${t}${ESC}0m`,
  cyan: (t: string) => `${ESC}36m${t}${ESC}0m`,
  green: (t: string) => `${ESC}32m${t}${ESC}0m`,
  yellow: (t: string) => `${ESC}33m${t}${ESC}0m`,
  magenta: (t: string) => `${ESC}35m${t}${ESC}0m`,
  gray: (t: string) => `${ESC}90m${t}${ESC}0m`,
};

// ── Model catalog ───────────────────────────────────────────────────────────

export type ReasoningLevel = ReasoningEffort | null;

export interface ModelEntry {
  id: string;
  provider: ProviderId;
  label: string;
  reasoning: ReasoningLevel;       // current reasoning level
  reasoningRange: ReasoningLevel[]; // available levels (empty = no reasoning control)
  contextWindow?: number;
  catalogStatus?: CatalogStatus;
}

/** Models available per provider. Extend as needed. */
export function getAvailableModels(provider: string, currentModel?: string): ModelEntry[] {
  const providers: ProviderId[] = provider === "*"
    ? ["openai-codex", "openai", "openrouter", "anthropic", "deepseek", "openai-compat", "ollama"]
    : [normalizeProviderId(provider) ?? "openrouter"];
  const models: ModelEntry[] = providers.flatMap((normalizedProvider) => {
    const entries = getDiscoveredModels(normalizedProvider) ?? getBuiltinModels(normalizedProvider);
    return entries.map((model) => ({
      id: model.id,
      provider: model.provider,
      label: provider === "*" ? `${model.provider}/${model.label}` : model.label,
      reasoning: model.reasoningDefault,
      reasoningRange: [...model.reasoningRange],
      contextWindow: model.contextWindow,
      catalogStatus: model.catalogSource === "fallback" ? "offline" : catalogStatusFor(normalizedProvider),
    }));
  });

  // If user has a custom model not in the list, add it
  if (currentModel && !models.some((m) => m.id === currentModel)) {
    models.unshift({
      id: currentModel,
      provider: provider as ModelEntry["provider"],
      label: currentModel,
      reasoning: null,
      reasoningRange: [],
      contextWindow: 200_000,
    });
  }

  return models;
}

/** Fetches all configured provider catalogues, then returns the same rows the picker uses. */
export async function discoverAvailableModels(currentProvider: string, currentModel?: string): Promise<ModelEntry[]> {
  const provider = normalizeProviderId(currentProvider);
  const catalogs = await discoverAllProviders();
  if (provider && !catalogs.some((catalog) => catalog.provider === provider)) catalogs.push(await discoverProvider(provider));
  const rows: ModelEntry[] = catalogs.flatMap((catalog) => catalog.models.map((model) => ({
    id: model.id,
    provider: model.provider,
    label: `${model.provider}/${model.label}`,
    reasoning: model.reasoningDefault,
    reasoningRange: [...model.reasoningRange],
    contextWindow: model.contextWindow,
    catalogStatus: catalog.status,
  })));
  if (currentModel && provider && !rows.some((model) => model.provider === provider && model.id === currentModel)) {
    rows.unshift({ id: currentModel, provider, label: `${provider}/${currentModel}`, reasoning: null, reasoningRange: [], contextWindow: undefined, catalogStatus: "offline" });
  }
  return rows;
}

// ── Reasoning meter rendering ───────────────────────────────────────────────

function renderReasoningMeter(level: ReasoningLevel, range: ReasoningLevel[]): string {
  if (range.length === 0 || level === null) return s.dim("─────");

  const maxSlots = 5;
  const levelIdx = REASONING_LEVELS.indexOf(level);
  const filled = levelIdx < 0 ? 0 : Math.min(levelIdx + 1, maxSlots);

  let meter = "";
  for (let i = 0; i < maxSlots; i++) {
    meter += i < filled ? "●" : "○";
  }

  const color = filled >= 4 ? s.magenta : filled >= 3 ? s.yellow : filled >= 2 ? s.green : s.cyan;
  const label = level ?? "n/a";
  return `${color(meter)} ${s.dim(label)}`;
}

// ── Interactive picker ──────────────────────────────────────────────────────

export interface PickerResult {
  /** "" keeps the provider's default model. */
  model: string;
  reasoning: ReasoningLevel;
  /** Switch to this provider too; the current one when absent. */
  provider?: string;
}

/**
 * Show interactive model picker. Returns selected model + reasoning, or null on cancel.
 * Works in raw mode — caller must be in raw mode already (TUI) or we'll set it.
 */
export async function showModelPicker(
  provider: string,
  currentModel: string | undefined,
  currentReasoning: ReasoningLevel | undefined,
  w: NodeJS.WriteStream,
): Promise<PickerResult | null> {
  const models = await discoverAvailableModels(provider, currentModel);
  if (models.length === 0) {
    w.write(s.dim("  No models available for this provider.\n"));
    return Promise.resolve(null);
  }

  const currentProvider = normalizeProviderId(provider);
  let cursor = models.findIndex((m) => m.provider === currentProvider && m.id === currentModel);
  if (cursor < 0) cursor = 0;

  // Clone reasoning levels so we can adjust them
  const reasoningState = models.map((m) => m.provider === currentProvider && m.id === currentModel && !!currentReasoning && m.reasoningRange.includes(currentReasoning)
    ? currentReasoning
    : m.reasoning);

  let query = "";
  let renderedLines = 0;
  function render() {
    if (renderedLines) w.write(`${ESC}${renderedLines}A${ESC}J`);
    drawPicker();
  }
  function drawPicker() {
    const rows = pickerRows(models, query);
    const visible = pickerWindow(rows, cursor, Math.max(3, Math.min(12, (w.rows || 24) - 6)));
    const width = Math.max(12, (w.columns || 100) - 35);
    w.write(`  ${s.bold("Select model")} ${s.dim("↑↓ move · ←→ effort · enter select · esc cancel")}\n`);
    w.write(`  Search: ${query || "type to filter"} (${rows.length} models)\n`);
    for (const i of visible) {
      const m = models[i];
      const name = m.label.length > width ? m.label.slice(0, width - 1) + "…" : m.label;
      const text = name.padEnd(width);
      w.write(`  ${i === cursor ? s.cyan("▸") : " "} ${i === cursor ? s.bold(text) : s.dim(text)}  ${renderReasoningMeter(reasoningState[i], m.reasoningRange)}\n`);
    }
    if (!visible.length) w.write("  No matching models.\n");
    renderedLines = Math.max(1, visible.length) + 2;
  }

  // Initial draw
  drawPicker();

  return new Promise((resolve) => {
    function onKey(_ch: string, key: readline.Key) {
      if (!key) return;

      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        cleanup();
        resolve(null);
        return;
      }

      const rows = pickerRows(models, query);
      if (key.name === "return") {
        if (!rows.length) return;
        const m = models[cursor];
        cleanup();
        resolve({ model: m.id, provider: m.provider, reasoning: reasoningState[cursor] });
        return;
      }

      if (key.name === "up") {
        cursor = movePicker(rows, cursor, -1);
        render();
        return;
      }

      if (key.name === "down") {
        cursor = movePicker(rows, cursor, 1);
        render();
        return;
      }

      // Left/Right: adjust reasoning level
      if (key.name === "left" || key.name === "right") {
        const m = models[cursor];
        if (m.reasoningRange.length === 0) return; // no reasoning for this model

        reasoningState[cursor] = moveReasoning(m.reasoningRange, reasoningState[cursor], key.name === "right" ? 1 : -1);

        render();
        return;
      }
      if (key.name === "backspace" || (_ch && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(_ch))) {
        query = key.name === "backspace" ? query.slice(0, -1) : (query + _ch).slice(0, 100);
        const matches = pickerRows(models, query);
        if (matches.length && !matches.includes(cursor)) cursor = matches[0];
        render();
      }
    }

    function cleanup() {
      process.stdin.removeListener("keypress", onKey);
    }

    process.stdin.on("keypress", onKey);
  });
}

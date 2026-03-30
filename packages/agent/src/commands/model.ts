/**
 * Model commands: /model, /provider, /preset
 */
import type { CommandContext } from "../commands.js";
import { listPresets, loadPreset, savePreset, deletePreset, formatPreset } from "../multi/presets.js";
import { showModelPicker } from "../multi/model-picker.js";
import { formatProviderList, formatModelAddHelp, addCustomModel, removeCustomModel, type ReasoningLevel } from "../multi/provider-manager.js";
import { normalizeReasoningEffort } from "../models.js";

const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

export function modelCommand(parts: string[], ctx: CommandContext): boolean {
  const sub = parts[1]?.toLowerCase();

  // /model add <id> [provider=X] [context=N] [reasoning=X]
  if (sub === "add") {
    const modelId = parts[2];
    if (!modelId) {
      process.stderr.write(formatModelAddHelp() + "\n");
      return true;
    }
    let provider = ctx.providerName ?? "openrouter";
    let contextWindow = 128_000;
    let reasoning: ReasoningLevel = null;
    const reasoningRange: ReasoningLevel[] = [];
    for (const arg of parts.slice(3)) {
      const [k, v] = arg.split("=", 2);
      if (k === "provider") provider = v;
      else if (k === "context") contextWindow = parseInt(v, 10) || 128_000;
      else if (k === "reasoning") {
        reasoning = normalizeReasoningEffort(v) ?? null;
        reasoningRange.push("low", "medium", "high");
        if (reasoning === "xhigh") reasoningRange.push("xhigh");
      }
    }
    addCustomModel(modelId, provider, { contextWindow, reasoning, reasoningRange });
    process.stderr.write(`${GREEN}-> Added ${modelId} to ${provider}${RESET}\n`);
    return true;
  }

  // /model remove <id>
  if (sub === "remove" || sub === "rm") {
    const modelId = parts[2];
    if (!modelId) {
      process.stderr.write(`${DIM}Usage: /model remove <model-id>${RESET}\n`);
      return true;
    }
    const ok = removeCustomModel(modelId);
    process.stderr.write(ok ? `${GREEN}-> Removed ${modelId}${RESET}\n` : `${DIM}Model "${modelId}" not found in custom models.${RESET}\n`);
    return true;
  }

  // /model (no sub) -- interactive picker
  if (!ctx.providerName) {
    process.stderr.write(`${DIM}Provider not configured. Start with --provider to set one.${RESET}\n`);
    return true;
  }
  showModelPicker(ctx.providerName, ctx.currentModel, ctx.currentReasoning, process.stdout).then((result) => {
    if (result && ctx.onModelChange) {
      ctx.onModelChange(result);
      const reasoningLabel = result.reasoning ? ` (reasoning: ${result.reasoning})` : "";
      process.stderr.write(`${GREEN}-> ${result.model}${reasoningLabel}${RESET}\n`);
    } else if (result) {
      process.stderr.write(`${DIM}Model selected: ${result.model} -- restart to apply.${RESET}\n`);
    }
  });
  return true;
}

export function providerCommand(_parts: string[], _ctx: CommandContext): boolean {
  process.stderr.write(formatProviderList());
  return true;
}

export function presetCommand(parts: string[], _ctx: CommandContext): boolean {
  const sub = parts[1]?.toLowerCase();

  if (!sub || sub === "list") {
    const all = listPresets();
    if (all.length === 0) {
      process.stderr.write(`${DIM}No presets.${RESET}\n`);
    } else {
      const lines = all.map((p) => `  ${formatPreset(p.name, p.preset, p.builtin)}`);
      process.stderr.write(`${DIM}Presets:\n${lines.join("\n")}${RESET}\n`);
    }
    return true;
  }

  if (sub === "save") {
    const presetName = parts[2];
    if (!presetName) {
      process.stderr.write(`${DIM}Usage: /preset save <name> [provider=X] [model=X] [permissions=X] [max-turns=N] [budget=N] [plan]${RESET}\n`);
      return true;
    }
    const preset: Record<string, unknown> = {};
    for (const arg of parts.slice(3)) {
      const [k, v] = arg.split("=", 2);
      if (k === "provider") preset.provider = v;
      else if (k === "model") preset.model = v;
      else if (k === "permissions") preset.permissions = v;
      else if (k === "max-turns") preset.maxTurns = parseInt(v, 10) || undefined;
      else if (k === "budget") preset.budget = v === "none" ? null : parseFloat(v) || undefined;
      else if (k === "plan") preset.plan = true;
    }
    try {
      savePreset(presetName, preset as import("../multi/presets.js").Preset);
      process.stderr.write(`${DIM}Saved preset "${presetName}".${RESET}\n`);
    } catch (err: unknown) {
      process.stderr.write(`${DIM}${err instanceof Error ? err.message : String(err)}${RESET}\n`);
    }
    return true;
  }

  if (sub === "delete") {
    const presetName = parts[2];
    if (!presetName) {
      process.stderr.write(`${DIM}Usage: /preset delete <name>${RESET}\n`);
      return true;
    }
    try {
      const ok = deletePreset(presetName);
      process.stderr.write(`${DIM}${ok ? `Deleted "${presetName}".` : `Preset "${presetName}" not found.`}${RESET}\n`);
    } catch (err: unknown) {
      process.stderr.write(`${DIM}${err instanceof Error ? err.message : String(err)}${RESET}\n`);
    }
    return true;
  }

  // /preset <name> -- show preset details
  const preset = loadPreset(sub);
  if (!preset) {
    process.stderr.write(`${DIM}Preset "${sub}" not found. Use /preset list to see available presets.${RESET}\n`);
  } else {
    const isBuiltin = ["fast", "careful", "yolo"].includes(sub);
    process.stderr.write(`${DIM}${formatPreset(sub, preset, isBuiltin)}\nUse: phren-agent --preset ${sub} <task>${RESET}\n`);
  }
  return true;
}

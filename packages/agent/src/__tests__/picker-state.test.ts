import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pickerRows, pickerWindow, movePicker, moveReasoning } from "../multi/picker-navigation.js";
import type { ModelEntry } from "../multi/model-picker.js";
import { loadModelSelection, saveModelSelection, restoreModelSelection } from "../settings.js";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "phren-picker-state-"));
  vi.stubEnv("HOME", home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("searchable picker and remembered selection", () => {
  it("keeps provider identity and selection while filtering and scrolling a large catalogue", () => {
    const models: ModelEntry[] = Array.from({ length: 300 }, (_, i) => ({
      id: `model-${Math.floor(i / 2)}`, provider: i % 2 ? "openrouter" : "openai",
      label: `Model ${Math.floor(i / 2)}`, reasoning: null, reasoningRange: [],
    }));
    const rows = pickerRows(models, "openrouter model-12");
    expect(rows).toEqual([25, 241, 243, 245, 247, 249, 251, 253, 255, 257, 259]);
    const cursor = movePicker(rows, rows[rows.length - 1], 1);
    expect(cursor).toBe(25);
    expect(models[cursor]).toMatchObject({ provider: "openrouter", id: "model-12" });
    const visible = pickerWindow(pickerRows(models, ""), 280, 10);
    expect(visible).toHaveLength(10);
    expect(visible).toContain(280);
    expect(pickerRows(models, "missing model")).toEqual([]);
    expect(movePicker([], 25, 1)).toBe(25);
    expect(moveReasoning(["low", "high", "max"], "low", 1)).toBe("high");
    expect(moveReasoning(["low", "high", "max"], "max", 1)).toBe("max");
  });

  it("shares the choice in a project's subdirectories but keeps another checkout independent", () => {
    const first = path.join(home, "one");
    const second = path.join(home, "two");
    fs.mkdirSync(path.join(first, ".git"), { recursive: true });
    fs.mkdirSync(path.join(first, "src"));
    saveModelSelection({ provider: "openrouter", model: "openai/sol", reasoning: "high" }, first);
    saveModelSelection({ provider: "anthropic", model: "claude-live", reasoning: "medium" }, second);
    const saved = loadModelSelection(path.join(first, "src"));
    expect(saved).toEqual({ provider: "openrouter", model: "openai/sol", reasoning: "high" });
    expect(loadModelSelection(second)?.provider).toBe("anthropic");
    expect(restoreModelSelection({ reasoning: "low" }, saved, {})).toEqual({ provider: "openrouter", model: "openai/sol", reasoning: "low" });
    expect(restoreModelSelection({ provider: "anthropic" }, saved, {})).toEqual({ provider: "anthropic", model: undefined, reasoning: undefined });
    expect(restoreModelSelection({}, saved, { PHREN_AGENT_MODEL: "openai-codex/gpt-6.1-sol" })).toEqual({ provider: "openai-codex", model: "gpt-6.1-sol", reasoning: undefined });
  });
});

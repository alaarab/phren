import { afterEach, describe, expect, it, vi } from "vitest";
import { createCommandContext, handleCommand } from "../commands.js";
import { createSession } from "../agent-loop/types.js";
import { createCostTracker, resolvePricing } from "../cost.js";
import type { LlmProvider } from "../providers/types.js";
import type { PickerResult } from "../multi/model-picker.js";

const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
const printed = () => stderr.mock.calls.map((c) => String(c[0])).join("");
afterEach(() => stderr.mockClear());

function ctx() {
  const c = createCommandContext(createSession(), 200_000);
  c.providerName = "openai";
  c.currentModel = "gpt-6";
  c.currentReasoning = "medium";
  const calls: PickerResult[] = [];
  c.onModelChange = async (result) => {
    calls.push(result);
    if (result.provider === "nope") throw new Error('Unknown provider "nope".');
    return { name: result.provider ?? "openai", model: result.model || "default-model", reasoningEffort: result.reasoning ?? undefined } as unknown as LlmProvider;
  };
  return { c, calls };
}

describe("/reasoning, /model <id>, /provider <name>", () => {
  it("/reasoning shows the effort, rejects an unknown level and sets a valid one on the current model", async () => {
    const { c, calls } = ctx();
    await handleCommand("/reasoning", c);
    expect(printed()).toContain("Reasoning: medium");
    await handleCommand("/reasoning extreme", c);
    expect(printed()).toContain('Unknown reasoning level "extreme"');
    expect(calls).toEqual([]);
    await handleCommand("/reasoning high", c);
    expect(calls).toEqual([{ model: "gpt-6", reasoning: "high" }]);
    expect(c.currentReasoning).toBe("high");
  });

  it("/model <id> switches the model and keeps the effort", async () => {
    const { c, calls } = ctx();
    await handleCommand("/model gpt-6-mini", c);
    expect(calls).toEqual([{ model: "gpt-6-mini", reasoning: "medium" }]);
    expect(c.currentModel).toBe("gpt-6-mini");
    expect(printed()).toContain("openai/gpt-6-mini");
  });

  it("/provider <name> [model] switches provider; the context follows", async () => {
    const { c, calls } = ctx();
    await handleCommand("/provider anthropic claude-sonnet-5", c);
    expect(calls).toEqual([{ provider: "anthropic", model: "claude-sonnet-5", reasoning: null }]);
    expect(c.providerName).toBe("anthropic");
    expect(c.currentModel).toBe("claude-sonnet-5");
    await handleCommand("/provider deepseek", c);
    expect(calls.at(-1)).toEqual({ provider: "deepseek", model: "", reasoning: null });
  });

  it("reports a switch that fails and keeps what was running", async () => {
    const { c } = ctx();
    await handleCommand("/provider nope", c);
    expect(printed()).toContain('Could not switch: Unknown provider "nope".');
    expect(c.providerName).toBe("openai");
  });
});

describe("cost after a switch", () => {
  it("prices usage after a reprice at the new model, keeping what was spent", () => {
    const tracker = createCostTracker("deepseek-flash", null, "deepseek");
    tracker.recordUsage(1_000_000, 0);
    const before = tracker.totalCost;
    tracker.reprice("claude-sonnet-5", "anthropic");
    tracker.recordUsage(1_000_000, 0);
    const { pricing } = resolvePricing("claude-sonnet-5", "anthropic");
    expect(tracker.totalCost).toBeCloseTo(before + pricing.inputPer1M, 8);
  });
});

import { describe, expect, it } from "vitest";
import { createCostTracker } from "../cost.js";

describe("createCostTracker", () => {
  it("initializes with zero totals", () => {
    const tracker = createCostTracker("gpt-4o");
    expect(tracker.totalInputTokens).toBe(0);
    expect(tracker.totalOutputTokens).toBe(0);
    expect(tracker.totalCost).toBe(0);
  });

  it("records usage and accumulates cost", () => {
    const tracker = createCostTracker("gpt-4o");
    tracker.recordUsage(1_000_000, 0); // 1M input tokens at $2.50/M
    expect(tracker.totalInputTokens).toBe(1_000_000);
    expect(tracker.totalCost).toBeCloseTo(2.5, 2);
  });

  it("calculates output cost", () => {
    const tracker = createCostTracker("gpt-4o");
    tracker.recordUsage(0, 1_000_000); // 1M output tokens at $10/M
    expect(tracker.totalCost).toBeCloseTo(10, 2);
  });

  it("accumulates across multiple calls", () => {
    const tracker = createCostTracker("gpt-4o");
    tracker.recordUsage(500_000, 100_000);
    tracker.recordUsage(500_000, 100_000);
    expect(tracker.totalInputTokens).toBe(1_000_000);
    expect(tracker.totalOutputTokens).toBe(200_000);
  });

  // ── Pricing lookup by prefix ────────────────────────────────────────

  describe("pricing lookup", () => {
    it("treats codex subscription models as included usage", () => {
      const tracker = createCostTracker("gpt-5.4", 1, "openai-codex");
      tracker.recordUsage(1_000_000, 1_000_000);
      expect(tracker.totalCost).toBe(0);
      expect(tracker.isOverBudget()).toBe(false);
      expect(tracker.formatTurnCost(1000, 500)).toBe("included");
    });

    it("matches claude-opus-4 models", () => {
      const tracker = createCostTracker("claude-opus-4-20250514");
      tracker.recordUsage(1_000_000, 0);
      expect(tracker.totalCost).toBeCloseTo(15, 2); // $15/M input
    });

    it("matches claude-sonnet-4 models", () => {
      const tracker = createCostTracker("claude-sonnet-4-20250514");
      tracker.recordUsage(1_000_000, 0);
      expect(tracker.totalCost).toBeCloseTo(3, 2); // $3/M input
    });

    it("matches openrouter-prefixed models", () => {
      const tracker = createCostTracker("anthropic/claude-opus-4-latest");
      tracker.recordUsage(1_000_000, 0);
      expect(tracker.totalCost).toBeCloseTo(15, 2);
    });

    it("matches ollama as free", () => {
      const tracker = createCostTracker("ollama/llama3");
      tracker.recordUsage(1_000_000, 1_000_000);
      expect(tracker.totalCost).toBe(0);
    });

    it("falls back to mid-tier pricing for unknown models", () => {
      const tracker = createCostTracker("some-unknown-model");
      tracker.recordUsage(1_000_000, 0);
      expect(tracker.totalCost).toBeCloseTo(3, 2); // fallback $3/M input
    });
  });

  // ── Budget cap ──────────────────────────────────────────────────────

  describe("budget", () => {
    it("isOverBudget returns false when no budget set", () => {
      const tracker = createCostTracker("gpt-4o");
      tracker.recordUsage(10_000_000, 10_000_000);
      expect(tracker.isOverBudget()).toBe(false);
    });

    it("isOverBudget returns false when under budget", () => {
      const tracker = createCostTracker("gpt-4o", 100);
      tracker.recordUsage(1000, 1000);
      expect(tracker.isOverBudget()).toBe(false);
    });

    it("isOverBudget returns true when at or over budget", () => {
      const tracker = createCostTracker("gpt-4o", 1);
      // gpt-4o: $2.50/M input + $10/M output
      tracker.recordUsage(1_000_000, 0); // $2.50 > $1
      expect(tracker.isOverBudget()).toBe(true);
    });

    it("stores budget value", () => {
      const tracker = createCostTracker("gpt-4o", 50);
      expect(tracker.budget).toBe(50);
    });

    it("null budget means no limit", () => {
      const tracker = createCostTracker("gpt-4o", null);
      expect(tracker.budget).toBeNull();
    });
  });

  // ── Formatting ──────────────────────────────────────────────────────

  describe("formatCost", () => {
    it("formats unmetered providers as included", () => {
      const tracker = createCostTracker("gpt-5.4", null, "openai-codex");
      tracker.recordUsage(100, 100);
      expect(tracker.formatCost()).toContain("included");
    });

    it("formats small costs with 4 decimal places", () => {
      const tracker = createCostTracker("gpt-4o");
      tracker.recordUsage(100, 100);
      expect(tracker.formatCost()).toMatch(/^\$0\.\d{4}/);
    });

    it("formats larger costs with 2 decimal places", () => {
      const tracker = createCostTracker("gpt-4o");
      tracker.recordUsage(1_000_000, 1_000_000);
      expect(tracker.formatCost()).toMatch(/^\$\d+\.\d{2}/);
    });

    it("includes token count", () => {
      const tracker = createCostTracker("gpt-4o");
      tracker.recordUsage(500, 500);
      expect(tracker.formatCost()).toContain("1000 tokens");
    });

    it("includes budget when set", () => {
      const tracker = createCostTracker("gpt-4o", 10);
      tracker.recordUsage(100, 100);
      expect(tracker.formatCost()).toContain("$10.00 budget");
    });

    it("omits budget string when null", () => {
      const tracker = createCostTracker("gpt-4o");
      tracker.recordUsage(100, 100);
      expect(tracker.formatCost()).not.toContain("budget");
    });
  });

  describe("formatTurnCost", () => {
    it("formats a single turn cost", () => {
      const tracker = createCostTracker("gpt-4o");
      const result = tracker.formatTurnCost(1000, 500);
      expect(result).toMatch(/^\$0\.\d+/);
    });
  });
});

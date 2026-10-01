import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { lookupContextWindow, lookupMaxOutputTokens, lookupPricing, getReasoningRange, isUnmeteredEndpoint, normalizeReasoningEffort } from "../models.js";
import { createCostTracker } from "../cost.js";
import { parseArgs } from "../config.js";
import { resolveProvider } from "../providers/resolve.js";
import { OpenAiProvider } from "../providers/openrouter.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { wireReasoningEffort } from "../providers/openai-compat.js";
import { overridesFor, scopeModelOverrides, scopedModelOverrides } from "../model-overrides.js";

const GO = "https://opencode.ai/zen/go/v1";
const ENV_KEYS = [
  "HOME", "USERPROFILE", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY",
  "PHREN_AGENT_PROVIDER", "PHREN_AGENT_BASE_URL", "PHREN_AGENT_API_KEY", "PHREN_AGENT_REPLAY", "PHREN_OLLAMA_URL",
  "PHREN_AGENT_REASONING", "PHREN_AGENT_MODEL", "PHREN_AGENT_CONTEXT_WINDOW",
  "PHREN_AGENT_PRICE_IN", "PHREN_AGENT_PRICE_OUT", "PHREN_AGENT_PRICE_CACHE",
];

const saved: Record<string, string | undefined> = {};
let home: string;
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ds-catalog-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  for (const k of ENV_KEYS.slice(2)) delete process.env[k];
  process.env.PHREN_OLLAMA_URL = "off";
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(home, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("DeepSeek V4.1 Flash catalog", () => {
  for (const [provider, model] of [
    ["openai-compat", "deepseek-v4.1-flash"],
    ["deepseek", "deepseek-flash"],
    ["deepseek", "deepseek-v4-flash"],
  ] as const) {
    it(`${provider} ${model}: 1M context, 393,216 output, low/high/max, $0.15/$0.60 + $0.003 cache`, () => {
      expect(lookupContextWindow(model, provider)).toBe(1_000_000);
      expect(lookupMaxOutputTokens(model, provider)).toBe(393_216);
      expect(getReasoningRange(provider, model)).toEqual(["low", "high", "xhigh"]);
      expect(lookupPricing(model, provider)).toEqual({
        pricing: { inputPer1M: 0.15, outputPer1M: 0.6, cacheReadPer1M: 0.003 },
        metered: true,
      });
    });
  }

  it("resolves the OpenCode Go route with Flash limits", () => {
    const p = resolveProvider("openai-compat", "deepseek-v4.1-flash", undefined, undefined, { baseUrl: GO });
    expect(p.contextWindow).toBe(1_000_000);
    expect(p.maxOutputTokens).toBe(393_216);
    expect(p.baseUrl).toBe(GO);
  });

  it("an unknown DeepSeek V4 id falls back to a 1M window, not 128k", () => {
    expect(lookupContextWindow("deepseek-v4.2-flash-preview", "openai-compat")).toBe(1_000_000);
  });
});

describe("OpenCode Go is unmetered", () => {
  it("recognises the Go endpoint only", () => {
    expect(isUnmeteredEndpoint(GO)).toBe(true);
    expect(isUnmeteredEndpoint("https://opencode.ai/zen/go")).toBe(true);
    expect(isUnmeteredEndpoint("https://opencode.ai/zen/v1")).toBe(false);
    expect(isUnmeteredEndpoint("https://api.deepseek.com")).toBe(false);
    expect(isUnmeteredEndpoint(undefined)).toBe(false);
  });

  it("cost on Go shows as included and never trips the budget", () => {
    const tracker = createCostTracker("deepseek-v4.1-flash", 0.01, "openai-compat", GO);
    tracker.recordUsage(10_000_000, 1_000_000);
    expect(tracker.metered).toBe(false);
    expect(tracker.totalCost).toBe(0);
    expect(tracker.isOverBudget()).toBe(false);
    expect(tracker.formatCost()).toMatch(/^included/);
  });

  it("the same model on another relay is priced", () => {
    const tracker = createCostTracker("deepseek-v4.1-flash", null, "openai-compat", "https://relay.test/v1");
    tracker.recordUsage(1_000_000, 1_000_000);
    expect(tracker.totalCost).toBeCloseTo(0.75, 6);
  });
});

describe("--context-window and pricing overrides", () => {
  it("parses the flags", () => {
    const args = parseArgs(["--context-window", "262_144", "--price-in", "0.3", "--price-out", "1.2", "--price-cache", "0.006", "task"]);
    expect(args).toMatchObject({ contextWindow: 262_144, priceIn: 0.3, priceOut: 1.2, priceCache: 0.006, task: "task" });
    expect(() => parseArgs(["--context-window", "lots"])).toThrow(/--context-window/);
    expect(() => parseArgs(["--price-in", "-1"])).toThrow(/--price-in/);
  });

  it("the context window override replaces the catalog value, from options or env", () => {
    const viaOption = resolveProvider("openai-compat", "glm-5", undefined, undefined, { baseUrl: "https://x.test/v1", contextWindow: 300_000 });
    expect(viaOption.contextWindow).toBe(300_000);
    process.env.PHREN_AGENT_CONTEXT_WINDOW = "500000";
    const viaEnv = resolveProvider("openai-compat", "deepseek-v4.1-flash", undefined, undefined, { baseUrl: GO });
    expect(viaEnv.contextWindow).toBe(500_000);
  });

  it("price overrides apply per field and make the route metered", () => {
    process.env.PHREN_AGENT_PRICE_IN = "0.3";
    process.env.PHREN_AGENT_PRICE_OUT = "1.2";
    const peak = createCostTracker("deepseek-flash", null, "deepseek");
    peak.recordUsage(1_000_000, 1_000_000);
    expect(peak.totalCost).toBeCloseTo(1.5, 6);

    const onGo = createCostTracker("deepseek-v4.1-flash", null, "openai-compat", GO);
    expect(onGo.metered).toBe(true);
  });
});

describe("--context-window and --price-* stay with their model", () => {
  afterEach(() => { scopeModelOverrides(undefined, {}); });

  it("apply to the model they were given for, not to a model switched to", () => {
    scopeModelOverrides("glm-5", { contextWindow: 300_000, priceIn: 0.3, priceOut: 1.2 });
    const same = resolveProvider("openai-compat", "glm-5", undefined, undefined, { baseUrl: "https://x.test/v1" });
    expect(same.contextWindow).toBe(300_000);
    const other = resolveProvider("openai-compat", "qwen3-coder", undefined, undefined, { baseUrl: "https://x.test/v1" });
    expect(other.contextWindow).not.toBe(300_000);

    const priced = createCostTracker("glm-5", null, "openai-compat", "https://x.test/v1");
    priced.recordUsage(1_000_000, 1_000_000);
    expect(priced.totalCost).toBeCloseTo(1.5, 6);
    const catalog = createCostTracker("deepseek-flash", null, "deepseek");
    catalog.recordUsage(1_000_000, 1_000_000);
    expect(catalog.totalCost).toBeCloseTo(0.75, 6);
    // Nothing leaks into the environment.
    expect(process.env.PHREN_AGENT_CONTEXT_WINDOW).toBeUndefined();
    expect(process.env.PHREN_AGENT_PRICE_IN).toBeUndefined();
  });

  it("the flag beats PHREN_AGENT_PRICE_IN for its model, and the env var still prices other models", () => {
    process.env.PHREN_AGENT_PRICE_IN = "9";
    scopeModelOverrides("glm-5", { priceIn: 0.3 });
    const flagged = createCostTracker("glm-5", null, "openai-compat", "https://x.test/v1");
    flagged.recordUsage(1_000_000, 0);
    expect(flagged.totalCost).toBeCloseTo(0.3, 6);
    const other = createCostTracker("deepseek-flash", null, "deepseek");
    other.recordUsage(1_000_000, 0);
    expect(other.totalCost).toBeCloseTo(9, 6);
  });

  it("reach a subagent in its spawn payload, applying only if it runs the same model", async () => {
    scopeModelOverrides("glm-5", { contextWindow: 300_000 });
    expect(scopedModelOverrides()).toEqual({ model: "glm-5", contextWindow: 300_000 });
    expect(overridesFor("glm-5")).toEqual({ contextWindow: 300_000 });
    expect(overridesFor("qwen3-coder")).toEqual({});
    scopeModelOverrides("glm-5", {});
    expect(scopedModelOverrides()).toBeUndefined();
  });
});

describe("DeepSeek reasoning effort mapping", () => {
  it("normalizes max to xhigh and off/none to none", () => {
    expect(normalizeReasoningEffort("max")).toBe("xhigh");
    expect(normalizeReasoningEffort("none")).toBe("none");
    expect(normalizeReasoningEffort("off")).toBe("none");
    expect(parseArgs(["--reasoning", "max", "t"]).reasoning).toBe("xhigh");
    expect(parseArgs(["--reasoning", "none", "t"]).reasoning).toBe("none");
  });

  it("maps medium to high and xhigh/max to max on DeepSeek routes only", () => {
    for (const [name, model] of [["deepseek", "deepseek-flash"], ["openai-compat", "deepseek-v4.1-flash"]] as const) {
      expect(wireReasoningEffort(name, model, "none")).toBe("none");
      expect(wireReasoningEffort(name, model, "low")).toBe("low");
      expect(wireReasoningEffort(name, model, "medium")).toBe("high");
      expect(wireReasoningEffort(name, model, "high")).toBe("high");
      expect(wireReasoningEffort(name, model, "xhigh")).toBe("max");
      expect(wireReasoningEffort(name, model, undefined)).toBeUndefined();
    }
    expect(wireReasoningEffort("openai", "gpt-5.4", "medium")).toBe("medium");
    expect(wireReasoningEffort("openai-compat", "glm-5", "xhigh")).toBe("xhigh");
  });

  it("sends the mapped value as reasoning_effort", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    }));
    await new OpenAiProvider("k", "deepseek-flash", "https://api.deepseek.com", undefined, "xhigh").withName("deepseek")
      .chat("s", [{ role: "user", content: "x" }], []);
    await new OpenAiProvider("k", "deepseek-v4.1-flash", GO, undefined, "medium").withName("openai-compat")
      .chat("s", [{ role: "user", content: "x" }], []);
    await new OpenAiProvider("k", "deepseek-flash", "https://api.deepseek.com", undefined, "none").withName("deepseek")
      .chat("s", [{ role: "user", content: "x" }], []);
    expect(bodies.map((b) => b.reasoning_effort)).toEqual(["max", "high", "none"]);
  });

  it("none goes only to routes that accept it; elsewhere reasoning_effort is left out", async () => {
    expect(wireReasoningEffort("openai", "gpt-5.4", "none")).toBe("none");
    expect(wireReasoningEffort("openai", "gpt-5.1", "none")).toBe("none");
    expect(wireReasoningEffort("openai-codex", "gpt-5.4", "none")).toBe("none");
    for (const [name, model] of [
      ["openai", "gpt-5"],
      ["openai", "gpt-5-mini"],
      ["openai", "o4-mini"],
      ["openai-codex", "gpt-5.1-codex-max"],
      ["openai-compat", "glm-5"],
      ["openai-compat", "qwen3-coder"],
    ] as const) {
      expect(wireReasoningEffort(name, model, "none")).toBeUndefined();
      expect(wireReasoningEffort(name, model, "low")).toBe("low");
    }

    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    }));
    await new OpenAiProvider("k", "o4-mini", undefined, undefined, "none").chat("s", [{ role: "user", content: "x" }], []);
    await new OpenAiProvider("k", "gpt-5.4", undefined, undefined, "none").chat("s", [{ role: "user", content: "x" }], []);
    expect(bodies.map((b) => "reasoning_effort" in b ? b.reasoning_effort : "(absent)")).toEqual(["(absent)", "none"]);
  });

  it("none on Anthropic sends no thinking config", () => {
    const p = new AnthropicProvider("k", "claude-sonnet-5", 16384, true, "none");
    expect(p.reasoningEffort).toBeUndefined();
    expect(p.thinkingBudget()).toBeNull();
  });
});

describe("a subagent's endpoint", () => {
  it("resolves openai-compat from the payload's base URL and the forwarded key", () => {
    process.env.PHREN_AGENT_API_KEY = "k";
    const p = resolveProvider("openai-compat", "glm-5", undefined, undefined, { baseUrl: "https://relay.test/v1/" });
    expect(p.name).toBe("openai-compat");
    expect(p.baseUrl).toBe("https://relay.test/v1");
  });
});

describe("a /model switch keeps the session's DeepSeek endpoint", () => {
  afterEach(async () => {
    const { keepSessionEndpoint } = await import("../providers/resolve.js");
    keepSessionEndpoint({ name: "none" });
  });

  it("a session started on a DeepSeek proxy switches to another DeepSeek model on the same proxy", async () => {
    const { keepSessionEndpoint } = await import("../providers/resolve.js");
    process.env.DEEPSEEK_API_KEY = "ds";
    const start = resolveProvider("deepseek", "deepseek-flash", undefined, undefined, { baseUrl: "https://ds-proxy.test/" });
    expect(start.baseUrl).toBe("https://ds-proxy.test");
    keepSessionEndpoint(start);
    // What the /model picker does: same provider name, new model, no options.
    const switched = resolveProvider(start.name, "deepseek-v4-pro");
    expect(switched.baseUrl).toBe("https://ds-proxy.test");
    // An explicit option still wins.
    expect(resolveProvider("deepseek", "deepseek-flash", undefined, undefined, { baseUrl: "https://other.test" }).baseUrl).toBe("https://other.test");
  });

  it("an openai-compat session's relay never becomes DeepSeek's endpoint", async () => {
    const { keepSessionEndpoint } = await import("../providers/resolve.js");
    process.env.DEEPSEEK_API_KEY = "ds";
    process.env.PHREN_AGENT_API_KEY = "relay";
    process.env.PHREN_AGENT_BASE_URL = "https://relay.test/v1";
    const start = resolveProvider("openai-compat", "glm-5");
    keepSessionEndpoint(start);
    expect(resolveProvider("deepseek", "deepseek-flash").baseUrl).toBe("https://api.deepseek.com");
  });

  it("PHREN_AGENT_BASE_URL applies to DeepSeek when the environment names DeepSeek as the provider", () => {
    process.env.DEEPSEEK_API_KEY = "ds";
    process.env.PHREN_AGENT_PROVIDER = "deepseek";
    process.env.PHREN_AGENT_BASE_URL = "https://ds-env.test/";
    expect(resolveProvider(undefined, "deepseek-flash").baseUrl).toBe("https://ds-env.test");
  });

  it("a session on DeepSeek's own API keeps no override", async () => {
    const { keepSessionEndpoint } = await import("../providers/resolve.js");
    process.env.DEEPSEEK_API_KEY = "ds";
    const start = resolveProvider("deepseek", "deepseek-flash");
    keepSessionEndpoint(start);
    expect(resolveProvider("deepseek", "deepseek-v4-pro").baseUrl).toBe("https://api.deepseek.com");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDiscoveredModels } from "../models.js";
import { OpenRouterProvider, OpenAiProvider } from "../providers/openrouter.js";
import { AnthropicProvider } from "../providers/anthropic.js";

afterEach(() => vi.unstubAllGlobals());

describe("discovered provider effort wire mapping", () => {
  it("sends OpenRouter's advertised xhigh as reasoning.effort without downgrading it", async () => {
    registerDiscoveredModels("openrouter", [{
      id: "openai/gpt-6.1-sol", provider: "openrouter", label: "Sol", reasoningDefault: "medium",
      reasoningRange: ["low", "medium", "high", "xhigh"],
    }], "live");
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    }));
    await new OpenRouterProvider("key", "openai/gpt-6.1-sol", undefined, undefined, "xhigh")
      .chat("sys", [{ role: "user", content: "hi" }], []);
    expect(bodies[0].reasoning).toEqual({ effort: "xhigh" });
  });

  it("omits effort for a live OpenAI row that did not advertise effort levels", async () => {
    registerDiscoveredModels("openai", [{
      id: "vendor/unknown", provider: "openai", label: "Unknown", reasoningDefault: null, reasoningRange: [],
    }], "live");
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    }));
    await new OpenAiProvider("key", "vendor/unknown", undefined, undefined, "high")
      .chat("sys", [{ role: "user", content: "hi" }], []);
    expect(bodies[0].reasoning_effort).toBeUndefined();
  });

  it("keeps Anthropic's adaptive effort field on models whose catalogue advertises it", () => {
    registerDiscoveredModels("anthropic", [{
      id: "claude-live", provider: "anthropic", label: "Live Claude", reasoningDefault: "high",
      reasoningRange: ["low", "medium", "high"], reasoningMode: "adaptive",
    }], "live");
    const body = (new AnthropicProvider("key", "claude-live", 16384, false, "high") as unknown as {
      buildRequestBody(system: string, messages: unknown[], tools: unknown[]): Record<string, unknown>;
    }).buildRequestBody("sys", [{ role: "user", content: "hi" }], []);
    expect(body.output_config).toEqual({ effort: "high" });
  });
});

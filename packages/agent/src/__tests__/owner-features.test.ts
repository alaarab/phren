// Consolidated RC regression source. UNRUN under the owner's development policy.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebSearchTool } from "../tools/web-search.js";
import { createCostTracker } from "../cost.js";
import { searchSources } from "../providers/web-search.js";
import { traceOperation, flushTelemetry } from "../telemetry.js";
import type { LlmProvider } from "../providers/types.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const provider = (searchWeb: LlmProvider["searchWeb"]): LlmProvider => ({ name: "mock-native", supportsWebSearch: () => true, searchWeb, chat: vi.fn() });

describe("owner native search contract", () => {
  it("retains the selected provider and never silently repeats a failed native search", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const search = vi.fn().mockRejectedValue(new Error("Native search refused."));
    const result = await createWebSearchTool({ provider: () => provider(search) }).execute({ query: "installed SDK" });
    expect(result.is_error).toBe(true); expect(search).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
  });
  it("blocks network and exhausted budget before calling a provider", async () => {
    const search = vi.fn(); const tracker = createCostTracker("mock", 0); tracker.metered = true;
    await createWebSearchTool({ provider: () => provider(search), network: () => false }).execute({ query: "q" });
    await createWebSearchTool({ provider: () => provider(search), costTracker: () => tracker }).execute({ query: "q" });
    expect(search).not.toHaveBeenCalled();
  });
  it("uses actual reported charge while retaining token usage and an uncited-answer warning", async () => {
    const tracker = createCostTracker("mock", 1); tracker.totalCost = 0.2;
    const search = vi.fn().mockResolvedValue({ answer: "Draft answer", sources: [], usage: { input_tokens: 10, output_tokens: 5 }, billedCost: 0.03 });
    const result = await createWebSearchTool({ provider: () => provider(search), costTracker: () => tracker }).execute({ query: "q" });
    expect(tracker.totalCost).toBeCloseTo(0.23); expect(tracker.totalInputTokens).toBe(10); expect(result.output).toContain("no verified citations");
  });
  it("rejects credential-bearing/nonweb citations and deduplicates URLs", () => {
    expect(searchSources([{ url: "file:///private/key" }, { url: "https://user:password@example.org/" }, { url: "https://example.org/", title: "Primary" }, { url: "https://example.org/", title: "Duplicate" }], 5)).toEqual([{ url: "https://example.org/", title: "Primary", snippet: "" }]);
  });
});

describe("owner opt-in telemetry contract", () => {
  it("does not contact a collector when tracing or network is disabled", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); vi.stubEnv("PHREN_AGENT_OTEL", "0");
    await traceOperation("agent.turn", {}, async () => "ok");
    vi.stubEnv("PHREN_AGENT_OTEL", "1"); vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://collector.invalid");
    await traceOperation("agent.turn", {}, async () => "ok", false); expect(fetch).not.toHaveBeenCalled();
  });
  it("links turn/tool spans and omits operation results and thrown details", async () => {
    const bodies: any[] = []; vi.stubGlobal("fetch", vi.fn(async (_url, request) => { bodies.push(JSON.parse(request.body)); return { ok: true }; }));
    vi.stubEnv("PHREN_AGENT_OTEL", "1"); vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://collector.invalid");
    await expect(traceOperation("agent.turn", { "provider.name": "mock" }, () => traceOperation("agent.tool", { "tool.name": "read_file" }, async () => { throw new Error("private prompt /secret/path"); }))).rejects.toThrow("private prompt");
    await flushTelemetry(); const spans = bodies.flatMap(body => body.resourceSpans[0].scopeSpans[0].spans);
    const tool = spans.find(span => span.name === "agent.tool"), turn = spans.find(span => span.name === "agent.turn");
    expect(tool.traceId).toBe(turn.traceId); expect(tool.parentSpanId).toBe(turn.spanId); expect(tool.status.code).toBe(2);
    expect(JSON.stringify(bodies)).not.toContain("private prompt"); expect(JSON.stringify(bodies)).not.toContain("/secret/path");
  });
});

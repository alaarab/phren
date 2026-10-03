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
  it("does not turn a malformed native response into a second search", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const search = vi.fn().mockResolvedValue(undefined);
    const result = await createWebSearchTool({ provider: () => provider(search) }).execute({ query: "q" });
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
  it("drops arbitrary metadata, model aliases and collector service names", async () => {
    const bodies: string[] = []; vi.stubGlobal("fetch", vi.fn(async (_url, request) => { bodies.push(request.body); return { ok: true }; }));
    vi.stubEnv("PHREN_AGENT_OTEL", "1"); vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://collector.invalid"); vi.stubEnv("OTEL_SERVICE_NAME", "/private/owner-project");
    await traceOperation("agent.turn", { "prompt": "secret prompt", "gen_ai.request.model": "private-customer-model", "gen_ai.provider.name": "private-provider", "tool.name": "mcp_private_customer" }, async () => "private result");
    await flushTelemetry();
    const payload = bodies.join("");
    for (const secret of ["secret prompt", "private-customer-model", "private-provider", "mcp_private_customer", "/private/owner-project", "private result"]) expect(payload).not.toContain(secret);
    expect(payload).toContain("phren-agent");
  });
  it("cancels export and discards queued spans when network access is revoked", async () => {
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url, request) => {
      requestSignal = request.signal;
      await new Promise<void>((_resolve, reject) => requestSignal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    }));
    vi.stubEnv("PHREN_AGENT_OTEL", "1"); vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://collector.invalid");
    await traceOperation("agent.tool", { "tool.name": "read_file" }, async () => "ok");
    let finish!: () => void;
    const inFlight = traceOperation("agent.turn", {}, () => new Promise<void>(resolve => { finish = resolve; }));
    await flushTelemetry(false); expect(requestSignal?.aborted).toBe(true);
    finish(); await inFlight; await flushTelemetry();
    expect(fetch).toHaveBeenCalledTimes(1);
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

describe("native search response contracts", () => {
  const nativeEndpoint = { data: { id: "anthropic/claude-sonnet-5", endpoints: [
    { tag: "anthropic", native_tools: { "openrouter:web_search": { type: "web_search_20260209" } } },
    { tag: "unverified", native_tools: {} },
  ] } };
  it("preserves citations from all three native response formats without a second paid request", async () => {
    const { AnthropicProvider } = await import("../providers/anthropic.js");
    const { OpenAiProvider, OpenRouterProvider } = await import("../providers/openrouter.js");
    const cases = [
      { provider: new AnthropicProvider("fixture", "claude-sonnet-5"), body: { stop_reason: "end_turn", content: [{ type: "web_search_tool_result", content: [{ url: "https://example.org/primary", title: "Primary", encrypted_content: "private encrypted payload" }] }], usage: { input_tokens: 7, output_tokens: 3 } } },
      { provider: new OpenAiProvider("fixture", "gpt-6"), body: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Grounded answer", annotations: [{ type: "url_citation", url: "https://example.org/primary", title: "Primary" }] }] }], usage: { input_tokens: 7, output_tokens: 3 } } },
      { provider: new OpenRouterProvider("fixture", "anthropic/claude-sonnet-5"), body: { choices: [{ finish_reason: "stop", message: { content: "Grounded answer", annotations: [{ type: "url_citation", url_citation: { url: "https://example.org/primary", title: "Primary" } }] } }], usage: { prompt_tokens: 7, completion_tokens: 3, cost: 0.02 } } },
    ];
    for (const value of cases) {
      const paid: any[] = [];
      const fetch = vi.fn(async (url: string, request?: RequestInit) => {
        if (url.endsWith("/endpoints")) return new Response(JSON.stringify(nativeEndpoint));
        paid.push(JSON.parse(String(request?.body)));
        return new Response(JSON.stringify(value.body));
      }); vi.stubGlobal("fetch", fetch);
      const result = await createWebSearchTool({ provider: () => value.provider }).execute({ query: "q" });
      expect(paid).toHaveLength(1); expect(result.is_error).not.toBe(true);
      if (value.provider.name === "openrouter") expect(paid[0].provider).toEqual({ only: ["anthropic"], allow_fallbacks: false, require_parameters: true });
      expect(result.output).toContain("https://example.org/primary"); expect(result.output).not.toContain("private encrypted payload");
    }
  });
  it("refuses a paid search when the model name suggests support but its endpoint does not", async () => {
    const { OpenRouterProvider } = await import("../providers/openrouter.js");
    const requests: { url: string; method?: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, request?: RequestInit) => {
      requests.push({ url, method: request?.method });
      return new Response(JSON.stringify({ data: { id: "anthropic/claude-sonnet-5", endpoints: [{ tag: "anthropic", native_tools: {} }] } }));
    }));
    const result = await createWebSearchTool({ provider: () => new OpenRouterProvider("fixture", "anthropic/claude-sonnet-5") }).execute({ query: "q" });
    expect(result.is_error).toBe(true);
    expect(requests).toEqual([{ url: "https://openrouter.ai/api/v1/models/anthropic/claude-sonnet-5/endpoints", method: undefined }]);
  });
  it("rejects unsupported OpenRouter models locally, rather than authorizing paid Exa fallback", async () => {
    const { OpenRouterProvider } = await import("../providers/openrouter.js");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    for (const model of ["openai/gpt-4o", "anthropic/claude-sonnet-5:online"]) {
      const result = await createWebSearchTool({ provider: () => new OpenRouterProvider("fixture", model) }).execute({ query: "q" });
      expect(result.is_error).toBe(true);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("never treats a compatible or subscription endpoint as API-key native search", async () => {
    const { OpenAiProvider } = await import("../providers/openrouter.js");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    for (const provider of [new OpenAiProvider("fixture", "gpt-6", "https://relay.invalid/v1"), new OpenAiProvider("fixture", "gpt-6").withName("openai-codex")]) {
      await expect(provider.searchWeb("q", 3)).rejects.toThrow("no declared native search");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("adds native search fees to token cost while treating an authoritative total as inclusive", async () => {
    const tracker = createCostTracker("mock", 1); tracker.totalCost = 0.2;
    const search = vi.fn().mockResolvedValueOnce({ sources: [], searchFee: 0.01 }).mockResolvedValueOnce({ sources: [], searchFee: 0.01, billedCost: 0.03 });
    const tool = createWebSearchTool({ provider: () => provider(search), costTracker: () => tracker });
    await tool.execute({ query: "first" }); expect(tracker.totalCost).toBeCloseTo(0.21);
    await tool.execute({ query: "second" }); expect(tracker.totalCost).toBeCloseTo(0.24);
  });
  it("retains the reported charge on a failed OpenRouter search", async () => {
    const { OpenRouterProvider } = await import("../providers/openrouter.js");
    const tracker = createCostTracker("mock", 1); tracker.totalCost = 0.2;
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/endpoints") ? nativeEndpoint
      : { error: { message: "private upstream detail" }, usage: { prompt_tokens: 8, completion_tokens: 2, cost: 0.04 } })));
    vi.stubGlobal("fetch", fetch);
    const result = await createWebSearchTool({ provider: () => new OpenRouterProvider("fixture", "anthropic/claude-sonnet-5"), costTracker: () => tracker }).execute({ query: "q" });
    expect(result.is_error).toBe(true); expect(fetch).toHaveBeenCalledTimes(2);
    expect(tracker.totalInputTokens).toBe(8); expect(tracker.totalCost).toBeCloseTo(0.24);
    expect(result.output).not.toContain("private upstream detail");
  });
  it("turns HTTP-200 native tool errors into failure without leaking their detail or falling back", async () => {
    const { AnthropicProvider } = await import("../providers/anthropic.js");
    const fetch = vi.fn(async () => new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "private account detail" } }] })));
    vi.stubGlobal("fetch", fetch);
    const result = await createWebSearchTool({ provider: () => new AnthropicProvider("fixture") }).execute({ query: "q" });
    expect(result.is_error).toBe(true); expect(fetch).toHaveBeenCalledTimes(1); expect(result.output).not.toContain("private account detail");
  });
});

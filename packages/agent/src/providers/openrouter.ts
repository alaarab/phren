import { SearchResponseError, nativeSearchFee, searchJson, searchSources, searchTokenUsage, type WebSearchResponse } from "./web-search.js";
import type { LlmProvider, LlmMessage, AgentToolDef, LlmResponse, StreamDelta } from "./types.js";
import {
  toOpenAiTools,
  toOpenAiMessages,
  parseOpenAiResponse,
  parseOpenAiStream,
  replaysAllReasoning,
  wireReasoningEffort,
} from "./openai-compat.js";
import type { ReasoningEffort } from "../models.js";
import { lookupContextWindow, lookupMaxOutputTokens, modelSupportsVision } from "../models.js";

export class OpenRouterProvider implements LlmProvider {
  name = "openrouter";
  contextWindow: number;
  maxOutputTokens: number;
  private apiKey: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  readonly baseUrl: string;

  constructor(apiKey: string, model?: string, baseUrl?: string, maxOutputTokens?: number, reasoningEffort?: ReasoningEffort) {
    this.apiKey = apiKey;
    this.model = model ?? "anthropic/claude-sonnet-4-20250514";
    this.baseUrl = baseUrl ?? "https://openrouter.ai/api/v1";
    this.maxOutputTokens = maxOutputTokens ?? lookupMaxOutputTokens(this.model, this.name);
    this.reasoningEffort = reasoningEffort;
    this.contextWindow = lookupContextWindow(this.model, this.name);
  }

  private applyReasoning(body: Record<string, unknown>): void {
    if (!this.reasoningEffort) return;
    const effort = this.reasoningEffort === "xhigh" ? "high" : this.reasoningEffort;
    body.reasoning = { effort };
  }

  supportsWebSearch() { return true; }
  async searchWeb(query: string, limit: number, signal?: AbortSignal): Promise<WebSearchResponse> {
    // OpenRouter documents paid Exa fallback even for engine:native on older
    // models. Refuse unverified models locally instead of authorizing it.
    const nativeModel = /^(?:anthropic\/claude-(?:3-5-haiku|3\.5-haiku|3-7-sonnet|3\.7-sonnet|(?:opus|sonnet|haiku|fable|mythos)-[4-9]|[4-9])|openai\/(?:gpt-(?:4\.1(?:-|$)|[5-9](?:[.-]|$))|o3(?:-|$)|o4-mini(?:-|$))|google\/gemini-3(?:[.-]|$)|x-ai\/grok-[4-9](?:[.-]|$)|perplexity\/)/.test(this.model);
    if (!nativeModel || /:online(?:$|:)/.test(this.model)) throw new Error("Native search is not verified for the selected OpenRouter model.");
    // Model families are not proof for a particular routed endpoint. Check the
    // current endpoint's native_tools and restrict the paid request to those
    // routes; a provider without native search can otherwise invoke paid Exa.
    const parts = this.model.split("/");
    if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_.:-]+$/.test(part))) throw new Error("Native search requires an exact model ID.");
    const directory = await fetch(`${this.baseUrl}/models/${parts.map(encodeURIComponent).join("/")}/endpoints`, {
      redirect: "error", signal, headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!directory.ok) { await directory.body?.cancel(); throw new Error("Native search endpoint discovery failed."); }
    const catalog = await searchJson(directory);
    const endpoints: Record<string, any>[] = catalog.data?.id === this.model && Array.isArray(catalog.data?.endpoints)
      ? catalog.data.endpoints.filter((entry: unknown) => entry && typeof entry === "object" && !Array.isArray(entry)) : [];
    const native = (entry: Record<string, any>) => typeof entry.native_tools?.["openrouter:web_search"]?.type === "string"
      && entry.native_tools["openrouter:web_search"].type.length > 0;
    const only = [...new Set<string>(endpoints.filter(entry => native(entry) && typeof entry.tag === "string"
      && /^[a-z0-9][a-z0-9_/-]{0,199}$/.test(entry.tag)
      // Base provider slugs also select their region/variant endpoints.
      && endpoints.filter(other => other.tag === entry.tag || (typeof other.tag === "string" && other.tag.startsWith(entry.tag + "/"))).every(native)
    ).map(entry => entry.tag))];
    if (!only.length) throw new Error("No verified native search endpoint for the selected model.");
    const res = await fetch(`${this.baseUrl}/chat/completions`, { method: "POST", redirect: "error", signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}`, "HTTP-Referer": "https://github.com/alaarab/phren", "X-Title": "phren-agent" },
      body: JSON.stringify({ model: this.model, provider: { only, allow_fallbacks: false, require_parameters: true }, max_tool_calls: 1, max_tokens: Math.min(this.maxOutputTokens, 2048), plugins: [{ id: "web", enabled: false }], messages: [{ role: "user", content: `Search the web for: ${query}. Return concise findings with citations.` }], tools: [{ type: "openrouter:web_search", parameters: { engine: "native", max_results: limit, max_total_results: limit, max_uses: 1 } }] }),
    });
    if (!res.ok) { await res.body?.cancel(); throw new Error(`OpenRouter search returned HTTP ${res.status}`); }
    const data = await searchJson(res), message = data.choices?.[0]?.message;
    const usage = searchTokenUsage(data.usage, "prompt_tokens", "completion_tokens"), billedCost = typeof data.usage?.cost === "number" && Number.isFinite(data.usage.cost) && data.usage.cost >= 0 ? data.usage.cost : undefined;
    if (data.error || !message || data.choices?.[0]?.finish_reason !== "stop") throw new SearchResponseError("OpenRouter search did not complete.", usage, billedCost);
    return { answer: typeof message?.content === "string" ? message.content.slice(0, 8000) : "", sources: searchSources((Array.isArray(message?.annotations) ? message.annotations : []).map((a: any) => a?.url_citation ?? a), limit), usage, billedCost };
  }

  async chat(system: string, messages: LlmMessage[], tools: AgentToolDef[], signal?: AbortSignal): Promise<LlmResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAiMessages(system, messages, this.name, modelSupportsVision(this.name, this.model)),
      max_tokens: this.maxOutputTokens,
    };
    this.applyReasoning(body);
    if (tools.length > 0) body.tools = toOpenAiTools(tools);

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "HTTP-Referer": "https://github.com/alaarab/phren",
        "X-Title": "phren-agent",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenRouter API error ${res.status}: ${text}`);
    }

    return parseOpenAiResponse(await res.json() as Record<string, unknown>, this.name);
  }

  async *chatStream(system: string, messages: LlmMessage[], tools: AgentToolDef[], signal?: AbortSignal): AsyncIterable<StreamDelta> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAiMessages(system, messages, this.name, modelSupportsVision(this.name, this.model)),
      max_tokens: this.maxOutputTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    this.applyReasoning(body);
    if (tools.length > 0) body.tools = toOpenAiTools(tools);

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "HTTP-Referer": "https://github.com/alaarab/phren",
        "X-Title": "phren-agent",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenRouter API error ${res.status}: ${text}`);
    }

    yield* parseOpenAiStream(res);
  }
}

/**
 * OpenAI Chat Completions provider. Also serves any OpenAI-compatible endpoint
 * (DeepSeek, OpenCode Go/Zen, vLLM…) through `baseUrl` and a provider `name`.
 */
export class OpenAiProvider implements LlmProvider {
  name = "openai";
  contextWindow: number;
  maxOutputTokens: number;
  private apiKey: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  readonly baseUrl: string;

  constructor(apiKey: string, model?: string, baseUrl?: string, maxOutputTokens?: number, reasoningEffort?: ReasoningEffort) {
    this.apiKey = apiKey;
    this.model = model ?? "gpt-5.4";
    this.baseUrl = baseUrl ?? "https://api.openai.com/v1";
    this.maxOutputTokens = maxOutputTokens ?? lookupMaxOutputTokens(this.model, this.name);
    this.reasoningEffort = reasoningEffort;
    this.contextWindow = lookupContextWindow(this.model, this.name);
  }

  /** Rename for an OpenAI-compatible endpoint; limits are looked up again under the new name. */
  withName(name: string, maxOutputTokens?: number): this {
    this.name = name;
    this.maxOutputTokens = maxOutputTokens ?? lookupMaxOutputTokens(this.model, name);
    this.contextWindow = lookupContextWindow(this.model, name);
    return this;
  }

  private toMessages(system: string, messages: LlmMessage[]) {
    return toOpenAiMessages(
      system,
      messages,
      this.name,
      modelSupportsVision(this.name, this.model),
      replaysAllReasoning(this.name, this.model),
    );
  }

  private apiError(status: number, text: string): Error {
    const label = this.name === "openai" ? "OpenAI" : this.name;
    return new Error(`${label} API error ${status}: ${text}`);
  }

  supportsWebSearch() {
    // Compatible/subscriber endpoints never inherit API-key search authority.
    try { const url = new URL(this.baseUrl); return this.name === "openai" && url.origin === "https://api.openai.com" && url.pathname.replace(/\/$/, "") === "/v1" && !url.username && !url.password && !url.search && !url.hash; }
    catch { return false; }
  }
  async searchWeb(query: string, limit: number, signal?: AbortSignal): Promise<WebSearchResponse> {
    if (!this.supportsWebSearch()) throw new Error("This compatible endpoint has no declared native search support.");
    const res = await fetch(`${this.baseUrl}/responses`, { method: "POST", redirect: "error", signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, store: false, input: `Search the web for: ${query}. Return concise findings with citations.`, max_output_tokens: Math.min(this.maxOutputTokens, 2048), max_tool_calls: 1, tools: [{ type: "web_search", search_context_size: "low" }], tool_choice: { type: "web_search" }, include: ["web_search_call.action.sources"] }),
    });
    if (!res.ok) { await res.body?.cancel(); throw new Error(`OpenAI search returned HTTP ${res.status}`); }
    const data = await searchJson(res), sources: unknown[] = [], text: string[] = [];
    const usage = searchTokenUsage(data.usage), searchFee = nativeSearchFee(Array.isArray(data.output) ? data.output.filter((item: any) => item?.type === "web_search_call").length : 0);
    if (data.error || data.status !== "completed" || !Array.isArray(data.output)) throw new SearchResponseError("OpenAI search did not complete.", usage, undefined, searchFee);
    for (const output of data.output) {
      if (!output || typeof output !== "object") continue;
      if (output.type === "web_search_call") sources.push(...(Array.isArray(output.action?.sources) ? output.action.sources : []));
      for (const block of Array.isArray(output.content) ? output.content : []) { if (block?.type === "output_text") { if (typeof block.text === "string") text.push(block.text); sources.push(...(Array.isArray(block.annotations) ? block.annotations : [])); } }
    }
    return { answer: text.join("\n").slice(0, 8000), sources: searchSources(sources, limit), usage, searchFee };
  }

  async chat(system: string, messages: LlmMessage[], tools: AgentToolDef[], signal?: AbortSignal): Promise<LlmResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: this.toMessages(system, messages),
      max_tokens: this.maxOutputTokens,
    };
    const effort = wireReasoningEffort(this.name, this.model, this.reasoningEffort);
    if (effort) body.reasoning_effort = effort;
    if (tools.length > 0) body.tools = toOpenAiTools(tools);

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw this.apiError(res.status, text);
    }

    return parseOpenAiResponse(await res.json() as Record<string, unknown>, this.name);
  }

  async *chatStream(system: string, messages: LlmMessage[], tools: AgentToolDef[], signal?: AbortSignal): AsyncIterable<StreamDelta> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: this.toMessages(system, messages),
      max_tokens: this.maxOutputTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    const effort = wireReasoningEffort(this.name, this.model, this.reasoningEffort);
    if (effort) body.reasoning_effort = effort;
    if (tools.length > 0) body.tools = toOpenAiTools(tools);

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw this.apiError(res.status, text);
    }

    yield* parseOpenAiStream(res);
  }
}

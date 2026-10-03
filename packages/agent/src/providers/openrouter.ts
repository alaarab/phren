import { searchSources, type WebSearchResponse } from "./web-search.js";
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
    const res = await fetch(`${this.baseUrl}/chat/completions`, { method: "POST", signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}`, "HTTP-Referer": "https://github.com/alaarab/phren", "X-Title": "phren-agent" },
      body: JSON.stringify({ model: this.model, max_tokens: Math.min(this.maxOutputTokens, 2048), messages: [{ role: "user", content: `Search the web for: ${query}. Return concise findings with citations.` }], tools: [{ type: "openrouter:web_search", parameters: { engine: "native", max_results: limit, max_total_results: limit, max_uses: 1 } }] }),
    });
    if (!res.ok) throw new Error(`OpenRouter search returned HTTP ${res.status}`);
    const data = await res.json() as Record<string, any>, message = data.choices?.[0]?.message;
    return { answer: typeof message?.content === "string" ? message.content.slice(0, 8000) : "", sources: searchSources((message?.annotations ?? []).map((a: any) => a.url_citation ?? a), limit), usage: data.usage ? { input_tokens: data.usage.prompt_tokens ?? data.usage.input_tokens ?? 0, output_tokens: data.usage.completion_tokens ?? data.usage.output_tokens ?? 0 } : undefined, billedCost: typeof data.usage?.cost === "number" ? data.usage.cost : undefined };
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

  supportsWebSearch() { return this.name === "openai"; }
  async searchWeb(query: string, limit: number, signal?: AbortSignal): Promise<WebSearchResponse> {
    if (!this.supportsWebSearch()) throw new Error("This compatible endpoint has no declared native search support.");
    const res = await fetch(`${this.baseUrl}/responses`, { method: "POST", signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, store: false, input: `Search the web for: ${query}. Return concise findings with citations.`, max_output_tokens: Math.min(this.maxOutputTokens, 2048), tools: [{ type: "web_search", search_context_size: "low" }], tool_choice: { type: "web_search" }, include: ["web_search_call.action.sources"] }),
    });
    if (!res.ok) throw new Error(`OpenAI search returned HTTP ${res.status}`);
    const data = await res.json() as Record<string, any>, sources: unknown[] = [], text: string[] = [];
    if (data.error || data.status === "failed") throw new Error("OpenAI search failed.");
    for (const output of data.output ?? []) {
      if (output.type === "web_search_call") sources.push(...(output.action?.sources ?? []));
      for (const block of output.content ?? []) { if (block.type === "output_text") { text.push(block.text ?? ""); sources.push(...(block.annotations ?? [])); } }
    }
    return { answer: text.join("\n").slice(0, 8000), sources: searchSources(sources, limit), usage: data.usage ? { input_tokens: data.usage.input_tokens ?? 0, output_tokens: data.usage.output_tokens ?? 0 } : undefined };
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

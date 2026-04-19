import type { LlmProvider, LlmMessage, AgentToolDef, LlmResponse, StreamDelta } from "./types.js";
import { toOpenAiTools, toOpenAiMessages, parseOpenAiResponse, parseOpenAiStream } from "./openai-compat.js";
import type { ReasoningEffort } from "../models.js";
import { lookupMaxOutputTokens } from "../models.js";

export class OpenRouterProvider implements LlmProvider {
  name = "openrouter";
  contextWindow = 200_000;
  maxOutputTokens: number;
  private apiKey: string;
  model: string;
  private baseUrl: string;

  constructor(apiKey: string, model?: string, baseUrl?: string, maxOutputTokens?: number) {
    this.apiKey = apiKey;
    this.model = model ?? "anthropic/claude-sonnet-4-20250514";
    this.baseUrl = baseUrl ?? "https://openrouter.ai/api/v1";
    this.maxOutputTokens = maxOutputTokens ?? lookupMaxOutputTokens(this.model, this.name);
  }

  async chat(system: string, messages: LlmMessage[], tools: AgentToolDef[]): Promise<LlmResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAiMessages(system, messages),
      max_tokens: this.maxOutputTokens,
    };
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
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenRouter API error ${res.status}: ${text}`);
    }

    return parseOpenAiResponse(await res.json() as Record<string, unknown>);
  }

  async *chatStream(system: string, messages: LlmMessage[], tools: AgentToolDef[]): AsyncIterable<StreamDelta> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAiMessages(system, messages),
      max_tokens: this.maxOutputTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
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
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenRouter API error ${res.status}: ${text}`);
    }

    yield* parseOpenAiStream(res);
  }
}

/** OpenAI-native provider (same protocol, different base URL). */
export class OpenAiProvider implements LlmProvider {
  name = "openai";
  contextWindow = 1_050_000;
  maxOutputTokens: number;
  private apiKey: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  private baseUrl: string;

  constructor(apiKey: string, model?: string, baseUrl?: string, maxOutputTokens?: number, reasoningEffort?: ReasoningEffort) {
    this.apiKey = apiKey;
    this.model = model ?? "gpt-5.4";
    this.baseUrl = baseUrl ?? "https://api.openai.com/v1";
    this.maxOutputTokens = maxOutputTokens ?? lookupMaxOutputTokens(this.model, this.name);
    this.reasoningEffort = reasoningEffort;
  }

  async chat(system: string, messages: LlmMessage[], tools: AgentToolDef[]): Promise<LlmResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAiMessages(system, messages),
      max_tokens: this.maxOutputTokens,
    };
    if (this.reasoningEffort) body.reasoning_effort = this.reasoningEffort;
    if (tools.length > 0) body.tools = toOpenAiTools(tools);

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${text}`);
    }

    return parseOpenAiResponse(await res.json() as Record<string, unknown>);
  }

  async *chatStream(system: string, messages: LlmMessage[], tools: AgentToolDef[]): AsyncIterable<StreamDelta> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAiMessages(system, messages),
      max_tokens: this.maxOutputTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (this.reasoningEffort) body.reasoning_effort = this.reasoningEffort;
    if (tools.length > 0) body.tools = toOpenAiTools(tools);

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${text}`);
    }

    yield* parseOpenAiStream(res);
  }
}

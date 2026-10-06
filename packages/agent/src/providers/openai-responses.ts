import type { AgentToolDef, LlmMessage, LlmProvider, LlmResponse, StreamDelta, TokenUsage } from "./types.js";
import { IncompleteStreamError, withPartialUsage } from "./types.js";
import { parseResponsesOutput, toResponsesInput, toResponsesTools } from "./codex.js";
import { wireAdvertisedReasoningEffort } from "./openai-compat.js";
import type { ReasoningEffort } from "../models.js";
import { lookupContextWindow, lookupMaxOutputTokens, modelSupportsVision } from "../models.js";

const PROVIDER_NAME = "openai";
const CATALOG_PROVIDER = "openai";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const MAX_ERROR_TEXT = 4_096;

function boundedText(value: string): string {
  return value.length > MAX_ERROR_TEXT ? `${value.slice(0, MAX_ERROR_TEXT)}…` : value;
}

function responseUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const output = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  return { input_tokens: input, output_tokens: output };
}

function responseError(event: Record<string, unknown>): Error {
  const response = event.response && typeof event.response === "object" ? event.response as Record<string, unknown> : undefined;
  const detail = event.error ?? response?.error;
  const error = detail && typeof detail === "object" ? detail as Record<string, unknown> : undefined;
  const message = typeof error?.message === "string" ? error.message
    : typeof detail === "string" ? detail
      : "Provider reported a Responses API error";
  const code = typeof error?.code === "string" ? ` (${error.code})` : "";
  return new Error(`OpenAI Responses API error${code}: ${boundedText(message)}`);
}

function itemRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

/** Parse the Responses API's HTTP SSE event stream into the agent's deltas. */
async function* parseResponsesStream(res: Response): AsyncIterable<StreamDelta> {
  if (!res.body) throw new Error("Provider returned empty response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  let sawDone = false;
  let stopReason: LlmResponse["stop_reason"] = "end_turn";
  let usage: TokenUsage | undefined;
  const callByItem = new Map<string, string>();
  const calls = new Map<string, { ended: boolean }>();

  const handleEvent = (event: Record<string, unknown>): StreamDelta[] => {
    const type = typeof event.type === "string" ? event.type : "";
    const deltas: StreamDelta[] = [];

    if (type === "error" || type === "response.failed") {
      throw responseError(event);
    }

    if (type === "response.output_text.delta") {
      if (typeof event.delta === "string" && event.delta) deltas.push({ type: "text_delta", text: event.delta });
    } else if (type === "response.reasoning_summary_text.delta") {
      if (typeof event.delta === "string" && event.delta) deltas.push({ type: "reasoning_delta", text: event.delta });
    } else if (type === "response.output_item.added") {
      const item = itemRecord(event.item);
      const itemType = item.type;
      if (itemType === "function_call") {
        const itemId = typeof item.id === "string" ? item.id : undefined;
        const id = typeof item.call_id === "string" ? item.call_id : itemId;
        if (id) {
          if (itemId) callByItem.set(itemId, id);
          calls.set(id, { ended: false });
          deltas.push({ type: "tool_use_start", id, name: typeof item.name === "string" ? item.name : "" });
        }
      }
    } else if (type === "response.function_call_arguments.delta") {
      const itemId = typeof event.item_id === "string" ? event.item_id : undefined;
      const id = (typeof event.call_id === "string" ? event.call_id : undefined)
        ?? (itemId ? callByItem.get(itemId) : undefined)
        ?? itemId;
      if (id && typeof event.delta === "string") {
        if (!calls.has(id)) {
          calls.set(id, { ended: false });
          if (itemId) callByItem.set(itemId, id);
          deltas.push({ type: "tool_use_start", id, name: typeof event.name === "string" ? event.name : "" });
        }
        deltas.push({ type: "tool_use_delta", id, json: event.delta });
      }
    } else if (type === "response.function_call_arguments.done") {
      const itemId = typeof event.item_id === "string" ? event.item_id : undefined;
      const id = (typeof event.call_id === "string" ? event.call_id : undefined)
        ?? (itemId ? callByItem.get(itemId) : undefined)
        ?? itemId;
      const call = id ? calls.get(id) : undefined;
      if (id && call && !call.ended) {
        call.ended = true;
        deltas.push({ type: "tool_use_end", id });
      }
    } else if (type === "response.output_item.done") {
      const item = itemRecord(event.item);
      if (item.type === "reasoning") {
        const id = typeof item.id === "string" ? item.id : undefined;
        deltas.push({
          type: "reasoning_end",
          ...(id ? { id } : {}),
          ...(typeof item.encrypted_content === "string" ? { encrypted_content: item.encrypted_content } : {}),
        });
      } else if (item.type === "function_call") {
        const itemId = typeof item.id === "string" ? item.id : undefined;
        const id = (typeof item.call_id === "string" ? item.call_id : undefined)
          ?? (itemId ? callByItem.get(itemId) : undefined)
          ?? itemId;
        const call = id ? calls.get(id) : undefined;
        if (id && call && !call.ended) {
          call.ended = true;
          deltas.push({ type: "tool_use_end", id });
        }
      }
    } else if (type === "response.completed") {
      const response = itemRecord(event.response);
      usage = responseUsage(response.usage) ?? usage;
      const output = Array.isArray(response.output) ? response.output : [];
      if (output.some((item) => itemRecord(item).type === "function_call") || calls.size > 0) stopReason = "tool_use";
      completed = true;
    } else if (type === "response.incomplete") {
      const response = itemRecord(event.response);
      usage = responseUsage(response.usage) ?? usage;
      stopReason = "max_tokens";
      completed = true;
    }

    return deltas;
  };

  try {
    read: for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        if (buffer.trim() === "data: [DONE]") sawDone = true;
        else if (buffer) {
          const line = buffer.replace(/\r$/, "");
          if (line.startsWith("data:")) {
            const raw = line.slice(5).trim();
            if (raw === "[DONE]") sawDone = true;
            else {
              try {
                for (const delta of handleEvent(JSON.parse(raw) as Record<string, unknown>)) yield delta;
              } catch (error) {
                if (error instanceof SyntaxError) { /* Ignore a malformed trailing event. */ }
                else throw error;
              }
            }
          }
        }
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, "");
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (raw === "[DONE]") {
          sawDone = true;
          break read;
        }
        let event: Record<string, unknown>;
        try { event = JSON.parse(raw) as Record<string, unknown>; }
        catch { continue; }
        for (const delta of handleEvent(event)) yield delta;
      }
    }

    if (!completed && !sawDone) {
      throw withPartialUsage(new IncompleteStreamError("Responses stream ended before response.completed"), usage);
    }
    if (!completed) {
      throw withPartialUsage(new IncompleteStreamError("Responses stream ended at [DONE] before response.completed"), usage);
    }

    for (const [id, call] of calls) {
      if (!call.ended) yield { type: "tool_use_end", id };
    }
    yield { type: "done", stop_reason: stopReason, usage };
  } catch (error) {
    throw withPartialUsage(error, usage);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class OpenAiResponsesProvider implements LlmProvider {
  readonly name = PROVIDER_NAME;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly baseUrl: string;
  private readonly apiKey: string;
  readonly model: string;
  reasoningEffort?: ReasoningEffort;

  constructor(apiKey: string, model?: string, baseUrl?: string, maxOutputTokens?: number, reasoningEffort?: ReasoningEffort) {
    this.apiKey = apiKey;
    this.model = model ?? "gpt-5.4";
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.maxOutputTokens = maxOutputTokens ?? lookupMaxOutputTokens(this.model, CATALOG_PROVIDER);
    this.reasoningEffort = reasoningEffort;
    this.contextWindow = lookupContextWindow(this.model, CATALOG_PROVIDER);
  }

  private requestBody(system: string, messages: LlmMessage[], tools: AgentToolDef[], stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      instructions: system,
      input: toResponsesInput(messages, modelSupportsVision(CATALOG_PROVIDER, this.model), this.name),
      max_output_tokens: this.maxOutputTokens,
      store: false,
      stream,
      include: ["reasoning.encrypted_content"],
    };
    const effort = wireAdvertisedReasoningEffort(CATALOG_PROVIDER, this.model, this.reasoningEffort);
    if (effort) body.reasoning = { effort };
    if (tools.length > 0) {
      body.tools = toResponsesTools(tools);
      body.tool_choice = "auto";
    }
    return body;
  }

  private async request(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
    const res = await fetch(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI Responses API error ${res.status}: ${boundedText(text)}`);
    }
    return res;
  }

  async chat(system: string, messages: LlmMessage[], tools: AgentToolDef[], signal?: AbortSignal): Promise<LlmResponse> {
    const res = await this.request(this.requestBody(system, messages, tools, false), signal);
    const data = await res.json() as Record<string, unknown>;
    if (data.status === "failed" || data.error) throw responseError(data);
    return parseResponsesOutput(data, this.name);
  }

  async *chatStream(system: string, messages: LlmMessage[], tools: AgentToolDef[], signal?: AbortSignal): AsyncIterable<StreamDelta> {
    const res = await this.request(this.requestBody(system, messages, tools, true), signal);
    yield* parseResponsesStream(res);
  }
}

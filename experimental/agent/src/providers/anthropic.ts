import type { LlmProvider, LlmMessage, AgentToolDef, LlmResponse, ContentBlock, StreamDelta } from "./types.js";
import { stripForeignReasoning } from "./history.js";
import type { ReasoningEffort } from "../models.js";

const PROVIDER_NAME = "anthropic";

/** Thinking budget per effort level; always clamped below max_tokens. */
const THINKING_BUDGETS: Record<ReasoningEffort, number> = {
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
};

/** Anthropic rejects budget_tokens below this. */
const MIN_THINKING_BUDGET = 1024;

export class AnthropicProvider implements LlmProvider {
  name = PROVIDER_NAME;
  contextWindow = 200_000;
  maxOutputTokens: number;
  private apiKey: string;
  model: string;
  private cacheEnabled: boolean;
  reasoningEffort?: ReasoningEffort;

  constructor(
    apiKey: string,
    model?: string,
    maxOutputTokens?: number,
    cacheEnabled = true,
    reasoningEffort?: ReasoningEffort,
  ) {
    this.apiKey = apiKey;
    this.model = model ?? "claude-sonnet-4-20250514";
    this.maxOutputTokens = maxOutputTokens ?? 8192;
    this.cacheEnabled = cacheEnabled;
    this.reasoningEffort = reasoningEffort;
  }

  /**
   * Resolved thinking budget, or null when thinking stays off. The budget
   * must fit under max_tokens (thinking counts against it), so it is clamped
   * to half the output cap and dropped entirely if that leaves less than the
   * API minimum.
   */
  thinkingBudget(): number | null {
    if (!this.reasoningEffort) return null;
    const budget = Math.min(THINKING_BUDGETS[this.reasoningEffort], Math.floor(this.maxOutputTokens / 2));
    return budget >= MIN_THINKING_BUDGET ? budget : null;
  }

  async chat(system: string, messages: LlmMessage[], tools: AgentToolDef[]): Promise<LlmResponse> {
    const body = this.buildRequestBody(system, messages, tools);

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${text}`);
    }

    const data = await res.json() as Record<string, unknown>;
    const content = parseWireContent(data.content);
    const stop_reason = data.stop_reason === "tool_use" ? "tool_use"
      : data.stop_reason === "max_tokens" ? "max_tokens"
      : "end_turn";

    const usage = data.usage as Record<string, number> | undefined;
    logCacheUsage(usage);
    return {
      content,
      stop_reason: stop_reason as LlmResponse["stop_reason"],
      usage: usage ? { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0 } : undefined,
    };
  }

  async *chatStream(system: string, messages: LlmMessage[], tools: AgentToolDef[]): AsyncIterable<StreamDelta> {
    const body = this.buildRequestBody(system, messages, tools);
    body.stream = true;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${text}`);
    }

    let stopReason: LlmResponse["stop_reason"] = "end_turn";
    let usage: { input_tokens: number; output_tokens: number } | undefined;
    // Map block index to tool ID for consistent ID across start/delta/end
    const indexToToolId = new Map<number, string>();
    // Thinking blocks are index-tracked too: the signature arrives as a
    // delta and must ride the reasoning_end at content_block_stop.
    const thinkingByIndex = new Map<number, { signature?: string }>();

    for await (const event of parseSSE(res)) {
      const type = event.event;
      const data = event.data;

      if (type === "content_block_start") {
        const block = data.content_block as Record<string, unknown>;
        if (block.type === "tool_use") {
          const index = data.index as number;
          const id = block.id as string;
          indexToToolId.set(index, id);
          yield { type: "tool_use_start", id, name: block.name as string };
        } else if (block.type === "thinking") {
          thinkingByIndex.set(data.index as number, {});
        } else if (block.type === "redacted_thinking") {
          // Arrives complete: opaque payload, no deltas, no signature.
          yield {
            type: "reasoning_end",
            redacted: true,
            ...(typeof block.data === "string" ? { data: block.data } : {}),
          };
        }
      } else if (type === "content_block_delta") {
        const delta = data.delta as Record<string, unknown>;
        if (delta.type === "text_delta") {
          yield { type: "text_delta", text: delta.text as string };
        } else if (delta.type === "thinking_delta") {
          yield { type: "reasoning_delta", text: delta.thinking as string };
        } else if (delta.type === "signature_delta") {
          const state = thinkingByIndex.get(data.index as number);
          if (state) state.signature = (state.signature ?? "") + (delta.signature as string);
        } else if (delta.type === "input_json_delta") {
          const index = data.index as number;
          const id = indexToToolId.get(index) ?? String(index);
          yield { type: "tool_use_delta", id, json: delta.partial_json as string };
        }
      } else if (type === "content_block_stop") {
        const index = data.index as number;
        if (thinkingByIndex.has(index)) {
          const state = thinkingByIndex.get(index)!;
          thinkingByIndex.delete(index);
          yield {
            type: "reasoning_end",
            ...(state.signature !== undefined ? { signature: state.signature } : {}),
          };
        }
        if (indexToToolId.has(index)) {
          yield { type: "tool_use_end", id: indexToToolId.get(index)! };
        }
      } else if (type === "message_delta") {
        const delta = data.delta as Record<string, unknown>;
        if (delta.stop_reason === "tool_use") stopReason = "tool_use";
        else if (delta.stop_reason === "max_tokens") stopReason = "max_tokens";
        // message_delta carries output_tokens — merge with existing input_tokens from message_start
        const u = data.usage as Record<string, number> | undefined;
        if (u) {
          usage = {
            input_tokens: usage?.input_tokens ?? 0,
            output_tokens: u.output_tokens ?? 0,
          };
        }
      } else if (type === "message_start") {
        // message_start carries input_tokens — initialize usage
        const u = (data.message as Record<string, unknown>)?.usage as Record<string, number> | undefined;
        if (u) {
          logCacheUsage(u);
          usage = {
            input_tokens: u.input_tokens ?? 0,
            output_tokens: usage?.output_tokens ?? 0,
          };
        }
      }
    }

    yield { type: "done", stop_reason: stopReason, usage };
  }

  /** Build the request body with optional prompt caching breakpoints. */
  private buildRequestBody(system: string, messages: LlmMessage[], tools: AgentToolDef[]): Record<string, unknown> {
    const cache = { cache_control: { type: "ephemeral" } };

    // System prompt: use content array format with cache_control on the text block
    const systemValue = this.cacheEnabled
      ? [{ type: "text", text: system, ...cache }]
      : system;

    const mappedMessages: Array<{ role: string; content: string | Record<string, unknown>[] }> =
      stripForeignReasoning(messages, PROVIDER_NAME).map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : m.content.map(toWireBlock),
      }));

    // Mark the last 2 user messages with cache_control for recent-context caching
    if (this.cacheEnabled) {
      let marked = 0;
      for (let i = mappedMessages.length - 1; i >= 0 && marked < 2; i--) {
        if (mappedMessages[i].role !== "user") continue;
        const c = mappedMessages[i].content;
        if (typeof c === "string") {
          mappedMessages[i] = {
            role: "user",
            content: [{ type: "text", text: c, ...cache }],
          };
        } else if (Array.isArray(c) && c.length > 0) {
          // Add cache_control to the last block of the content array
          const blocks = [...c];
          blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], ...cache };
          mappedMessages[i] = { role: "user", content: blocks };
        }
        marked++;
      }
    }

    const body: Record<string, unknown> = {
      model: this.model,
      system: systemValue,
      messages: mappedMessages,
      max_tokens: this.maxOutputTokens,
    };

    const budget = this.thinkingBudget();
    if (budget !== null) {
      body.thinking = { type: "enabled", budget_tokens: budget };
    }

    if (tools.length > 0) {
      const mappedTools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      }));
      // Cache the last tool definition — Anthropic uses it as the breakpoint for the entire tools block
      if (this.cacheEnabled) {
        mappedTools[mappedTools.length - 1] = { ...mappedTools[mappedTools.length - 1], ...cache };
      }
      body.tools = mappedTools;
    }

    return body;
  }
}

/**
 * Serialize one internal block into Anthropic wire format. Reasoning blocks
 * become thinking/redacted_thinking (the API verifies the signature when the
 * conversation continues into tool use); other blocks already match the wire
 * shape, minus our internal-only fields.
 */
export function toWireBlock(block: ContentBlock): Record<string, unknown> {
  if (block.type === "reasoning") {
    if (block.redacted) {
      return { type: "redacted_thinking", data: block.data ?? "" };
    }
    return {
      type: "thinking",
      thinking: block.text,
      ...(block.signature !== undefined ? { signature: block.signature } : {}),
    };
  }
  return block as unknown as Record<string, unknown>;
}

/**
 * Parse Anthropic wire content into internal blocks. Thinking blocks become
 * tagged reasoning blocks; unknown wire types are dropped (they cannot be
 * round-tripped and a blind cast previously let them pollute saved history).
 */
export function parseWireContent(raw: unknown): ContentBlock[] {
  if (!Array.isArray(raw)) return [];
  const content: ContentBlock[] = [];
  for (const item of raw as Array<Record<string, unknown>>) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "text" || item.type === "tool_use" || item.type === "tool_result") {
      content.push(item as unknown as ContentBlock);
    } else if (item.type === "thinking") {
      content.push({
        type: "reasoning",
        text: typeof item.thinking === "string" ? item.thinking : "",
        provider: PROVIDER_NAME,
        ...(typeof item.signature === "string" ? { signature: item.signature } : {}),
      });
    } else if (item.type === "redacted_thinking") {
      content.push({
        type: "reasoning",
        text: "",
        provider: PROVIDER_NAME,
        redacted: true,
        ...(typeof item.data === "string" ? { data: item.data } : {}),
      });
    }
  }
  return content;
}

/** Log cache hit/creation stats to stderr (visible in verbose mode). */
function logCacheUsage(usage: Record<string, number> | undefined): void {
  if (!usage) return;
  const created = usage.cache_creation_input_tokens;
  const read = usage.cache_read_input_tokens;
  if (created || read) {
    process.stderr.write(
      `[cache] created=${created ?? 0} read=${read ?? 0} input=${usage.input_tokens ?? 0}\n`,
    );
  }
}

/** Parse SSE stream from a fetch Response. */
async function* parseSSE(res: Response): AsyncIterable<{ event: string; data: Record<string, unknown> }> {
  if (!res.body) throw new Error("Provider returned empty response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let currentEvent = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const lines = buf.split("\n");
    buf = lines.pop()!;

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        const raw = line.slice(6);
        if (raw === "[DONE]") return;
        try {
          yield { event: currentEvent, data: JSON.parse(raw) };
        } catch { /* skip malformed JSON */ }
      }
    }
  }
}

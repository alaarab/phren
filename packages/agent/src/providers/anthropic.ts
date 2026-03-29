import type { LlmProvider, LlmMessage, AgentToolDef, LlmResponse, ContentBlock, StreamDelta, LlmRequestOptions, EffortLevel } from "./types.js";

/** Map effort levels to Anthropic's thinking/budget parameters. */
function effortToConfig(effort: EffortLevel): { maxTokens: number; thinkingBudget?: number } {
  switch (effort) {
    case "low":    return { maxTokens: 4096 };
    case "medium": return { maxTokens: 8192 };
    case "high":   return { maxTokens: 16384 };
    case "max":    return { maxTokens: 32768, thinkingBudget: 10000 };
  }
}

export class AnthropicProvider implements LlmProvider {
  name = "anthropic";
  contextWindow = 200_000;
  maxOutputTokens: number;
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model?: string, maxOutputTokens?: number) {
    this.apiKey = apiKey;
    this.model = model ?? "claude-sonnet-4-20250514";
    this.maxOutputTokens = maxOutputTokens ?? 8192;
  }

  async chat(system: string, messages: LlmMessage[], tools: AgentToolDef[], options?: LlmRequestOptions): Promise<LlmResponse> {
    const effort = options?.effort ?? "high";
    const cacheEnabled = options?.cacheEnabled !== false;
    const effortCfg = effortToConfig(effort);

    // Build system content with cache control
    const systemContent = cacheEnabled
      ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
      : system;

    const body: Record<string, unknown> = {
      model: this.model,
      system: systemContent,
      messages: formatMessages(messages, cacheEnabled),
      max_tokens: effortCfg.maxTokens || this.maxOutputTokens,
    };

    if (tools.length > 0) {
      body.tools = formatTools(tools, cacheEnabled);
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
    };

    // Enable prompt caching beta
    if (cacheEnabled) {
      headers["anthropic-beta"] = "prompt-caching-2024-07-31";
    }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${text}`);
    }

    const data = await res.json() as Record<string, unknown>;
    const content = (data.content as ContentBlock[]) ?? [];
    const stop_reason = data.stop_reason === "tool_use" ? "tool_use"
      : data.stop_reason === "max_tokens" ? "max_tokens"
      : "end_turn";

    const usage = data.usage as Record<string, number> | undefined;
    return {
      content,
      stop_reason: stop_reason as LlmResponse["stop_reason"],
      usage: usage ? {
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      } : undefined,
    };
  }

  async *chatStream(system: string, messages: LlmMessage[], tools: AgentToolDef[], options?: LlmRequestOptions): AsyncIterable<StreamDelta> {
    const effort = options?.effort ?? "high";
    const cacheEnabled = options?.cacheEnabled !== false;
    const effortCfg = effortToConfig(effort);

    const systemContent = cacheEnabled
      ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
      : system;

    const body: Record<string, unknown> = {
      model: this.model,
      system: systemContent,
      messages: formatMessages(messages, cacheEnabled),
      max_tokens: effortCfg.maxTokens || this.maxOutputTokens,
      stream: true,
    };

    if (tools.length > 0) {
      body.tools = formatTools(tools, cacheEnabled);
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
    };

    if (cacheEnabled) {
      headers["anthropic-beta"] = "prompt-caching-2024-07-31";
    }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${text}`);
    }

    let stopReason: LlmResponse["stop_reason"] = "end_turn";
    let usage: LlmResponse["usage"] | undefined;
    const indexToToolId = new Map<number, string>();

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
        }
      } else if (type === "content_block_delta") {
        const delta = data.delta as Record<string, unknown>;
        if (delta.type === "text_delta") {
          yield { type: "text_delta", text: delta.text as string };
        } else if (delta.type === "input_json_delta") {
          const index = data.index as number;
          const id = indexToToolId.get(index) ?? String(index);
          yield { type: "tool_use_delta", id, json: delta.partial_json as string };
        }
      } else if (type === "content_block_stop") {
        const index = data.index as number;
        if (indexToToolId.has(index)) {
          yield { type: "tool_use_end", id: indexToToolId.get(index)! };
        }
      } else if (type === "message_delta") {
        const delta = data.delta as Record<string, unknown>;
        if (delta.stop_reason === "tool_use") stopReason = "tool_use";
        else if (delta.stop_reason === "max_tokens") stopReason = "max_tokens";
        const u = data.usage as Record<string, number> | undefined;
        if (u) {
          usage = {
            input_tokens: u.input_tokens ?? 0,
            output_tokens: u.output_tokens ?? 0,
            cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
            cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
          };
        }
      } else if (type === "message_start") {
        const u = (data.message as Record<string, unknown>)?.usage as Record<string, number> | undefined;
        if (u) {
          usage = {
            input_tokens: u.input_tokens ?? 0,
            output_tokens: u.output_tokens ?? 0,
            cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
            cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
          };
        }
      }
    }

    yield { type: "done", stop_reason: stopReason, usage };
  }
}

/**
 * Format messages for Anthropic API, adding cache_control breakpoints.
 * We add cache_control to the last user message to maximize cache hits.
 */
function formatMessages(messages: LlmMessage[], cacheEnabled: boolean): unknown[] {
  if (!cacheEnabled) {
    return messages.map(m => ({ role: m.role, content: m.content }));
  }

  return messages.map((m, i) => {
    // Add cache breakpoint to the last two user messages for best cache hit rate
    const isRecentUser = m.role === "user" && i >= messages.length - 4;

    if (isRecentUser && typeof m.content === "string") {
      return {
        role: m.role,
        content: [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }],
      };
    }

    if (isRecentUser && Array.isArray(m.content)) {
      const content = [...m.content];
      if (content.length > 0) {
        const last = { ...content[content.length - 1] };
        (last as Record<string, unknown>).cache_control = { type: "ephemeral" };
        content[content.length - 1] = last;
      }
      return { role: m.role, content };
    }

    return { role: m.role, content: m.content };
  });
}

/**
 * Format tools with cache_control on the last tool definition.
 * This caches the entire tool block for subsequent requests.
 */
function formatTools(tools: AgentToolDef[], cacheEnabled: boolean): unknown[] {
  const formatted = tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));

  if (cacheEnabled && formatted.length > 0) {
    const last = { ...formatted[formatted.length - 1] };
    (last as Record<string, unknown>).cache_control = { type: "ephemeral" };
    formatted[formatted.length - 1] = last;
  }

  return formatted;
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

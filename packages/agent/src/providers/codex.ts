/**
 * Codex provider — uses ChatGPT subscription via OAuth token.
 * Calls chatgpt.com/backend-api/codex/responses (Responses API format).
 */
import type { LlmProvider, LlmMessage, AgentToolDef, LlmResponse, ContentBlock, StreamDelta } from "./types.js";
import { getAccessToken } from "./codex-auth.js";

const CODEX_API = "https://chatgpt.com/backend-api/codex/responses";

/** Convert our tool defs to Responses API tool format. */
function toResponsesTools(tools: AgentToolDef[]) {
  return tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  }));
}

/** Convert our messages to Responses API input format. */
function toResponsesInput(system: string, messages: LlmMessage[]) {
  const input: Record<string, unknown>[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        input.push({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: msg.content }],
        });
      } else {
        // tool_result blocks
        for (const block of msg.content) {
          if (block.type === "tool_result") {
            input.push({
              type: "function_call_output",
              call_id: block.tool_use_id,
              output: block.content,
            });
          } else if (block.type === "text") {
            input.push({
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: block.text }],
            });
          }
        }
      }
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: msg.content }],
        });
      } else {
        for (const block of msg.content) {
          if (block.type === "text") {
            input.push({
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: block.text }],
            });
          } else if (block.type === "tool_use") {
            input.push({
              type: "function_call",
              call_id: block.id,
              name: block.name,
              arguments: JSON.stringify(block.input),
            });
          }
        }
      }
    }
  }
  return input;
}

/** Parse non-streaming Responses API output into our ContentBlock format. */
function parseResponsesOutput(data: Record<string, unknown>): LlmResponse {
  const output = data.output as Record<string, unknown>[] | undefined;
  const content: ContentBlock[] = [];
  let hasToolUse = false;

  if (output) {
    for (const item of output) {
      if (item.type === "message") {
        const msgContent = item.content as Array<{ type: string; text?: string }> | undefined;
        if (msgContent) {
          for (const c of msgContent) {
            if (c.type === "output_text" && c.text) {
              content.push({ type: "text", text: c.text });
            }
          }
        }
      } else if (item.type === "function_call") {
        hasToolUse = true;
        content.push({
          type: "tool_use",
          id: item.call_id as string,
          name: item.name as string,
          input: JSON.parse(item.arguments as string),
        });
      }
    }
  }

  const status = data.status as string;
  const stop_reason = hasToolUse ? "tool_use"
    : status === "incomplete" ? "max_tokens"
    : "end_turn";

  const usage = data.usage as Record<string, number> | undefined;
  return {
    content,
    stop_reason,
    usage: usage ? { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0 } : undefined,
  };
}

export class CodexProvider implements LlmProvider {
  name = "codex";
  contextWindow = 128_000;
  maxOutputTokens: number;
  private model: string;

  constructor(model?: string, maxOutputTokens?: number) {
    this.model = model ?? "gpt-5.3-codex";
    this.maxOutputTokens = maxOutputTokens ?? 8192;
  }

  async chat(system: string, messages: LlmMessage[], tools: AgentToolDef[]): Promise<LlmResponse> {
    const { accessToken } = await getAccessToken();

    const body: Record<string, unknown> = {
      model: this.model,
      instructions: system,
      input: toResponsesInput(system, messages),
      store: false,
      stream: true,
    };
    if (tools.length > 0) {
      body.tools = toResponsesTools(tools);
      body.tool_choice = "auto";
    }

    const bodyStr = JSON.stringify(body);

    const res = await fetch(CODEX_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: bodyStr,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Codex API error ${res.status}: ${text}`);
    }

    // Stream is mandatory for Codex backend — consume it and collect the final response
    if (!res.body) throw new Error("Provider returned empty response body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalResponse: Record<string, unknown> | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        try {
          const event = JSON.parse(data);
          if (event.type === "response.completed" && event.response) {
            finalResponse = event.response;
          }
        } catch { /* skip */ }
      }
    }

    if (finalResponse) return parseResponsesOutput(finalResponse);

    // No response.completed event received
    throw new Error("Codex stream ended without response.completed event");
  }

  async *chatStream(system: string, messages: LlmMessage[], tools: AgentToolDef[]): AsyncIterable<StreamDelta> {
    const { accessToken } = await getAccessToken();

    const body: Record<string, unknown> = {
      model: this.model,
      instructions: system,
      input: toResponsesInput(system, messages),
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
    };
    if (tools.length > 0) {
      body.tools = toResponsesTools(tools);
      body.tool_choice = "auto";
    }

    const res = await fetch(CODEX_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Codex API error ${res.status}: ${text}`);
    }

    // Parse SSE stream
    if (!res.body) throw new Error("Provider returned empty response body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let activeToolCallId = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") return;

        let event: Record<string, unknown>;
        try { event = JSON.parse(data); } catch { continue; }

        const type = event.type as string;

        if (type === "response.output_text.delta") {
          const delta = event.delta as string;
          if (delta) yield { type: "text_delta", text: delta };
        } else if (type === "response.output_item.added") {
          if ((event.item as Record<string, unknown>)?.type === "function_call") {
            const item = event.item as Record<string, unknown>;
            activeToolCallId = item.call_id as string;
            yield { type: "tool_use_start", id: activeToolCallId, name: item.name as string };
          }
        } else if (type === "response.function_call_arguments.delta") {
          yield { type: "tool_use_delta", id: activeToolCallId, json: event.delta as string };
        } else if (type === "response.function_call_arguments.done") {
          yield { type: "tool_use_end", id: activeToolCallId };
        } else if (type === "response.completed") {
          const response = event.response as Record<string, unknown> | undefined;
          const usage = response?.usage as Record<string, number> | undefined;
          const output = response?.output as Record<string, unknown>[] | undefined;
          const hasToolCalls = output?.some((o) => o.type === "function_call");
          yield {
            type: "done",
            stop_reason: hasToolCalls ? "tool_use" : "end_turn",
            usage: usage ? { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0 } : undefined,
          };
        }
      }
    }
  }
}

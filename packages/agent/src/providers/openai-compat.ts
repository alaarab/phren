/** Shared OpenAI-compatible message/tool conversion used by openrouter, codex, and openai providers. */
import type { LlmMessage, AgentToolDef, LlmResponse, ContentBlock, StreamDelta } from "./types.js";

/** Convert Anthropic tool defs to OpenAI function format. */
export function toOpenAiTools(tools: AgentToolDef[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

/** Convert Anthropic messages to OpenAI messages. */
export function toOpenAiMessages(system: string, messages: LlmMessage[]) {
  const out: Record<string, unknown>[] = [{ role: "system", content: system }];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        out.push({ role: "assistant", content: msg.content });
      } else {
        const textParts = msg.content.filter((b) => b.type === "text").map((b) => b.type === "text" ? b.text : "");
        const toolCalls = msg.content.filter((b) => b.type === "tool_use").map((b) => {
          if (b.type !== "tool_use") throw new Error("unreachable");
          return { id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } };
        });
        const entry: Record<string, unknown> = { role: "assistant" };
        if (textParts.length > 0) entry.content = textParts.join("\n");
        if (toolCalls.length > 0) entry.tool_calls = toolCalls;
        out.push(entry);
      }
    } else if (msg.role === "user") {
      if (typeof msg.content === "string") {
        out.push({ role: "user", content: msg.content });
      } else {
        for (const block of msg.content) {
          if (block.type === "tool_result") {
            out.push({ role: "tool", tool_call_id: block.tool_use_id, content: block.content });
          } else if (block.type === "text") {
            out.push({ role: "user", content: block.text });
          }
        }
      }
    }
  }
  return out;
}

/** Parse OpenAI response into Anthropic content blocks. */
export function parseOpenAiResponse(data: Record<string, unknown>): LlmResponse {
  const choice = (data.choices as Record<string, unknown>[])?.[0] ?? {};
  const message = choice.message as Record<string, unknown> | undefined;
  const content: ContentBlock[] = [];

  if (message?.content && typeof message.content === "string") {
    content.push({ type: "text", text: message.content });
  }

  const toolCalls = message?.tool_calls as Record<string, unknown>[] | undefined;
  if (toolCalls) {
    for (const tc of toolCalls) {
      const fn = tc.function as Record<string, unknown>;
      content.push({
        type: "tool_use",
        id: tc.id as string,
        name: fn.name as string,
        input: JSON.parse(fn.arguments as string),
      });
    }
  }

  const finishReason = choice.finish_reason as string;
  const stop_reason = finishReason === "tool_calls" ? "tool_use"
    : finishReason === "length" ? "max_tokens"
    : "end_turn";

  const usage = data.usage as Record<string, number> | undefined;
  return {
    content,
    stop_reason,
    usage: usage ? { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0 } : undefined,
  };
}

/** Parse OpenAI-compatible SSE stream into StreamDelta events. */
export async function* parseOpenAiStream(res: Response): AsyncIterable<StreamDelta> {
  if (!res.body) throw new Error("Provider returned empty response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  // Track active tool calls by index
  const activeTools = new Map<number, string>(); // index -> tool_call id
  let stopReason: LlmResponse["stop_reason"] = "end_turn";
  let usage: { input_tokens: number; output_tokens: number } | undefined;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const lines = buf.split("\n");
    buf = lines.pop()!;

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (raw === "[DONE]") {
        // Close out any active tool calls before signaling done
        for (const [, toolId] of activeTools) {
          yield { type: "tool_use_end", id: toolId };
        }
        activeTools.clear();
        yield { type: "done", stop_reason: stopReason, usage };
        return;
      }

      let chunk: Record<string, unknown>;
      try { chunk = JSON.parse(raw); } catch { continue; }

      // Usage from final chunk (OpenAI includes it when stream_options.include_usage is set)
      const u = chunk.usage as Record<string, number> | undefined;
      if (u) {
        usage = { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0 };
      }

      const choice = (chunk.choices as Record<string, unknown>[])?.[0];
      if (!choice) continue;

      const finishReason = choice.finish_reason as string | null;
      if (finishReason === "tool_calls") stopReason = "tool_use";
      else if (finishReason === "length") stopReason = "max_tokens";

      const delta = choice.delta as Record<string, unknown> | undefined;
      if (!delta) continue;

      // Text content
      if (delta.content && typeof delta.content === "string") {
        yield { type: "text_delta", text: delta.content };
      }

      // Tool calls
      const toolCalls = delta.tool_calls as Record<string, unknown>[] | undefined;
      if (toolCalls) {
        for (const tc of toolCalls) {
          const idx = tc.index as number;
          const fn = tc.function as Record<string, unknown> | undefined;

          // New tool call starts when id is present
          if (tc.id && typeof tc.id === "string") {
            activeTools.set(idx, tc.id);
            yield { type: "tool_use_start", id: tc.id, name: fn?.name as string ?? "" };
          }

          // Argument deltas
          if (fn?.arguments && typeof fn.arguments === "string") {
            const toolId = activeTools.get(idx) ?? String(idx);
            yield { type: "tool_use_delta", id: toolId, json: fn.arguments };
          }
        }
      }
    }
  }

  // Emit tool_use_end for all active tools, then done
  for (const [, toolId] of activeTools) {
    yield { type: "tool_use_end", id: toolId };
  }
  yield { type: "done", stop_reason: stopReason, usage };
}

/** Shared OpenAI-compatible message/tool conversion used by openrouter, codex, and openai providers. */
import type { LlmMessage, AgentToolDef, LlmResponse, ContentBlock, StreamDelta } from "./types.js";
import { stripForeignReasoning, IMAGE_OMITTED_MARKER } from "./history.js";

/** Convert Anthropic tool defs to OpenAI function format. */
export function toOpenAiTools(tools: AgentToolDef[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

/**
 * Convert Anthropic messages to OpenAI messages.
 *
 * `providerName` scopes which reasoning blocks belong to this provider; when
 * omitted, all reasoning is stripped (conservative). Own reasoning is passed
 * back as `reasoning_content` only on tool-call turns — the field is ignored
 * on plain turns by providers that support it (DeepSeek's documented rule),
 * so sending it there just wastes tokens. Assistant `content` is always a
 * string, never null/absent: some gateways 400 on a null-content assistant
 * message, and history is durable, so one would poison every later turn.
 */
export function toOpenAiMessages(system: string, messages: LlmMessage[], providerName?: string, vision = false) {
  const out: Record<string, unknown>[] = [{ role: "system", content: system }];
  for (const msg of stripForeignReasoning(messages, providerName)) {
    if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        out.push({ role: "assistant", content: msg.content });
      } else {
        const textParts = msg.content.filter((b) => b.type === "text").map((b) => b.type === "text" ? b.text : "");
        const reasoningParts = msg.content
          .filter((b) => b.type === "reasoning")
          .map((b) => (b.type === "reasoning" ? b.text : ""))
          .filter(Boolean);
        const toolCalls = msg.content.filter((b) => b.type === "tool_use").map((b) => {
          if (b.type !== "tool_use") throw new Error("unreachable");
          return { id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } };
        });
        const entry: Record<string, unknown> = { role: "assistant", content: textParts.join("\n") };
        if (toolCalls.length > 0) {
          entry.tool_calls = toolCalls;
          if (reasoningParts.length > 0) entry.reasoning_content = reasoningParts.join("\n");
        }
        out.push(entry);
      }
    } else if (msg.role === "user") {
      if (typeof msg.content === "string") {
        out.push({ role: "user", content: msg.content });
      } else {
        for (const block of msg.content) {
          if (block.type === "tool_result") {
            if (typeof block.content === "string") {
              out.push({ role: "tool", tool_call_id: block.tool_use_id, content: block.content });
            } else {
              // Mixed text/image result: the tool message carries the text;
              // images follow as a user message with image_url parts (Chat
              // Completions has no image slot on tool messages). Text-only
              // models get a marker instead of a request that would 400 on
              // every later turn of the durable history.
              const textParts = block.content.filter((c) => c.type === "text").map((c) => (c.type === "text" ? c.text : ""));
              const imageParts = block.content.filter((c) => c.type === "image");
              out.push({ role: "tool", tool_call_id: block.tool_use_id, content: textParts.join("\n") });
              if (imageParts.length > 0) {
                if (vision) {
                  out.push({
                    role: "user",
                    content: imageParts.map((c) => (c.type === "image" ? {
                      type: "image_url",
                      image_url: { url: `data:${c.source.media_type};base64,${c.source.data}` },
                    } : { type: "text", text: "" })),
                  });
                } else {
                  out.push({ role: "user", content: IMAGE_OMITTED_MARKER });
                }
              }
            }
          } else if (block.type === "image") {
            if (vision) {
              out.push({
                role: "user",
                content: [{
                  type: "image_url",
                  image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
                }],
              });
            } else {
              out.push({ role: "user", content: IMAGE_OMITTED_MARKER });
            }
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
export function parseOpenAiResponse(data: Record<string, unknown>, providerName?: string): LlmResponse {
  const choice = (data.choices as Record<string, unknown>[])?.[0] ?? {};
  const message = choice.message as Record<string, unknown> | undefined;
  const content: ContentBlock[] = [];

  // Visible reasoning: DeepSeek/Qwen use reasoning_content, OpenRouter's
  // unified field is reasoning. Reasoning precedes the answer.
  const reasoningText = typeof message?.reasoning_content === "string"
    ? message.reasoning_content
    : typeof message?.reasoning === "string" ? message.reasoning : "";
  if (reasoningText) {
    content.push({
      type: "reasoning",
      text: reasoningText,
      ...(providerName !== undefined ? { provider: providerName } : {}),
    });
  }

  if (message?.content && typeof message.content === "string") {
    content.push({ type: "text", text: message.content });
  }

  const toolCalls = message?.tool_calls as Record<string, unknown>[] | undefined;
  if (toolCalls) {
    for (const tc of toolCalls) {
      const fn = tc.function as Record<string, unknown>;
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(fn.arguments as string); } catch { /* malformed arguments */ }
      content.push({
        type: "tool_use",
        id: tc.id as string,
        name: fn.name as string,
        input,
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

      // Reasoning content (DeepSeek/Qwen reasoning_content, OpenRouter reasoning)
      const reasoningDelta = typeof delta.reasoning_content === "string"
        ? delta.reasoning_content
        : typeof delta.reasoning === "string" ? delta.reasoning : "";
      if (reasoningDelta) {
        yield { type: "reasoning_delta", text: reasoningDelta };
      }

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

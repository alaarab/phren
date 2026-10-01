/** Shared OpenAI-compatible message/tool conversion used by openrouter, codex, and openai providers. */
import type { LlmMessage, AgentToolDef, LlmResponse, ContentBlock, StreamDelta, TokenUsage } from "./types.js";
import { IncompleteStreamError, RetryableProviderError, type InvalidToolCall } from "./types.js";
import type { ReasoningEffort } from "../models.js";
import { stripForeignReasoning, IMAGE_OMITTED_MARKER } from "./history.js";

/** Convert Anthropic tool defs to OpenAI function format. */
export function toOpenAiTools(tools: AgentToolDef[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

/** DeepSeek directly, or any OpenAI-compatible endpoint (OpenCode Go, a proxy) serving a DeepSeek model. */
export function isDeepSeekRoute(providerName: string | undefined, model: string | undefined): boolean {
  if (providerName === "deepseek") return true;
  return providerName === "openai-compat" && /deepseek/i.test(model ?? "");
}

/**
 * Routes that require every earlier assistant turn's `reasoning_content` back
 * when tools are present. DeepSeek returns HTTP 400 when a plain-answer turn
 * arrives without it.
 */
export function replaysAllReasoning(providerName: string | undefined, model: string | undefined): boolean {
  return isDeepSeekRoute(providerName, model);
}

/**
 * DeepSeek's reasoning_effort takes none, low, high and max; it has no medium
 * and treats xhigh as high, so map Phren's levels onto what it documents.
 */
const DEEPSEEK_EFFORT: Record<ReasoningEffort, string> = {
  none: "none",
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "max",
};

/** The reasoning_effort value to send on this route. */
export function wireReasoningEffort(
  providerName: string | undefined,
  model: string | undefined,
  effort: ReasoningEffort | undefined,
): string | undefined {
  if (!effort) return undefined;
  return isDeepSeekRoute(providerName, model) ? DEEPSEEK_EFFORT[effort] : effort;
}

/**
 * Convert Anthropic messages to OpenAI messages.
 *
 * `providerName` scopes which reasoning blocks belong to this provider; when
 * omitted, all reasoning is stripped (conservative). Own reasoning is passed
 * back as `reasoning_content` on tool-call turns; with `replayAllReasoning`
 * (DeepSeek routes, see replaysAllReasoning) it goes on every assistant turn,
 * empty when the turn had none. Assistant `content` is always a string, never
 * null/absent: some gateways 400 on a null-content assistant message, and
 * history is durable, so one would poison every later turn.
 */
export function toOpenAiMessages(
  system: string,
  messages: LlmMessage[],
  providerName?: string,
  vision = false,
  replayAllReasoning = false,
) {
  const out: Record<string, unknown>[] = [{ role: "system", content: system }];
  for (const msg of stripForeignReasoning(messages, providerName)) {
    if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        out.push({ role: "assistant", content: msg.content, ...(replayAllReasoning ? { reasoning_content: "" } : {}) });
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
        if (toolCalls.length > 0) entry.tool_calls = toolCalls;
        if (replayAllReasoning) entry.reasoning_content = reasoningParts.join("\n");
        else if (toolCalls.length > 0 && reasoningParts.length > 0) entry.reasoning_content = reasoningParts.join("\n");
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

/**
 * Chat Completions usage → TokenUsage. prompt_tokens includes cache hits:
 * DeepSeek reports them as prompt_cache_hit_tokens, OpenAI (and most relays)
 * as prompt_tokens_details.cached_tokens.
 */
export function parseOpenAiUsage(u: Record<string, unknown>): TokenUsage {
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const prompt = num(u.prompt_tokens);
  const details = u.prompt_tokens_details as Record<string, unknown> | undefined;
  const cached = Math.min(prompt, num(u.prompt_cache_hit_tokens) || num(details?.cached_tokens));
  return {
    input_tokens: prompt - cached,
    output_tokens: num(u.completion_tokens),
    ...(cached > 0 ? { cache_read_input_tokens: cached } : {}),
  };
}

/**
 * Parse a tool call's JSON arguments. Empty arguments are a no-argument call;
 * anything else that isn't a JSON object is an error for the model to fix.
 */
export function parseToolArguments(raw: string): { input: Record<string, unknown> } | { error: string } {
  if (raw.trim() === "") return { input: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { input: parsed as Record<string, unknown> };
    return { error: "arguments must be a JSON object" };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * DeepSeek ends a response with finish_reason insufficient_system_resource
 * when it runs out of capacity mid-generation: the output is incomplete, and
 * a fresh request usually succeeds.
 */
function throwOnAbnormalFinish(finishReason: unknown): void {
  if (finishReason === "insufficient_system_resource") {
    throw new RetryableProviderError("Provider ran out of capacity mid-response (finish_reason: insufficient_system_resource)");
  }
  if (finishReason === "aborted") {
    throw new IncompleteStreamError("Provider aborted the response (finish_reason: aborted)");
  }
}

/** HTTP 200 can still carry an upstream error, including inside SSE data events. */
function throwProviderError(data: Record<string, unknown>): void {
  const choice = (data.choices as Record<string, unknown>[])?.[0];
  if (data.error == null && choice?.finish_reason !== "error") return;
  const detail = data.error;
  const error = detail && typeof detail === "object" ? detail as Record<string, unknown> : undefined;
  const code = error?.code;
  // Preserve the numeric status so the existing retry policy can classify it.
  const status = /^(?:[45]\d{2})$/.test(String(code)) ? ` ${code}` : "";
  const message = typeof error?.message === "string" ? error.message
    : typeof detail === "string" ? detail : "Provider reported a generation error";
  throw new Error(`API error${status}: ${message}`);
}

/** Parse OpenAI response into Anthropic content blocks. */
export function parseOpenAiResponse(data: Record<string, unknown>, providerName?: string): LlmResponse {
  throwProviderError(data);
  const choice = (data.choices as Record<string, unknown>[])?.[0] ?? {};
  throwOnAbnormalFinish(choice.finish_reason);
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
  const invalidToolCalls: InvalidToolCall[] = [];
  if (toolCalls) {
    for (const tc of toolCalls) {
      const fn = tc.function as Record<string, unknown>;
      const raw = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
      const parsed = parseToolArguments(raw);
      const id = tc.id as string;
      const name = fn.name as string;
      if ("error" in parsed) invalidToolCalls.push({ id, name, raw, error: parsed.error });
      content.push({ type: "tool_use", id, name, input: "input" in parsed ? parsed.input : {} });
    }
  }

  const finishReason = choice.finish_reason as string;
  const stop_reason = finishReason === "tool_calls" ? "tool_use"
    : finishReason === "length" ? "max_tokens"
    : "end_turn";

  const usage = data.usage as Record<string, unknown> | undefined;
  return {
    content,
    stop_reason,
    usage: usage ? parseOpenAiUsage(usage) : undefined,
    ...(invalidToolCalls.length > 0 ? { invalidToolCalls } : {}),
  };
}

/**
 * Parse OpenAI-compatible SSE stream into StreamDelta events.
 *
 * A response is complete only when the provider says so: a finish_reason or
 * the `[DONE]` sentinel. A connection that closes before either is an error,
 * not a successful end_turn with partial output, and so is DeepSeek's
 * `aborted` finish reason.
 */
export async function* parseOpenAiStream(res: Response): AsyncIterable<StreamDelta> {
  if (!res.body) throw new Error("Provider returned empty response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  // Track active tool calls by index
  const activeTools = new Map<number, string>(); // index -> tool_call id
  let stopReason: LlmResponse["stop_reason"] = "end_turn";
  let usage: TokenUsage | undefined;
  let finished = false;

  /** Handle one SSE line; returns true on the [DONE] sentinel. */
  function* handleLine(line: string): Generator<StreamDelta, boolean> {
    if (!line.startsWith("data:")) return false;
    const raw = line.slice(5).trim();
    if (raw === "[DONE]") return true;

    let chunk: Record<string, unknown>;
    try { chunk = JSON.parse(raw); } catch { return false; }
    throwProviderError(chunk);

    // Usage from final chunk (OpenAI includes it when stream_options.include_usage is set)
    const u = chunk.usage as Record<string, unknown> | undefined;
    if (u) usage = parseOpenAiUsage(u);

    const choice = (chunk.choices as Record<string, unknown>[])?.[0];
    if (!choice) return false;

    const finishReason = choice.finish_reason as string | null;
    throwOnAbnormalFinish(finishReason);
    if (finishReason) finished = true;
    if (finishReason === "tool_calls") stopReason = "tool_use";
    else if (finishReason === "length") stopReason = "max_tokens";

    const delta = choice.delta as Record<string, unknown> | undefined;
    if (!delta) return false;

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
    return false;
  }

  try {
    let sawDone = false;
    read: for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        // A final event with no trailing newline is still an event.
        buf += decoder.decode();
        if (buf && (yield* handleLine(buf))) sawDone = true;
        break;
      }
      buf += decoder.decode(value, { stream: true });

      const lines = buf.split("\n");
      buf = lines.pop()!;

      for (const line of lines) {
        if (yield* handleLine(line)) { sawDone = true; break read; }
      }
    }

    if (!finished && !sawDone) {
      throw new IncompleteStreamError("Provider stream ended before the response was complete (no finish_reason or [DONE])");
    }

    // Close out any active tool calls before signaling done
    for (const [, toolId] of activeTools) {
      yield { type: "tool_use_end", id: toolId };
    }
    yield { type: "done", stop_reason: stopReason, usage };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

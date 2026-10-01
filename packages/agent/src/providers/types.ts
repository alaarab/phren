/** LLM provider types — Anthropic content-block format internally. */
import type { ReasoningEffort } from "../models.js";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Base64 image content, Anthropic-shaped like the rest of the block system. */
export interface ImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
    data: string;
  };
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  /** Plain text, or mixed text/image parts for tools that return images. */
  content: string | Array<TextBlock | ImageBlock>;
  is_error?: boolean;
}

/** Text of a tool result, whatever its content shape (images contribute nothing). */
export function toolResultText(block: ToolResultBlock): string {
  if (typeof block.content === "string") return block.content;
  return block.content
    .filter((part): part is TextBlock => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/**
 * Model reasoning/thinking output, kept in history so tool-use chains keep
 * working on reasoning models. Provider-private round-trip material rides
 * inline (this is a single-process agent with one active provider):
 * - Anthropic: `signature` (verified thinking) or `redacted` + `data`
 * - Codex/Responses: `id` + `encrypted_content`
 * - OpenAI-compat/Ollama: text only (display + optional passback)
 * `provider` tags the origin; serializers MUST drop reasoning blocks from
 * other providers (a foreign signature/encrypted payload 400s on the wire).
 */
export interface ReasoningBlock {
  type: "reasoning";
  text: string;
  provider?: string;
  signature?: string;
  id?: string;
  encrypted_content?: string;
  redacted?: boolean;
  /** Opaque payload of an Anthropic redacted_thinking block. */
  data?: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ReasoningBlock | ImageBlock;

export interface LlmMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface AgentToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * Token usage for one response. `input_tokens` excludes cache hits and cache
 * writes, which are counted separately in `cache_read_input_tokens` and
 * `cache_creation_input_tokens` (the Anthropic and Claude Code shape), so
 * each bucket can be priced at its own rate.
 */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface LlmResponse {
  content: ContentBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens";
  usage?: TokenUsage;
  /** tool_use blocks (input {}) whose arguments failed to parse. */
  invalidToolCalls?: InvalidToolCall[];
}

// ── Streaming types ─────────────────────────────────────────────────────────

export type StreamDelta =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | {
      type: "reasoning_end";
      signature?: string;
      id?: string;
      encrypted_content?: string;
      redacted?: boolean;
      data?: string;
    }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_delta"; id: string; json: string }
  | { type: "tool_use_end"; id: string }
  | { type: "done"; stop_reason: LlmResponse["stop_reason"]; usage?: LlmResponse["usage"] };

export interface LlmProvider {
  name: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Endpoint, for OpenAI-compatible providers (decides metering, e.g. OpenCode Go). */
  baseUrl?: string;
  chat(
    system: string,
    messages: LlmMessage[],
    tools: AgentToolDef[],
    signal?: AbortSignal,
  ): Promise<LlmResponse>;
  chatStream?(
    system: string,
    messages: LlmMessage[],
    tools: AgentToolDef[],
    signal?: AbortSignal,
  ): AsyncIterable<StreamDelta>;
}

/** A provider failure that a fresh request can fix; withRetry retries it. */
export class RetryableProviderError extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = "RetryableProviderError";
  }
}

/**
 * Mark a failed stream with the usage the provider reported before it
 * failed. The attempt is retried, but its tokens were billed, so the loop
 * records them for --budget.
 */
export function withPartialUsage<E>(error: E, usage: TokenUsage | undefined): E {
  if (usage && error instanceof Error && !(error as { usage?: unknown }).usage) {
    (error as { usage?: TokenUsage }).usage = usage;
  }
  return error;
}

/** The usage withPartialUsage attached to an error, if any. */
export function partialUsage(error: unknown): TokenUsage | undefined {
  const usage = error instanceof Error ? (error as { usage?: unknown }).usage : undefined;
  return usage && typeof usage === "object" ? usage as TokenUsage : undefined;
}

/** Thrown when a stream ends without the provider saying the response is complete. */
export class IncompleteStreamError extends RetryableProviderError {
  constructor(message: string) {
    super(message);
    this.name = "IncompleteStreamError";
  }
}

/** A tool call whose arguments were not a JSON object. It is answered with an error, never run. */
export interface InvalidToolCall {
  id: string;
  name: string;
  /** The arguments as the model sent them. */
  raw: string;
  error: string;
}

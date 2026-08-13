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

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
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

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ReasoningBlock;

export interface LlmMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface AgentToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LlmResponse {
  content: ContentBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens";
  usage?: { input_tokens: number; output_tokens: number };
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
  chat(
    system: string,
    messages: LlmMessage[],
    tools: AgentToolDef[],
  ): Promise<LlmResponse>;
  chatStream?(
    system: string,
    messages: LlmMessage[],
    tools: AgentToolDef[],
  ): AsyncIterable<StreamDelta>;
}

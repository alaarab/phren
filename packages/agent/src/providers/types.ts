/** LLM provider types — Anthropic content-block format internally. */

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

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

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
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_delta"; id: string; json: string }
  | { type: "tool_use_end"; id: string }
  | { type: "done"; stop_reason: LlmResponse["stop_reason"]; usage?: LlmResponse["usage"] };

export interface LlmProvider {
  name: string;
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

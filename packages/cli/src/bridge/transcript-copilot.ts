import { object, type Json } from "./protocol.js";

/** Copilot's transcript reader: public message, tool and usage events, and
 * the reasoning summary Copilot itself prints under "Thought for Ns". Its
 * encrypted and opaque reasoning stays out. */
export function visibleCopilotEvent(raw: Json): Json | undefined {
  if (raw.agentId || raw.ephemeral || !["user.message", "assistant.message", "assistant.message_delta", "tool.execution_start", "tool.execution_complete", "assistant.turn_start", "assistant.turn_end", "session.idle", "abort", "session.error", "session.usage_info", "assistant.usage"].includes(String(raw.type))) return undefined;
  const data = object(raw.data);
  // Copilot writes its reasoning beside the message three ways: the summary
  // its terminal shows (`reasoningText`), and encrypted/opaque copies for the
  // model (`encryptedContent`, `reasoningOpaque`, `reasoningBlocks`). Only the
  // summary the person already sees in the terminal is exported.
  // `phase` marks Copilot 1.0.87's final answer (it writes no session.idle);
  // `success` is false on a failed tool run.
  const allowed = ["content", "source", "messageId", "deltaContent", "toolName", "toolCallId", "arguments", "result", "error", "success", "phase", "aborted", "reasoningText", "inputTokens", "outputTokens", "cacheReadTokens"];
  return { type: raw.type, timestamp: raw.timestamp, data: Object.fromEntries(Object.entries(data)
    .filter(([key, value]) => allowed.includes(key) && (key !== "reasoningText" || (raw.type === "assistant.message" && typeof value === "string")))
    .map(([key, value]) => [key, key === "reasoningText" ? String(value).slice(0, 8_000) : value])) };
}

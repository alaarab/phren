import { object, type Json } from "./protocol.js";

/** Copilot's transcript reader: public message, tool and usage events, with
 * optional reasoning fields dropped. */
export function visibleCopilotEvent(raw: Json): Json | undefined {
  if (raw.agentId || raw.ephemeral || !["user.message", "assistant.message", "assistant.message_delta", "tool.execution_start", "tool.execution_complete", "assistant.turn_start", "assistant.turn_end", "session.idle", "abort", "session.error", "session.usage_info", "assistant.usage"].includes(String(raw.type))) return undefined;
  const data = object(raw.data);
  // Copilot includes optional reasoning beside the public message in some
  // versions. Export only the fields used by public text/tool/usage readers.
  const allowed = ["content", "source", "messageId", "deltaContent", "toolName", "toolCallId", "arguments", "result", "error", "aborted", "inputTokens", "outputTokens", "cacheReadTokens"];
  return { type: raw.type, timestamp: raw.timestamp, data: Object.fromEntries(Object.entries(data).filter(([key]) => allowed.includes(key))) };
}

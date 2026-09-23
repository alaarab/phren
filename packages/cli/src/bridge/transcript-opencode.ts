import { object, objects, type Json } from "./protocol.js";
import { visibleOpenCodeRunEvent } from "./fanouts.js";

/** OpenCode's transcript reader, shared with phren-agent's event log: an
 * OpenCode run's own events first, then the three message events that make
 * up the conversation. */
export function visibleOpencodeEvent(raw: Json, source: "phren" | "opencode", cwd?: string): Json | undefined {
  if (source === "opencode") {
    const runEvent = visibleOpenCodeRunEvent(raw, cwd); if (runEvent) return runEvent;
  }
  // phren-agent's event log (experimental/agent/src/session/log.ts): the
  // header and log/replace splices are bookkeeping; the three message
  // events are the conversation. Reasoning blocks stay on the computer.
  if (!["user/message", "assistant/message", "tool/results"].includes(String(raw.type))) return undefined;
  const data = object(raw.data), message = object(data.message);
  const content = Array.isArray(message.content)
    ? objects(message.content).map(b => ["text", "image", "tool_use", "tool_result"].includes(String(b.type)) ? b : { type: "redacted" })
    : message.content;
  const exported: Json = { message: { role: message.role, content } };
  for (const key of ["source", "turn", "stop_reason", "usage"]) if (data[key] !== undefined) exported[key] = data[key];
  return { seq: raw.seq, time: raw.time, type: raw.type, data: exported };
}

import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { glob } from "glob";
import { withTranscriptIndex } from "./transcript-index.js";
import { BridgeError, object, objects, type Json, type Provider } from "./protocol.js";

export interface Entry { line: number; raw: Json }

/** Preserve image block indexes without putting base64 payloads on the chat socket. */
function chatFrame(raw: Json, source: Provider): Json {
  const key = source === "codex" ? "payload" : "message";
  const message = object(raw[key]);
  if (!Array.isArray(message.content)) return raw;
  return { ...raw, [key]: { ...message, content: message.content.map(value => {
    const block = object(value);
    return ["image", "input_image"].includes(String(block.type)) ? { type: block.type } : block;
  }) } };
}
export async function transcriptPath(source: Provider, session: string): Promise<string> {
  if (!/^[a-f0-9-]{36}$/i.test(session)) throw new BridgeError(400, "Invalid conversation identity.");
  const base = source === "codex" ? path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "sessions")
    : source === "claude" ? path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"), "projects")
    : path.join(process.env.COPILOT_HOME || path.join(homedir(), ".copilot"), "session-state");
  const root = await realpath(base);
  const pattern = source === "codex" ? `*/*/*/rollout-*-${session}.jsonl` : source === "claude" ? `*/${session}.jsonl` : `${session}/events.jsonl`;
  const matches = await glob(pattern, { cwd: root, absolute: true, follow: false });
  if (matches.length !== 1) throw new BridgeError(404, "The transcript is not available for this conversation.");
  const file = await realpath(matches[0]);
  if (!file.startsWith(root + path.sep)) throw new BridgeError(403, "The transcript points outside its agent folder.");
  return file;
}

/** Public conversation/tool events and real usage only. Never export private reasoning. */
export function visibleEvent(raw: Json, source: Provider): Json | undefined {
  if (source === "codex") {
    const p = object(raw.payload);
    if (raw.type === "event_msg" && ["token_count", "task_started", "task_complete", "task_completed", "turn_aborted", "task_aborted", "error"].includes(String(p.type))) return raw;
    if (raw.type !== "response_item") return undefined;
    if (p.type === "message" && ["user", "assistant"].includes(String(p.role)) && p.channel !== "analysis") return raw;
    if (["function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"].includes(String(p.type))) return raw;
  } else if (source === "claude") {
    if (raw.isMeta || raw.isSidechain || !["user", "assistant", "system"].includes(String(raw.type))) return undefined;
    const message = object(raw.message);
    // Keep indexes for historical images while removing thinking contents.
    if (typeof message.content === "string") return raw;
    if (Array.isArray(message.content)) return { ...raw, message: { ...message, content: objects(message.content).map(b =>
      ["text", "image", "tool_use", "tool_result"].includes(String(b.type)) ? b : { type: "redacted" }) } };
  } else {
    if (raw.agentId || raw.ephemeral || !["user.message", "assistant.message", "assistant.message_delta", "tool.execution_start", "tool.execution_complete", "assistant.turn_start", "assistant.turn_end", "session.idle", "abort", "session.error", "session.usage_info", "assistant.usage"].includes(String(raw.type))) return undefined;
    const data = object(raw.data);
    // Copilot includes optional reasoning beside the public message in some
    // versions. Export only the fields used by public text/tool/usage readers.
    const allowed = ["content", "source", "messageId", "deltaContent", "toolName", "toolCallId", "arguments", "result", "error", "aborted", "inputTokens", "outputTokens", "cacheReadTokens"];
    return { type: raw.type, timestamp: raw.timestamp, data: Object.fromEntries(Object.entries(data).filter(([key]) => allowed.includes(key))) };
  }
  return undefined;
}

/** Parse only the requested page; shared byte indexes make reopening and
 * backward pagination independent of the amount of already-read history. */
export class TranscriptReader {
  private revision?: string;
  private nextLine = 0;
  constructor(readonly file: string, readonly source: Provider, private readonly imageLine?: number) {}
  async read(before?: number, signal?: AbortSignal): Promise<{ entries: Entry[]; totalLines: number; startLine: number; hasMore: boolean; reset: boolean }> {
    return withTranscriptIndex(this.file, async (handle, index) => {
      const reset = this.revision !== index.revision;
      const end = Math.min(before ?? index.lines, index.lines);
      const lower = this.imageLine ?? (reset || before !== undefined ? 0 : this.nextLine);
      const entries: Entry[] = [];
      let bytes = 0, cursor = end;
      for await (const row of index.rows(handle, end, lower, signal)) {
        signal?.throwIfAborted();
        let entry: Entry | undefined;
        try {
          const raw = row.bytes && visibleEvent(object(JSON.parse(row.bytes.toString())), this.source);
          if (raw) entry = { line: row.line, raw: this.imageLine === row.line ? raw : chatFrame(raw, this.source) };
        } catch { /* A malformed old row cannot block the next readable page. */ }
        if (entry) {
          const size = Buffer.byteLength(JSON.stringify(entry));
          if (this.imageLine !== undefined || size < 2_097_152) {
            // Leave an entry that doesn't fit for the following history page.
            if (this.imageLine === undefined && bytes + size > 4_194_304) break;
            entries.push(entry); bytes += size;
          }
        }
        cursor = row.line;
        if (entries.length >= 200) break;
      }
      if (before === undefined) { this.revision = index.revision; this.nextLine = index.lines; }
      return { entries: entries.reverse(), totalLines: index.lines, startLine: cursor, hasMore: cursor > 0, reset };
    }, signal);
  }
}

export async function historicalImage(file: string, line: number, block: number, source: Provider): Promise<Buffer> {
  if (!Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(block) || block < 0 || block > 2000) throw new BridgeError(400, "Invalid image reference.");
  const reader = new TranscriptReader(file, source, line);
  const page = await reader.read(line + 1);
  const row = page.entries.find(e => e.line === line)?.raw;
  if (!row) throw new BridgeError(404, "This image is no longer in the transcript.");
  const content = objects(source === "codex" ? object(row.payload).content : object(row.message).content);
  const image = content[block];
  const encoded = image?.image_url || object(image?.source).data;
  const base64 = typeof encoded === "string" ? encoded.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "") : "";
  if (!base64 || !/^[A-Za-z0-9+/=\s]+$/.test(base64) || base64.length > 11_184_812) throw new BridgeError(404, "This image is not embedded in the transcript.");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > 8_388_608) throw new BridgeError(413, "This image is too large.");
  return bytes;
}

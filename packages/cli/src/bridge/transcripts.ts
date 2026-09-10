import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { glob } from "glob";
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
    if (raw.type === "event_msg" && ["token_count", "task_started", "task_complete", "task_completed", "turn_aborted", "error"].includes(String(p.type))) return raw;
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
    if (raw.agentId || raw.ephemeral || !["user.message", "assistant.message", "assistant.message_delta", "tool.execution_start", "tool.execution_complete", "assistant.turn_start", "assistant.turn_end", "session.idle", "session.error", "session.usage_info", "assistant.usage"].includes(String(raw.type))) return undefined;
    const data = object(raw.data);
    // Copilot includes optional reasoning beside the public message in some
    // versions. Export only the fields used by public text/tool/usage readers.
    const allowed = ["content", "source", "messageId", "deltaContent", "toolName", "toolCallId", "arguments", "result", "error", "aborted", "inputTokens", "outputTokens", "cacheReadTokens"];
    return { type: raw.type, timestamp: raw.timestamp, data: Object.fromEntries(Object.entries(data).filter(([key]) => allowed.includes(key))) };
  }
  return undefined;
}

/** Append-only reader with bounded retained history. Incomplete rows wait for the next read. */
export class TranscriptReader {
  private offset = 0;
  private inode?: number;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private skippingRow = false;
  private line = 0;
  private retained: Entry[] = [];
  private retainedBytes = 0;
  constructor(readonly file: string, readonly source: Provider, private readonly imageLine?: number) {}
  async read(before?: number): Promise<{ entries: Entry[]; totalLines: number; hasMore: boolean; reset: boolean }> {
    const handle = await open(this.file, "r");
    try {
      const meta = await handle.stat();
      if (!meta.isFile() || meta.size > 4_294_967_296) throw new BridgeError(413, "This conversation exceeds the transcript limit.");
      const reset = this.inode !== meta.ino || meta.size < this.offset;
      if (reset) { this.offset = 0; this.line = 0; this.pending = []; this.pendingBytes = 0; this.skippingRow = false; this.retained = []; this.retainedBytes = 0; }
      this.inode = meta.ino;
      const start = this.line;
      const buffer = Buffer.alloc(65_536);
      while (this.offset < meta.size && (before === undefined || this.line < before)) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, meta.size - this.offset), this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        let cursor = 0;
        while (cursor < bytesRead) {
          const newline = buffer.indexOf(10, cursor);
          const complete = newline >= cursor && newline < bytesRead;
          const end = complete ? newline : bytesRead;
          this.pendingBytes += end - cursor;
          if (this.pendingBytes > 67_108_864) { this.skippingRow = true; this.pending = []; }
          if (!this.skippingRow) this.pending.push(Buffer.from(buffer.subarray(cursor, end)));
          cursor = end + (complete ? 1 : 0);
          if (!complete) break;
          const line = this.line++;
          const row = this.skippingRow ? undefined : Buffer.concat(this.pending, this.pendingBytes);
          this.pending = []; this.pendingBytes = 0; this.skippingRow = false;
          if (!row || (before !== undefined && line >= before)) continue;
          try {
            const raw = visibleEvent(object(JSON.parse(row.toString())), this.source);
            if (raw) {
              const entry = { line, raw: this.imageLine === line ? raw : chatFrame(raw, this.source) };
              const size = Buffer.byteLength(JSON.stringify(entry));
              if (this.imageLine === line) { this.retained = [entry]; this.retainedBytes = size; }
              else if (this.imageLine === undefined && size < 2_097_152) {
                this.retained.push(entry); this.retainedBytes += size;
                while (this.retained.length > 200 || this.retainedBytes > 4_194_304) this.retainedBytes -= Buffer.byteLength(JSON.stringify(this.retained.shift()));
              }
            }
          } catch { /* A malformed or oversized old row cannot block newer messages. */ }
        }
      }
      const entries = reset || before !== undefined ? this.retained : this.retained.filter(e => e.line >= start);
      return { entries, totalLines: this.line, hasMore: (this.retained[0]?.line ?? 0) > 0, reset };
    } finally { await handle.close(); }
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

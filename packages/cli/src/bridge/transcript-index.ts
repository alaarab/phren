import { open, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { BridgeError } from "./protocol.js";

const BLOCK = 65_536;
const CHECKPOINT_BYTES = 524_288;
const MAX_ROW_BYTES = 67_108_864;
interface Position { line: number; offset: number }

/** A sparse byte/line index, shared by live readers, history pages, and images.
 * Indexing counts newlines without decoding JSON or retaining transcript text.
 * At the 4 GiB file limit, checkpoints occupy only a few hundred KiB. */
class TranscriptIndex {
  revision = randomUUID();
  lines = 0;
  private identity = "";
  private modified = 0;
  private scanned = 0;
  private complete = 0;
  private checkpoints: Position[] = [{ line: 0, offset: 0 }];
  private tail: Promise<unknown> = Promise.resolve();

  constructor(readonly file: string) {}

  use<T>(read: (handle: FileHandle, index: TranscriptIndex) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const task = this.tail.then(async () => {
      signal?.throwIfAborted();
      const handle = await open(this.file, "r");
      try { await this.refresh(handle, signal); return await read(handle, this); }
      finally { await handle.close(); }
    });
    this.tail = task.catch(() => {});
    return task;
  }

  private async refresh(handle: FileHandle, signal?: AbortSignal) {
    const meta = await handle.stat();
    if (!meta.isFile() || meta.size > 4_294_967_296) throw new BridgeError(413, "This conversation exceeds the transcript limit.");
    const identity = `${meta.dev}:${meta.ino}`;
    if (identity !== this.identity || meta.size < this.scanned || (meta.size === this.scanned && meta.mtimeMs !== this.modified)) {
      this.identity = identity; this.revision = randomUUID(); this.scanned = 0; this.complete = 0; this.lines = 0;
      this.checkpoints = [{ line: 0, offset: 0 }];
    }
    this.modified = meta.mtimeMs;
    const buffer = Buffer.alloc(BLOCK);
    while (this.scanned < meta.size) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, Math.min(BLOCK, meta.size - this.scanned), this.scanned);
      if (!bytesRead) throw new BridgeError(409, "The transcript changed while loading. Refresh the conversation.");
      for (let newline = buffer.indexOf(10); newline >= 0 && newline < bytesRead; newline = buffer.indexOf(10, newline + 1)) {
        this.lines++; this.complete = this.scanned + newline + 1;
        if (this.complete - this.checkpoints.at(-1)!.offset >= CHECKPOINT_BYTES) {
          this.checkpoints.push({ line: this.lines, offset: this.complete });
        }
      }
      this.scanned += bytesRead;
    }
  }

  private async position(handle: FileHandle, line: number, signal?: AbortSignal): Promise<number> {
    if (line === this.lines) return this.complete;
    let low = 0, high = this.checkpoints.length;
    while (low + 1 < high) {
      const mid = Math.floor((low + high) / 2);
      if (this.checkpoints[mid].line <= line) low = mid; else high = mid;
    }
    let { offset, line: current } = this.checkpoints[low];
    const buffer = Buffer.alloc(BLOCK);
    while (current < line) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, Math.min(BLOCK, this.complete - offset), offset);
      if (!bytesRead) throw new BridgeError(409, "The transcript changed while loading. Refresh the conversation.");
      for (let newline = buffer.indexOf(10); newline >= 0 && newline < bytesRead; newline = buffer.indexOf(10, newline + 1)) {
        if (++current === line) return offset + newline + 1;
      }
      offset += bytesRead;
    }
    return offset;
  }

  /** Read newest first and stop as soon as the caller has a page. Large rows
   * are skipped with bounded memory while keeping absolute line identities. */
  async *rows(handle: FileHandle, before: number, after: number, signal?: AbortSignal): AsyncGenerator<{ line: number; bytes?: Buffer }> {
    const endLine = Math.min(before, this.lines);
    if (endLine <= after) return;
    let cursor = await this.position(handle, endLine, signal) - 1;
    const lower = await this.position(handle, after, signal);
    let line = endLine - 1, size = 0;
    let parts: Buffer[] = [];
    const buffer = Buffer.alloc(BLOCK);
    while (cursor > lower) {
      signal?.throwIfAborted();
      const start = Math.max(lower, cursor - BLOCK), length = cursor - start;
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      if (bytesRead !== length) throw new BridgeError(409, "The transcript changed while loading. Refresh the conversation.");
      let end = bytesRead;
      while (end > 0) {
        const newline = buffer.lastIndexOf(10, end - 1), begin = newline + 1;
        size += end - begin;
        if (size <= MAX_ROW_BYTES) parts.push(Buffer.from(buffer.subarray(begin, end))); else parts = [];
        if (newline < 0) break;
        yield { line: line--, bytes: size <= MAX_ROW_BYTES ? Buffer.concat(parts.reverse(), size) : undefined };
        parts = []; size = 0; end = newline;
      }
      cursor = start;
    }
    if (line >= after) yield { line, bytes: size <= MAX_ROW_BYTES ? Buffer.concat(parts.reverse(), size) : undefined };
  }
}

// No on-disk transcript copies. Eviction affects speed only; an evicted reader
// receives a fresh revision/backlog if it is subsequently reopened.
const indexes = new Map<string, TranscriptIndex>();
export function withTranscriptIndex<T>(file: string, read: (handle: FileHandle, index: TranscriptIndex) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const index = indexes.get(file) ?? new TranscriptIndex(file);
  indexes.delete(file); indexes.set(file, index);
  while (indexes.size > 32) indexes.delete(indexes.keys().next().value!);
  return index.use(read, signal);
}

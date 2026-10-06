/**
 * Tail the live lookup-events log.
 *
 * `.runtime/lookup-events.jsonl` is append-only: every memory phren lands on
 * during a search, and every memory a hook injects, is written as one JSON
 * line. Two hosts follow it live — the web UI's Activity stream and the
 * shell's graph watch mode — so the read-only tailing logic lives here once.
 *
 * Reads only the bytes appended since the last poll, which is far more robust
 * across platforms than fs.watch, and survives the file being rotated or
 * truncated underneath it.
 */

import * as fs from "fs";
import type { LookupEvent } from "../governance/activity.js";

export interface LookupTailOptions {
  /**
   * Start at the current end of the file so only events appended after
   * construction are delivered. Callers wanting history use
   * `readRecentLookups` for the backfill. Default true.
   */
  fromEnd?: boolean;
}

export class LookupTail {
  private offset = 0;
  private carry = "";

  constructor(private readonly logPath: string, opts: LookupTailOptions = {}) {
    if (opts.fromEnd !== false) {
      try {
        this.offset = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
      } catch {
        this.offset = 0;
      }
    }
  }

  /**
   * Raw JSON lines appended since the last poll, each already validated as
   * parseable. Never throws: a logging or read failure yields nothing rather
   * than breaking the caller's render or stream.
   */
  pollLines(): string[] {
    let size: number;
    try {
      if (!fs.existsSync(this.logPath)) return [];
      size = fs.statSync(this.logPath).size;
    } catch {
      return [];
    }
    if (size < this.offset) {
      // Rotated or truncated: start over rather than read garbage.
      this.offset = 0;
      this.carry = "";
    }
    if (size <= this.offset) return [];

    let chunk = "";
    try {
      const fd = fs.openSync(this.logPath, "r");
      try {
        const buf = Buffer.alloc(size - this.offset);
        fs.readSync(fd, buf, 0, buf.length, this.offset);
        chunk = buf.toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return [];
    }
    this.offset = size;

    const lines = (this.carry + chunk).split("\n");
    // A trailing partial line is kept until the writer finishes it.
    this.carry = lines.pop() ?? "";
    const out: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        JSON.parse(trimmed);
        out.push(trimmed);
      } catch {
        // Skip malformed lines rather than failing the whole poll.
      }
    }
    return out;
  }

  /** Parsed events appended since the last poll. */
  poll(): LookupEvent[] {
    const out: LookupEvent[] = [];
    for (const line of this.pollLines()) {
      try {
        const parsed = JSON.parse(line) as LookupEvent;
        if (parsed && typeof parsed.at === "string") out.push(parsed);
      } catch {
        // Already validated in pollLines; defensive only.
      }
    }
    return out;
  }
}

// Memory-trace: an opt-in event stream that records when phren accesses
// memories so the web-ui can animate the mascot moving across the graph
// in real time. Off by default — enable via PHREN_FEATURE_MEMORY_TRACE=1.

import * as fs from "fs";
import { runtimeFile } from "./phren-paths.js";
import { isFeatureEnabled, errorMessage } from "./utils.js";
import { logger } from "./logger.js";

export const MEMORY_TRACE_FEATURE_FLAG = "PHREN_FEATURE_MEMORY_TRACE";
export const MEMORY_TRACE_FILENAME = "memory-trace.jsonl";

// Cap the on-disk log so it never grows unbounded. The web-ui only consumes
// new lines once it's connected; old entries are just history.
const MAX_TRACE_ENTRIES = 200;
// Rotate when the file size crosses this threshold (≈ 200 KiB) so we don't
// re-read+rewrite on every write.
const ROTATE_BYTES_THRESHOLD = 200 * 1024;

export interface MemoryTraceTarget {
  project: string;
  filename: string;
  type: string;
  path?: string;
  snippet?: string;
}

export interface MemoryTraceEvent {
  ts: number;
  tool: string;
  query?: string;
  results: MemoryTraceTarget[];
}

export function isMemoryTraceEnabled(): boolean {
  return isFeatureEnabled(MEMORY_TRACE_FEATURE_FLAG, false);
}

export function memoryTraceFile(phrenPath: string): string {
  return runtimeFile(phrenPath, MEMORY_TRACE_FILENAME);
}

export function recordMemoryTrace(phrenPath: string, event: MemoryTraceEvent): void {
  if (!isMemoryTraceEnabled()) return;
  if (!event.results || event.results.length === 0) return;
  try {
    const file = memoryTraceFile(phrenPath);
    const line = JSON.stringify(event) + "\n";
    fs.appendFileSync(file, line);
    rotateIfNeeded(file);
  } catch (err: unknown) {
    logger.debug("memory-trace", `record: ${errorMessage(err)}`);
  }
}

function rotateIfNeeded(file: string): void {
  try {
    const stat = fs.statSync(file);
    if (stat.size < ROTATE_BYTES_THRESHOLD) return;
    const content = fs.readFileSync(file, "utf8");
    const lines = content.split("\n").filter(Boolean);
    if (lines.length <= MAX_TRACE_ENTRIES) return;
    const trimmed = lines.slice(-MAX_TRACE_ENTRIES).join("\n") + "\n";
    fs.writeFileSync(file, trimmed);
  } catch (err: unknown) {
    logger.debug("memory-trace", `rotate: ${errorMessage(err)}`);
  }
}

export interface MemoryTraceTail {
  close: () => void;
}

// Tails the trace file from its current end, invoking `onLine` for each
// newly appended JSON line. Returns a handle that the caller must close.
export function tailMemoryTrace(
  phrenPath: string,
  onLine: (event: MemoryTraceEvent) => void,
): MemoryTraceTail {
  const file = memoryTraceFile(phrenPath);
  let position = 0;
  let buffer = "";
  let closed = false;

  try {
    if (fs.existsSync(file)) position = fs.statSync(file).size;
  } catch {
    position = 0;
  }

  const drain = () => {
    if (closed) return;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return;
    }
    // Truncated or rotated — restart from the beginning.
    if (stat.size < position) position = 0;
    if (stat.size === position) return;
    let fd: number | null = null;
    try {
      fd = fs.openSync(file, "r");
      const length = stat.size - position;
      const chunk = Buffer.alloc(length);
      fs.readSync(fd, chunk, 0, length, position);
      position = stat.size;
      buffer += chunk.toString("utf8");
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const raw of parts) {
        if (!raw.trim()) continue;
        try {
          const parsed = JSON.parse(raw) as MemoryTraceEvent;
          onLine(parsed);
        } catch (err: unknown) {
          logger.debug("memory-trace", `parse: ${errorMessage(err)}`);
        }
      }
    } catch (err: unknown) {
      logger.debug("memory-trace", `read: ${errorMessage(err)}`);
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* already closed */ }
      }
    }
  };

  let watcher: fs.FSWatcher | null = null;
  const tryWatch = () => {
    try {
      watcher = fs.watch(file, { persistent: false }, () => drain());
    } catch {
      watcher = null;
    }
  };
  if (fs.existsSync(file)) tryWatch();

  // Poll as a fallback (and to attach the watcher once the file appears).
  const poll = setInterval(() => {
    if (closed) return;
    if (!watcher && fs.existsSync(file)) tryWatch();
    drain();
  }, 500);

  return {
    close: () => {
      closed = true;
      clearInterval(poll);
      if (watcher) {
        try { watcher.close(); } catch { /* already closed */ }
        watcher = null;
      }
    },
  };
}

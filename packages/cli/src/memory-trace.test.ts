import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import {
  MEMORY_TRACE_FEATURE_FLAG,
  isMemoryTraceEnabled,
  memoryTraceFile,
  recordMemoryTrace,
  tailMemoryTrace,
  type MemoryTraceEvent,
} from "./memory-trace.js";
import { makeTempDir } from "./test-helpers.js";

const ORIGINAL_FLAG = process.env[MEMORY_TRACE_FEATURE_FLAG];

function restoreFlag(): void {
  if (ORIGINAL_FLAG === undefined) delete process.env[MEMORY_TRACE_FEATURE_FLAG];
  else process.env[MEMORY_TRACE_FEATURE_FLAG] = ORIGINAL_FLAG;
}

describe("memory-trace", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => {
    tmp = makeTempDir("phren-memory-trace-");
  });

  afterEach(() => {
    restoreFlag();
    tmp.cleanup();
  });

  it("is disabled by default", () => {
    delete process.env[MEMORY_TRACE_FEATURE_FLAG];
    expect(isMemoryTraceEnabled()).toBe(false);
  });

  it("does not write the trace file when flag is off", () => {
    delete process.env[MEMORY_TRACE_FEATURE_FLAG];
    recordMemoryTrace(tmp.path, {
      ts: Date.now(),
      tool: "search_knowledge",
      query: "auth",
      results: [{ project: "demo", filename: "FINDINGS.md", type: "findings" }],
    });
    expect(fs.existsSync(memoryTraceFile(tmp.path))).toBe(false);
  });

  it("appends a JSON line per call when enabled", () => {
    process.env[MEMORY_TRACE_FEATURE_FLAG] = "1";
    recordMemoryTrace(tmp.path, {
      ts: 1000,
      tool: "search_knowledge",
      query: "auth",
      results: [{ project: "demo", filename: "FINDINGS.md", type: "findings" }],
    });
    recordMemoryTrace(tmp.path, {
      ts: 2000,
      tool: "search_knowledge",
      query: "ratelimit",
      results: [{ project: "demo", filename: "tasks.md", type: "task" }],
    });
    const lines = fs.readFileSync(memoryTraceFile(tmp.path), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first.tool).toBe("search_knowledge");
    expect(first.results[0].filename).toBe("FINDINGS.md");
  });

  it("skips events with no results", () => {
    process.env[MEMORY_TRACE_FEATURE_FLAG] = "1";
    recordMemoryTrace(tmp.path, {
      ts: 1000,
      tool: "search_knowledge",
      query: "nothing",
      results: [],
    });
    expect(fs.existsSync(memoryTraceFile(tmp.path))).toBe(false);
  });

  it("tails newly appended events", async () => {
    process.env[MEMORY_TRACE_FEATURE_FLAG] = "1";
    // Pre-create the file so the watcher attaches immediately.
    fs.writeFileSync(memoryTraceFile(tmp.path), "");

    const seen: MemoryTraceEvent[] = [];
    const tail = tailMemoryTrace(tmp.path, (ev) => seen.push(ev));

    recordMemoryTrace(tmp.path, {
      ts: 5000,
      tool: "search_knowledge",
      query: "live",
      results: [{ project: "demo", filename: "FINDINGS.md", type: "findings" }],
    });

    // Wait for the polling tailer to pick up the change.
    await new Promise((resolve) => setTimeout(resolve, 800));
    tail.close();

    expect(seen).toHaveLength(1);
    expect(seen[0].query).toBe("live");
    expect(seen[0].results[0].project).toBe("demo");
  });
});

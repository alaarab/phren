import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, writeFile } from "../test-helpers.js";
import type { SelectedSnippet } from "../shared/retrieval.js";
import { trackSessionMetrics } from "./session-metrics.js";

interface JournalEntry {
  key: string;
  delta: { helpful?: number; repromptPenalty?: number; regressionPenalty?: number };
}

function snippet(key: string): SelectedSnippet {
  return {
    doc: { project: "proj", filename: `${key}.md`, type: "findings", content: "content", path: `/${key}.md` },
    snippet: "snippet",
    key,
  };
}

function readMetrics(dir: string): Record<string, {
  prompts: number;
  keys: Record<string, number>;
  lastChangedCount: number;
  lastKeys: string[];
  lastSeen?: string;
}> {
  return JSON.parse(fs.readFileSync(path.join(dir, ".runtime", "session-metrics.json"), "utf8"));
}

function readJournal(dir: string): JournalEntry[] {
  const file = path.join(dir, ".runtime", "scores.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as JournalEntry);
}

describe("trackSessionMetrics", () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ path: dir, cleanup } = makeTempDir("phren-session-metrics-"));
  });

  afterEach(() => {
    cleanup();
  });

  it("records the prompt, injected keys, relevance count and last-seen time", () => {
    trackSessionMetrics(dir, "session-1", [snippet("a"), snippet("b")]);

    const entry = readMetrics(dir)["session-1"];
    expect(entry.prompts).toBe(1);
    expect(entry.keys).toEqual({ a: 1, b: 1 });
    expect(entry.lastKeys).toEqual(["a", "b"]);
    expect(entry.lastChangedCount).toBe(2);
    expect(Number.isNaN(Date.parse(entry.lastSeen ?? ""))).toBe(false);
  });

  it("records a reprompt when the same snippet is injected again, but not a helpful mark for a stable set", () => {
    trackSessionMetrics(dir, "session-1", [snippet("a")]);
    trackSessionMetrics(dir, "session-1", [snippet("a")]);

    expect(readMetrics(dir)["session-1"].keys.a).toBe(2);
    const journal = readJournal(dir).filter((entry) => entry.key === "a");
    expect(journal.filter((entry) => entry.delta.repromptPenalty === 1)).toHaveLength(1);
    expect(journal.some((entry) => entry.delta.helpful === 1)).toBe(false);
  });

  it("marks the previously injected snippets helpful when the relevant set grows", () => {
    trackSessionMetrics(dir, "session-1", [snippet("a")]);
    trackSessionMetrics(dir, "session-1", [snippet("a"), snippet("b")]);

    const helpful = readJournal(dir).filter((entry) => entry.key === "a" && entry.delta.helpful === 1);
    expect(helpful).toHaveLength(1);
    expect(readMetrics(dir)["session-1"].lastChangedCount).toBe(2);
  });

  it("counts only injected snippets whose quality multiplier is above the relevance threshold", () => {
    writeFile(
      path.join(dir, ".runtime", "memory-scores.json"),
      JSON.stringify({
        schemaVersion: 1,
        entries: {
          bad: { impressions: 0, helpful: 0, repromptPenalty: 0, regressionPenalty: 3, lastUsedAt: "" },
        },
      }),
    );

    trackSessionMetrics(dir, "session-1", [snippet("good"), snippet("bad")]);

    const entry = readMetrics(dir)["session-1"];
    expect(entry.lastKeys).toEqual(["good", "bad"]);
    expect(entry.lastChangedCount).toBe(1);
  });

  it("keeps each session's prompts and keys separate", () => {
    trackSessionMetrics(dir, "session-a", [snippet("a")]);
    trackSessionMetrics(dir, "session-b", [snippet("b")]);
    trackSessionMetrics(dir, "session-b", [snippet("b")]);

    const metrics = readMetrics(dir);
    expect(metrics["session-a"]).toMatchObject({ prompts: 1, keys: { a: 1 } });
    expect(metrics["session-b"]).toMatchObject({ prompts: 2, keys: { b: 2 } });
    expect(metrics["session-b"].keys.a).toBeUndefined();
  });

  it("counts a prompt even when no snippets were injected", () => {
    trackSessionMetrics(dir, "session-1", []);

    expect(readMetrics(dir)["session-1"]).toMatchObject({
      prompts: 1,
      keys: {},
      lastChangedCount: 0,
      lastKeys: [],
    });
  });

  it("replaces an unreadable metrics file instead of failing", () => {
    writeFile(path.join(dir, ".runtime", "session-metrics.json"), "not json");

    trackSessionMetrics(dir, "session-1", [snippet("a")]);

    const metrics = readMetrics(dir);
    expect(Object.keys(metrics)).toEqual(["session-1"]);
    expect(metrics["session-1"]).toMatchObject({ prompts: 1, keys: { a: 1 } });
  });
});

import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../test-helpers.js";
import { readRecallTrace, recallTraceFile, recordRecallTrace, skippedTraceEntry, traceEntryFromResult } from "./trace.js";
import type { RecallResult } from "./types.js";

describe("recall trace", () => {
  let tmp: { path: string; cleanup: () => void };
  beforeEach(() => { tmp = makeTempDir("recall-trace-"); });
  afterEach(() => tmp.cleanup());

  const doc = (file: string) => ({ project: "zeta", filename: path.basename(file), type: "reference", path: path.join(tmp.path, file) });
  const result = (over: Partial<RecallResult> = {}): RecallResult => ({
    keywords: ["deploy", "zeta"], intent: "build", detectedProject: "zeta", abstained: null, trustSurvivors: 2,
    candidates: [{ ...doc("zeta/reference/topics/deploy.md"), score: 3.21 }, { ...doc("zeta/FINDINGS.md"), score: 1.5 }],
    floor: [
      { ...doc("zeta/reference/topics/deploy.md"), passed: true, reason: "pass", distinct: 2, rarity: 1.23456, overlap: 0.4, matched: ["deploy", "zeta"] },
      { ...doc("zeta/FINDINGS.md"), passed: false, reason: "low-rarity", distinct: 2, rarity: 0.31, overlap: 0.2, matched: ["give", "think"] },
    ],
    selected: [{ ...doc("zeta/reference/topics/deploy.md"), key: "zeta/deploy.md:abc", snippet: "- deploy with scripts/deploy.sh" }],
    selectedRows: [], usedTokens: 120, tokenBudget: 550, stageMs: { searchMs: 5, trustMs: 1, rankMs: 2, selectMs: 1 },
    ...over,
  });

  it("records what matched, what was dropped and why, with store-relative paths", () => {
    const res = result();
    recordRecallTrace(tmp.path, traceEntryFromResult(tmp.path, "how do I   deploy zeta?", res, res.selected, { session: "s1", indexMs: 40 }));
    const [entry] = readRecallTrace(tmp.path);
    expect(entry).toMatchObject({
      session: "s1", project: "zeta", prompt: "how do I deploy zeta?", keywords: ["deploy", "zeta"], abstained: null, candidates: 2,
      injected: [{ path: "zeta/reference/topics/deploy.md", key: "zeta/deploy.md:abc", type: "reference" }],
      tokens: 120, budget: 550, ms: { index: 40, search: 5, trust: 1, rank: 2, select: 1 },
    });
    expect(entry.floor?.[0]).toEqual({ path: "zeta/reference/topics/deploy.md", passed: true, reason: "pass", distinct: 2, rarity: 1.235, overlap: 0.4, matched: ["deploy", "zeta"] });
    expect(entry.floor?.[1]).toMatchObject({ passed: false, reason: "low-rarity", matched: ["give", "think"] });
  });

  it("records an abstention and a skipped prompt as their own lines", () => {
    const res = result({ abstained: "below-floor", selected: [] });
    recordRecallTrace(tmp.path, traceEntryFromResult(tmp.path, "give me the honest take", res, []));
    recordRecallTrace(tmp.path, skippedTraceEntry('<agent-message from="w1">done</agent-message>', "machine-prompt", null, "s2"));
    const entries = readRecallTrace(tmp.path);
    expect(entries.map((e) => e.abstained ?? e.skipped)).toEqual(["below-floor", "machine-prompt"]);
    expect(entries[0].injected).toEqual([]);
    expect(entries[1]).not.toHaveProperty("keywords");
  });

  it("keeps the prompt short and survives a torn line", () => {
    recordRecallTrace(tmp.path, skippedTraceEntry("x".repeat(500), "no-keywords", null));
    fs.appendFileSync(recallTraceFile(tmp.path), "{\"at\":\n");
    recordRecallTrace(tmp.path, skippedTraceEntry("second", "machine-prompt", null));
    const entries = readRecallTrace(tmp.path);
    expect(entries).toHaveLength(2);
    expect(entries[0].prompt).toHaveLength(160);
  });
});

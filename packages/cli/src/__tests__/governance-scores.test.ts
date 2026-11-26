import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, initTestPhrenRoot } from "../test-helpers.js";
import {
  entryScoreKey,
  recordInjection,
  recordFeedback,
  flushEntryScores,
  getQualityMultiplier,
} from "../governance/scores.js";

let tmp: { path: string; cleanup: () => void };
let phrenPath: string;

beforeEach(() => {
  tmp = makeTempDir("gov-scores-test-");
  phrenPath = tmp.path;
  initTestPhrenRoot(phrenPath);
  // Ensure .runtime dir exists for journal/log files
  fs.mkdirSync(path.join(phrenPath, ".runtime"), { recursive: true });
});

afterEach(() => {
  tmp.cleanup();
});

// ── entryScoreKey ──────────────────────────────────────────────────────────

describe("entryScoreKey", () => {
  it("produces deterministic keys", () => {
    const a = entryScoreKey("proj", "FINDINGS.md", "some snippet");
    const b = entryScoreKey("proj", "FINDINGS.md", "some snippet");
    expect(a).toBe(b);
  });

  it.each([
    ["project", ["proj-a", "FINDINGS.md", "snippet"], ["proj-b", "FINDINGS.md", "snippet"]],
    ["filename", ["proj", "FINDINGS.md", "snippet"], ["proj", "TRUTHS.md", "snippet"]],
    ["snippet content", ["proj", "FINDINGS.md", "alpha"], ["proj", "FINDINGS.md", "beta"]],
  ] as const)("differentiates by %s", (_field, a, b) => {
    expect(entryScoreKey(...a)).not.toBe(entryScoreKey(...b));
  });

  it("truncates long snippets to 200 chars for hashing", () => {
    const longA = "x".repeat(300);
    const longB = "x".repeat(200) + "y".repeat(100);
    // Both share the same first 200 chars, so keys should match
    const a = entryScoreKey("proj", "f.md", longA);
    const b = entryScoreKey("proj", "f.md", longB);
    expect(a).toBe(b);
  });

  it("key format is project/filename:hash", () => {
    const key = entryScoreKey("myproj", "FINDINGS.md", "test");
    expect(key).toMatch(/^myproj\/FINDINGS\.md:[a-f0-9]{12}$/);
  });
});

// ── recordInjection ────────────────────────────────────────────────────────

describe("recordInjection", () => {
  it("creates usage log and score journal entries", () => {
    const key = entryScoreKey("proj", "FINDINGS.md", "test snippet");
    recordInjection(phrenPath, key, "sess-1");

    // Usage log should exist with an inject entry
    const logFile = path.join(phrenPath, ".runtime", "memory-usage.log");
    expect(fs.existsSync(logFile)).toBe(true);
    const logContent = fs.readFileSync(logFile, "utf8");
    expect(logContent).toContain("inject");
    expect(logContent).toContain(key);

    // Journal should have an impressions entry
    const journalFile = path.join(phrenPath, ".runtime", "scores.jsonl");
    expect(fs.existsSync(journalFile)).toBe(true);
    const journalContent = fs.readFileSync(journalFile, "utf8");
    const entry = JSON.parse(journalContent.trim().split("\n")[0]);
    expect(entry.key).toBe(key);
    expect(entry.delta.impressions).toBe(1);
  });
});

// ── recordFeedback ─────────────────────────────────────────────────────────

describe("recordFeedback", () => {
  // Injected headers label the key `fb:<key>`. An agent that copies that token
  // whole must score the same entry as one that strips the prefix — otherwise
  // the call returns ok:true and writes a key no entryScoreKey can produce,
  // which is the silent no-op that printing the key was meant to end.
  it("scores the same entry whether or not the fb: prefix is included", () => {
    const key = entryScoreKey("proj", "FINDINGS.md", "prefixed snippet");
    recordFeedback(phrenPath, `fb:${key}`, "helpful");

    const journalFile = path.join(phrenPath, ".runtime", "scores.jsonl");
    const entry = JSON.parse(fs.readFileSync(journalFile, "utf8").trim().split("\n").pop()!);
    expect(entry.key).toBe(key);
    expect(entry.key.startsWith("fb:")).toBe(false);
    expect(entry.delta.helpful).toBe(1);
  });

  it("leaves a bare key untouched", () => {
    const key = entryScoreKey("proj", "FINDINGS.md", "bare snippet");
    recordFeedback(phrenPath, key, "helpful");

    const journalFile = path.join(phrenPath, ".runtime", "scores.jsonl");
    const entry = JSON.parse(fs.readFileSync(journalFile, "utf8").trim().split("\n").pop()!);
    expect(entry.key).toBe(key);
  });

  it.each([
    ["helpful", "helpful", "explicitHelpful"],
    ["reprompt", "repromptPenalty", "explicitReprompt"],
    ["regression", "regressionPenalty", "explicitRegression"],
  ] as const)("distinguishes heuristic and explicit %s feedback in journal", (kind, field, explicitField) => {
    const key = entryScoreKey("proj", "FINDINGS.md", `${kind} snippet`);
    recordFeedback(phrenPath, key, kind);
    recordFeedback(phrenPath, key, kind, undefined, "explicit");

    const journalFile = path.join(phrenPath, ".runtime", "scores.jsonl");
    const lines = fs.readFileSync(journalFile, "utf8").trim().split("\n");
    expect(JSON.parse(lines[0]).delta).toEqual({ [field]: 1 });
    expect(JSON.parse(lines[1]).delta).toEqual({ [field]: 1, [explicitField]: 1 });
  });

  it("writes audit log entry", () => {
    const key = entryScoreKey("proj", "FINDINGS.md", "audited");
    recordFeedback(phrenPath, key, "helpful");

    const auditFile = path.join(phrenPath, ".runtime", "audit.log");
    expect(fs.existsSync(auditFile)).toBe(true);
    const auditContent = fs.readFileSync(auditFile, "utf8");
    expect(auditContent).toContain("memory_feedback");
    expect(auditContent).toContain("helpful");
  });
});

// ── flushEntryScores ───────────────────────────────────────────────────────

describe("flushEntryScores", () => {
  it("flushes journal entries into scores file", () => {
    const key = entryScoreKey("proj", "FINDINGS.md", "flush test");
    recordInjection(phrenPath, key);
    recordInjection(phrenPath, key);
    recordFeedback(phrenPath, key, "helpful");

    flushEntryScores(phrenPath);

    const scoresFile = path.join(phrenPath, ".runtime", "memory-scores.json");
    expect(fs.existsSync(scoresFile)).toBe(true);
    const data = JSON.parse(fs.readFileSync(scoresFile, "utf8"));
    expect(data.schemaVersion).toBe(1);
    expect(data.entries[key]).toBeDefined();
    expect(data.entries[key].impressions).toBe(2);
    expect(data.entries[key].helpful).toBe(1);
  });

  it("is a no-op when journal is empty", () => {
    flushEntryScores(phrenPath);
    const scoresFile = path.join(phrenPath, ".runtime", "memory-scores.json");
    // Should not create scores file if nothing to flush
    expect(fs.existsSync(scoresFile)).toBe(false);
  });

  it("aggregates multiple journal entries for the same key", () => {
    const key = entryScoreKey("proj", "FINDINGS.md", "agg test");
    recordFeedback(phrenPath, key, "helpful");
    recordFeedback(phrenPath, key, "helpful", undefined, "explicit");
    recordFeedback(phrenPath, key, "helpful", undefined, "explicit");
    recordFeedback(phrenPath, key, "reprompt", undefined, "explicit");
    recordFeedback(phrenPath, key, "regression", undefined, "explicit");

    flushEntryScores(phrenPath);

    const scoresFile = path.join(phrenPath, ".runtime", "memory-scores.json");
    const data = JSON.parse(fs.readFileSync(scoresFile, "utf8"));
    const entry = data.entries[key];
    expect(entry.helpful).toBe(3);
    expect(entry.repromptPenalty).toBe(1);
    expect(entry.regressionPenalty).toBe(1);
    expect(entry.explicitHelpful).toBe(2);
    expect(entry.explicitReprompt).toBe(1);
    expect(entry.explicitRegression).toBe(1);
  });

  it("clears journal after flush", () => {
    const key = entryScoreKey("proj", "FINDINGS.md", "clear test");
    recordInjection(phrenPath, key);
    flushEntryScores(phrenPath);

    const journalFile = path.join(phrenPath, ".runtime", "scores.jsonl");
    const content = fs.readFileSync(journalFile, "utf8").trim();
    expect(content).toBe("");
  });
});

// ── getQualityMultiplier ───────────────────────────────────────────────────

describe("getQualityMultiplier", () => {
  it("returns 1 for unknown keys", () => {
    const key = entryScoreKey("proj", "FINDINGS.md", "unknown");
    expect(getQualityMultiplier(phrenPath, key)).toBe(1);
  });

  it.each([
    ["helpful", 1.15],
    ["reprompt", 0.8],
    ["regression", 0.6],
  ] as const)("ranks explicit %s feedback before and after flushing", (feedback, expected) => {
    const key = entryScoreKey("proj", "FINDINGS.md", feedback);
    recordFeedback(phrenPath, key, feedback, undefined, "explicit");

    expect(getQualityMultiplier(phrenPath, key)).toBeCloseTo(expected);
    flushEntryScores(phrenPath);
    expect(getQualityMultiplier(phrenPath, key)).toBeCloseTo(expected);
  });

  it("clamps output between 0.2 and 1.5", () => {
    const goodKey = entryScoreKey("proj", "FINDINGS.md", "excellent");
    for (let i = 0; i < 50; i++) {
      recordFeedback(phrenPath, goodKey, "helpful", undefined, "explicit");
    }
    expect(getQualityMultiplier(phrenPath, goodKey)).toBe(1.5);

    const badKey = entryScoreKey("proj", "FINDINGS.md", "terrible");
    for (let i = 0; i < 50; i++) {
      recordFeedback(phrenPath, badKey, "regression", undefined, "explicit");
    }
    expect(getQualityMultiplier(phrenPath, badKey)).toBe(0.2);
  });

  it("keeps frequent recent injections and heuristic feedback neutral", () => {
    const key = entryScoreKey("proj", "FINDINGS.md", "frequent");
    for (let i = 0; i < 100; i++) {
      recordInjection(phrenPath, key);
      recordFeedback(phrenPath, key, "reprompt");
      recordFeedback(phrenPath, key, "helpful");
      recordFeedback(phrenPath, key, "regression");
    }

    expect(getQualityMultiplier(phrenPath, key)).toBe(1);
    flushEntryScores(phrenPath);
    expect(getQualityMultiplier(phrenPath, key)).toBe(1);
  });

  it.each([new Date().toISOString(), "2020-01-01T00:00:00.000Z"])("accepts legacy scores and journal lines dated %s without changing rank", (at) => {
    const key = entryScoreKey("proj", "FINDINGS.md", "legacy");
    const legacy = { impressions: 100, helpful: 20, repromptPenalty: 80, regressionPenalty: 10 };
    fs.writeFileSync(path.join(phrenPath, ".runtime", "memory-scores.json"), JSON.stringify({
      schemaVersion: 1,
      entries: { [key]: { ...legacy, lastUsedAt: at } },
    }));
    fs.writeFileSync(path.join(phrenPath, ".runtime", "scores.jsonl"), JSON.stringify({ key, delta: legacy, at }) + "\n");

    expect(getQualityMultiplier(phrenPath, key)).toBe(1);
    flushEntryScores(phrenPath);
    expect(getQualityMultiplier(phrenPath, key)).toBe(1);
    const scores = JSON.parse(fs.readFileSync(path.join(phrenPath, ".runtime", "memory-scores.json"), "utf8"));
    expect(scores.entries[key]).toMatchObject({
      impressions: 200, helpful: 40, repromptPenalty: 160, regressionPenalty: 20,
      explicitHelpful: 0, explicitReprompt: 0, explicitRegression: 0,
    });

    recordFeedback(phrenPath, key, "helpful", undefined, "explicit");
    flushEntryScores(phrenPath);
    expect(getQualityMultiplier(phrenPath, key)).toBeCloseTo(1.15);
  });

  it("reads from both flushed scores and pending journal", () => {
    const key = entryScoreKey("proj", "FINDINGS.md", "mixed");
    recordFeedback(phrenPath, key, "helpful", undefined, "explicit");
    flushEntryScores(phrenPath);

    // Add more to journal (not yet flushed)
    recordFeedback(phrenPath, key, "helpful", undefined, "explicit");

    expect(getQualityMultiplier(phrenPath, key)).toBeCloseTo(1.3);
    recordFeedback(phrenPath, key, "regression", undefined, "explicit");
    expect(getQualityMultiplier(phrenPath, key)).toBeCloseTo(0.9);
    flushEntryScores(phrenPath);
    expect(getQualityMultiplier(phrenPath, key)).toBeCloseTo(0.9);
  });
});

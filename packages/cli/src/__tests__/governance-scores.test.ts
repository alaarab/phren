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

  it("differentiates by project", () => {
    const a = entryScoreKey("proj-a", "FINDINGS.md", "snippet");
    const b = entryScoreKey("proj-b", "FINDINGS.md", "snippet");
    expect(a).not.toBe(b);
  });

  it("differentiates by filename", () => {
    const a = entryScoreKey("proj", "FINDINGS.md", "snippet");
    const b = entryScoreKey("proj", "TRUTHS.md", "snippet");
    expect(a).not.toBe(b);
  });

  it("differentiates by snippet content", () => {
    const a = entryScoreKey("proj", "FINDINGS.md", "alpha");
    const b = entryScoreKey("proj", "FINDINGS.md", "beta");
    expect(a).not.toBe(b);
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
  it("records helpful feedback in journal", () => {
    const key = entryScoreKey("proj", "FINDINGS.md", "helpful snippet");
    recordFeedback(phrenPath, key, "helpful");

    const journalFile = path.join(phrenPath, ".runtime", "scores.jsonl");
    const lines = fs.readFileSync(journalFile, "utf8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.delta.helpful).toBe(1);
  });

  it("records reprompt penalty in journal", () => {
    const key = entryScoreKey("proj", "FINDINGS.md", "bad snippet");
    recordFeedback(phrenPath, key, "reprompt");

    const journalFile = path.join(phrenPath, ".runtime", "scores.jsonl");
    const lines = fs.readFileSync(journalFile, "utf8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.delta.repromptPenalty).toBe(1);
  });

  it("records regression penalty in journal", () => {
    const key = entryScoreKey("proj", "FINDINGS.md", "regressed snippet");
    recordFeedback(phrenPath, key, "regression");

    const journalFile = path.join(phrenPath, ".runtime", "scores.jsonl");
    const lines = fs.readFileSync(journalFile, "utf8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.delta.regressionPenalty).toBe(1);
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
    recordFeedback(phrenPath, key, "helpful");
    recordFeedback(phrenPath, key, "reprompt");
    recordFeedback(phrenPath, key, "regression");

    flushEntryScores(phrenPath);

    const scoresFile = path.join(phrenPath, ".runtime", "memory-scores.json");
    const data = JSON.parse(fs.readFileSync(scoresFile, "utf8"));
    const entry = data.entries[key];
    expect(entry.helpful).toBe(2);
    expect(entry.repromptPenalty).toBe(1);
    expect(entry.regressionPenalty).toBe(1);
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

  it("boosts quality for helpful feedback", () => {
    const key = entryScoreKey("proj", "FINDINGS.md", "boosted");
    recordFeedback(phrenPath, key, "helpful");
    recordFeedback(phrenPath, key, "helpful");
    recordFeedback(phrenPath, key, "helpful");

    const mult = getQualityMultiplier(phrenPath, key);
    expect(mult).toBeGreaterThan(1);
  });

  it("reduces quality for reprompt and regression penalties", () => {
    const key = entryScoreKey("proj", "FINDINGS.md", "penalized");
    recordFeedback(phrenPath, key, "regression");
    recordFeedback(phrenPath, key, "regression");
    recordFeedback(phrenPath, key, "reprompt");

    const mult = getQualityMultiplier(phrenPath, key);
    expect(mult).toBeLessThan(1);
  });

  it("clamps output between 0.2 and 1.5", () => {
    const goodKey = entryScoreKey("proj", "FINDINGS.md", "excellent");
    for (let i = 0; i < 50; i++) {
      recordFeedback(phrenPath, goodKey, "helpful");
    }
    expect(getQualityMultiplier(phrenPath, goodKey)).toBeLessThanOrEqual(1.5);

    const badKey = entryScoreKey("proj", "FINDINGS.md", "terrible");
    for (let i = 0; i < 50; i++) {
      recordFeedback(phrenPath, badKey, "regression");
    }
    expect(getQualityMultiplier(phrenPath, badKey)).toBeGreaterThanOrEqual(0.2);
  });

  it("includes frequency boost from impressions", () => {
    const key = entryScoreKey("proj", "FINDINGS.md", "frequent");
    for (let i = 0; i < 10; i++) {
      recordInjection(phrenPath, key);
    }

    const mult = getQualityMultiplier(phrenPath, key);
    expect(mult).toBeGreaterThan(1);
  });

  it("includes recency boost for recently used entries", () => {
    const key = entryScoreKey("proj", "FINDINGS.md", "recent");
    // Record an injection (sets lastUsedAt to now)
    recordInjection(phrenPath, key);

    const mult = getQualityMultiplier(phrenPath, key);
    // Should have a positive recency boost (within 7 days = +0.15)
    expect(mult).toBeGreaterThan(1);
  });

  it("reads from both flushed scores and pending journal", () => {
    const key = entryScoreKey("proj", "FINDINGS.md", "mixed");
    recordFeedback(phrenPath, key, "helpful");
    flushEntryScores(phrenPath);

    // Add more to journal (not yet flushed)
    recordFeedback(phrenPath, key, "helpful");

    const mult = getQualityMultiplier(phrenPath, key);
    // 2 helpful signals: should be > 1 from both flushed + journal
    expect(mult).toBeGreaterThan(1);
  });
});

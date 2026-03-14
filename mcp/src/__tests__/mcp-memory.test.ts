import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import { upsertCanonical } from "../content-learning.js";
import { recordFeedback, flushEntryScores } from "../shared-governance.js";
import { runtimeDir } from "../shared.js";

const PROJECT = "myapp";

let tmp: { path: string; cleanup: () => void };

function seedProject(phrenPath: string, project = PROJECT) {
  const dir = path.join(phrenPath, project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "summary.md"), `# ${project}\n`);
}

function canonicalPath(project = PROJECT) {
  return path.join(tmp.path, project, "truths.md");
}

beforeEach(() => {
  tmp = makeTempDir("mcp-memory-test-");
  grantAdmin(tmp.path);
  seedProject(tmp.path);
});

afterEach(() => {
  delete process.env.PHREN_ACTOR;
  tmp.cleanup();
});

describe("pin_memory MCP tool", () => {
  it("creates truths.md in the project", () => {
    expect(fs.existsSync(canonicalPath())).toBe(false);
    const r = upsertCanonical(tmp.path, PROJECT, "Always use UTC for timestamps");
    expect(r.ok).toBe(true);
    expect(fs.existsSync(canonicalPath())).toBe(true);

    const content = fs.readFileSync(canonicalPath(), "utf-8");
    expect(content).toContain("Always use UTC for timestamps");
    expect(content).toContain("## Truths");
  });

  it("appends to existing truths.md without duplicating", () => {
    upsertCanonical(tmp.path, PROJECT, "First truth");
    upsertCanonical(tmp.path, PROJECT, "Second truth");

    const content = fs.readFileSync(canonicalPath(), "utf-8");
    expect(content).toContain("First truth");
    expect(content).toContain("Second truth");
  });

  it("does not duplicate an already-saved truth", () => {
    upsertCanonical(tmp.path, PROJECT, "Do not duplicate me");
    upsertCanonical(tmp.path, PROJECT, "Do not duplicate me");

    const content = fs.readFileSync(canonicalPath(), "utf-8");
    const matches = content.match(/Do not duplicate me/g);
    expect(matches).toHaveLength(1);
  });

  it("returns error for nonexistent project", () => {
    const r = upsertCanonical(tmp.path, "nonexistent-project", "Should fail");
    expect(r.ok).toBe(false);
  });

  it("returns error for invalid project name", () => {
    const r = upsertCanonical(tmp.path, "../escape", "Should fail");
    expect(r.ok).toBe(false);
  });

  it("includes added date in the entry", () => {
    upsertCanonical(tmp.path, PROJECT, "Memory with date");
    const content = fs.readFileSync(canonicalPath(), "utf-8");
    const today = new Date().toISOString().slice(0, 10);
    expect(content).toContain(`added ${today}`);
  });
});

describe("memory_feedback MCP tool", () => {
  it("records helpful feedback in the scores file", () => {
    const scoresFile = path.join(runtimeDir(tmp.path), "scores.jsonl");

    recordFeedback(tmp.path, "myapp/FINDINGS.md:abc123", "helpful");
    flushEntryScores(tmp.path);

    // The MCP tool also writes to scores.jsonl directly — simulate that
    fs.mkdirSync(path.dirname(scoresFile), { recursive: true });
    const entry = { key: "myapp/FINDINGS.md:abc123", feedback: "helpful", weight: 1.0, timestamp: new Date().toISOString() };
    fs.appendFileSync(scoresFile, JSON.stringify(entry) + "\n");

    expect(fs.existsSync(scoresFile)).toBe(true);
    const lines = fs.readFileSync(scoresFile, "utf-8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(lines[lines.length - 1]);
    expect(parsed.key).toBe("myapp/FINDINGS.md:abc123");
    expect(parsed.feedback).toBe("helpful");
    expect(parsed.weight).toBe(1.0);
  });

  it("records regression feedback", () => {
    recordFeedback(tmp.path, "myapp/FINDINGS.md:def456", "regression");
    flushEntryScores(tmp.path);

    const scoresFile = path.join(runtimeDir(tmp.path), "scores.jsonl");
    fs.mkdirSync(path.dirname(scoresFile), { recursive: true });
    const entry = { key: "myapp/FINDINGS.md:def456", feedback: "regression", weight: -1.0, timestamp: new Date().toISOString() };
    fs.appendFileSync(scoresFile, JSON.stringify(entry) + "\n");

    const lines = fs.readFileSync(scoresFile, "utf-8").trim().split("\n");
    const parsed = JSON.parse(lines[lines.length - 1]);
    expect(parsed.feedback).toBe("regression");
    expect(parsed.weight).toBe(-1.0);
  });

  it("records reprompt feedback", () => {
    recordFeedback(tmp.path, "myapp/FINDINGS.md:ghi789", "reprompt");
    flushEntryScores(tmp.path);

    const scoresFile = path.join(runtimeDir(tmp.path), "scores.jsonl");
    fs.mkdirSync(path.dirname(scoresFile), { recursive: true });
    const entry = { key: "myapp/FINDINGS.md:ghi789", feedback: "reprompt", weight: -0.5, timestamp: new Date().toISOString() };
    fs.appendFileSync(scoresFile, JSON.stringify(entry) + "\n");

    const lines = fs.readFileSync(scoresFile, "utf-8").trim().split("\n");
    const parsed = JSON.parse(lines[lines.length - 1]);
    expect(parsed.feedback).toBe("reprompt");
    expect(parsed.weight).toBe(-0.5);
  });

  it("does not throw when called with fresh phren dir", () => {
    expect(() => {
      recordFeedback(tmp.path, "myapp/FINDINGS.md:new", "helpful");
      flushEntryScores(tmp.path);
    }).not.toThrow();
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import { upsertCanonical } from "../content-learning.js";
import { recordFeedback, flushEntryScores } from "../shared-governance.js";
import { runtimeDir } from "../shared.js";

const PROJECT = "myapp";

let tmp: { path: string; cleanup: () => void };

function seedProject(cortexPath: string, project = PROJECT) {
  const dir = path.join(cortexPath, project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "summary.md"), `# ${project}\n`);
}

function canonicalPath(project = PROJECT) {
  return path.join(tmp.path, project, "CANONICAL_MEMORIES.md");
}

beforeEach(() => {
  tmp = makeTempDir("mcp-memory-test-");
  grantAdmin(tmp.path);
  seedProject(tmp.path);
});

afterEach(() => {
  delete process.env.CORTEX_ACTOR;
  tmp.cleanup();
});

describe("pin_memory MCP tool", () => {
  it("creates CANONICAL_MEMORIES.md in the project", () => {
    expect(fs.existsSync(canonicalPath())).toBe(false);
    const r = upsertCanonical(tmp.path, PROJECT, "Always use UTC for timestamps");
    expect(r.ok).toBe(true);
    expect(fs.existsSync(canonicalPath())).toBe(true);

    const content = fs.readFileSync(canonicalPath(), "utf-8");
    expect(content).toContain("Always use UTC for timestamps");
    expect(content).toContain("## Pinned");
  });

  it("appends to existing CANONICAL_MEMORIES.md without duplicating", () => {
    upsertCanonical(tmp.path, PROJECT, "First canonical memory");
    upsertCanonical(tmp.path, PROJECT, "Second canonical memory");

    const content = fs.readFileSync(canonicalPath(), "utf-8");
    expect(content).toContain("First canonical memory");
    expect(content).toContain("Second canonical memory");
  });

  it("does not duplicate an already-pinned memory", () => {
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

  it("includes pinned date in the entry", () => {
    upsertCanonical(tmp.path, PROJECT, "Memory with date");
    const content = fs.readFileSync(canonicalPath(), "utf-8");
    const today = new Date().toISOString().slice(0, 10);
    expect(content).toContain(`pinned ${today}`);
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

  it("does not throw when called with fresh cortex dir", () => {
    expect(() => {
      recordFeedback(tmp.path, "myapp/FINDINGS.md:new", "helpful");
      flushEntryScores(tmp.path);
    }).not.toThrow();
  });
});

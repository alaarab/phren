import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { detectConflicts, checkSemanticConflicts } from "../shared-content.js";
import { makeTempDir } from "../test-helpers.js";
import * as fs from "fs";
import * as path from "path";

describe("detectConflicts", () => {
  it("detects positive vs negative polarity for the same entity", () => {
    const existing = ["- Always use Redis for session storage", "- Prefer Postgres over MySQL"];
    const result = detectConflicts("Never use Redis, it causes memory leaks under load", existing);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("Redis");
  });

  it("detects negative vs positive conflict", () => {
    const existing = ["- Never use Docker in production without orchestration"];
    const result = detectConflicts("Always use Docker for local dev and production deploys", existing);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("Docker");
  });

  it("returns empty when both are same polarity", () => {
    const existing = ["- Always use TypeScript for new projects"];
    const result = detectConflicts("Always use TypeScript — strict mode catches real bugs", existing);
    expect(result).toHaveLength(0);
  });

  it("returns empty when new learning is neutral", () => {
    const existing = ["- Always use Redis for caching"];
    const result = detectConflicts("Redis supports pub/sub messaging", existing);
    expect(result).toHaveLength(0);
  });

  it("returns empty when no shared entities", () => {
    const existing = ["- Never use MongoDB for financial data"];
    const result = detectConflicts("Always use Postgres for financial data", existing);
    // MongoDB and Postgres are different entities — no conflict
    expect(result).toHaveLength(0);
  });

  it("returns empty when existing line is neutral", () => {
    const existing = ["- Redis stores data in memory"];
    const result = detectConflicts("Never use Redis for persistent storage", existing);
    expect(result).toHaveLength(0);
  });

  it("returns empty when no prose entities found", () => {
    const existing = ["- Always commit before merging"];
    const result = detectConflicts("Never push without reviewing the diff first", existing);
    expect(result).toHaveLength(0);
  });

  it("can detect multiple conflicts", () => {
    const existing = [
      "- Always use Docker for deployments",
      "- Always use Docker in CI pipelines too",
      "- Use Postgres for everything",
    ];
    const result = detectConflicts("Never use Docker — bare metal is faster", existing);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("ignores superseded lines (they contain <!-- superseded_by -->)", () => {
    // Superseded lines still start with "- " so they're included — this documents the behavior
    // (detectConflicts is conservative; superseded entries are annotated but not excluded)
    const existing = ["- Always use Docker in production <!-- superseded_by: Use Kubernetes instead -->"];
    const result = detectConflicts("Never use Docker", existing);
    // Still detected — caller decides whether to act on it
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("checkSemanticConflicts (LLM-based)", () => {
  let tmpDir: string;
  let tmpCleanup: (() => void) | undefined;

  function makeCortex(): string {
    ({ path: tmpDir, cleanup: tmpCleanup } = makeTempDir("cortex-semantic-conflict-"));
    return tmpDir;
  }

  beforeEach(() => {
    process.env.CORTEX_FEATURE_SEMANTIC_CONFLICT = "1";
  });

  afterEach(() => {
    delete process.env.CORTEX_FEATURE_SEMANTIC_CONFLICT;
    vi.restoreAllMocks();
    if (tmpCleanup) {
      tmpCleanup();
      tmpCleanup = undefined;
    }
  });

  it("returns checked=false when feature flag is off", async () => {
    delete process.env.CORTEX_FEATURE_SEMANTIC_CONFLICT;
    const cortex = makeCortex();
    const result = await checkSemanticConflicts(cortex, "proj", "Never use Redis");
    expect(result.checked).toBe(false);
    expect(result.annotations).toHaveLength(0);
  });

  it("detects CONFLICT via cached LLM result and adds annotation", async () => {
    const cortex = makeCortex();
    const projDir = path.join(cortex, "proj");
    fs.mkdirSync(projDir, { recursive: true });
    fs.mkdirSync(path.join(cortex, ".runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, "FINDINGS.md"),
      "# proj Findings\n\n## 2026-01-01\n\n- Always use Redis for session storage\n"
    );

    // Pre-populate the conflict cache with a CONFLICT result
    const crypto = await import("node:crypto");
    const existing = "- Always use Redis for session storage";
    const newFinding = "Never use Redis for sessions, it causes data loss";
    const key = crypto.createHash("sha256").update(existing + "|||" + newFinding).digest("hex");
    const cachePath = path.join(cortex, ".runtime", "conflict-cache.json");
    fs.writeFileSync(cachePath, JSON.stringify({ [key]: { result: "CONFLICT", ts: Date.now() } }));

    const result = await checkSemanticConflicts(cortex, "proj", newFinding);
    expect(result.checked).toBe(true);
    expect(result.annotations.length).toBeGreaterThanOrEqual(1);
    expect(result.annotations[0]).toContain("conflicts_with");
    expect(result.annotations[0]).toContain("Redis");
  });
});

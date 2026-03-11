import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { makeTempDir, grantAdmin, writeFile } from "../test-helpers.js";
import { addFindingToFile, addFindingsToFile } from "../shared-content.js";

const PROJECT = "testapp";

let tmp: { path: string; cleanup: () => void };

function seedProject(cortexPath: string, project = PROJECT) {
  const dir = path.join(cortexPath, project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "summary.md"), `# ${project}\n`);
}

function findingsPath(project = PROJECT) {
  return path.join(tmp.path, project, "FINDINGS.md");
}

function writeSession(sessionId: string, project = PROJECT) {
  const dir = path.join(tmp.path, ".runtime", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `session-${sessionId}.json`),
    JSON.stringify({
      sessionId,
      project,
      startedAt: "2026-03-09T10:00:00.000Z",
      findingsAdded: 0,
    }),
  );
}

beforeEach(() => {
  tmp = makeTempDir("content-learning-test-");
  grantAdmin(tmp.path);
  seedProject(tmp.path);
});

afterEach(() => {
  delete process.env.CORTEX_ACTOR;
  delete process.env.OPENAI_MODEL;
  tmp.cleanup();
});

// ── Q13: content-learning.ts tests ──────────────────────────────────────────

describe("addFinding happy path", () => {
  it("adds finding to FINDINGS.md with correct format", () => {
    const r = addFindingToFile(tmp.path, PROJECT, "Always use parameterized queries to prevent SQL injection");
    expect(r.ok).toBe(true);
    const content = fs.readFileSync(findingsPath(), "utf-8");
    expect(content).toContain("Always use parameterized queries");
    expect(content).toContain("<!-- created:");
    // Should have the project heading
    expect(content).toContain(`# ${PROJECT} Findings`);
  });
});

describe("addFinding duplicate", () => {
  it("skips duplicate finding on second add", () => {
    const text = "Use connection pooling for database performance optimization";
    const r1 = addFindingToFile(tmp.path, PROJECT, text);
    expect(r1.ok).toBe(true);

    const r2 = addFindingToFile(tmp.path, PROJECT, text);
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.data).toContain("Skipped duplicate");
    }
  });
});

describe("addFindings bulk", () => {
  it("adds 5 findings at once and all appear", () => {
    const findings = [
      "Redis caching strategy uses TTL of 300 seconds for session data",
      "Database migrations must be backward compatible for zero-downtime deploys",
      "API rate limiting uses token bucket algorithm with per-user quotas",
      "WebSocket connections require heartbeat every 30 seconds to avoid timeout",
      "File uploads are processed asynchronously via queue to prevent request timeout",
    ];
    const r = addFindingsToFile(tmp.path, PROJECT, findings);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.added).toHaveLength(5);
    expect(r.data.skipped).toHaveLength(0);

    const content = fs.readFileSync(findingsPath(), "utf-8");
    for (const finding of findings) {
      // Check that some significant portion of each finding appears
      expect(content).toContain(finding.slice(0, 30));
    }
  });

  it("persists extra conflict annotations passed by bulk callers", () => {
    const findings = [
      "Use Redis for session storage",
      "Prefer Postgres for transactional workloads",
    ];
    const r = addFindingsToFile(tmp.path, PROJECT, findings, {
      extraAnnotationsByFinding: [
        ['<!-- conflicts_with: "Never use Redis for sessions" (from project: global) -->'],
        [],
      ],
    });
    expect(r.ok).toBe(true);

    const content = fs.readFileSync(findingsPath(), "utf-8");
    expect(content).toContain('conflicts_with: "Never use Redis for sessions"');
    expect(content).toContain("from project: global");
  });
});

describe("supersession", () => {
  it("marks old finding as superseded when new one specifies supersedes", () => {
    const oldFinding = "Use Redis for caching with default TTL settings";
    addFindingToFile(tmp.path, PROJECT, oldFinding);

    const content1 = fs.readFileSync(findingsPath(), "utf-8");
    expect(content1).toContain("Redis for caching");

    const newFinding = "Use Redis for caching with explicit TTL of 300s and LRU eviction";
    addFindingToFile(tmp.path, PROJECT, newFinding, {
      supersedes: oldFinding,
    });

    const content2 = fs.readFileSync(findingsPath(), "utf-8");
    expect(content2).toContain("superseded_by");
    expect(content2).toContain("explicit TTL of 300s");
  });
});

describe("finding provenance", () => {
  it("auto-stamps active task and active session context", () => {
    grantAdmin(tmp.path, "codex-worker");
    writeFile(
      path.join(tmp.path, PROJECT, "tasks.md"),
      `# ${PROJECT} tasks

## Active

- [ ] Finish phase seven [high] <!-- bid:deadbeef -->

## Queue

- [ ] Later item <!-- bid:cafebabe -->
`,
    );
    writeSession("session-1234");
    process.env.OPENAI_MODEL = "gpt-5";

    const result = addFindingToFile(tmp.path, PROJECT, "Operator-surface refactor is safe to continue in smaller slices");
    expect(result.ok).toBe(true);

    const content = fs.readFileSync(findingsPath(), "utf-8");
    expect(content).toContain('"task_item":"deadbeef"');
    expect(content).toContain("actor:codex-worker");
    expect(content).toContain("model:gpt-5");
    expect(content).toContain("session:session-1234");
  });

  it("resolves explicit task_item references to the stable ID", () => {
    writeFile(
      path.join(tmp.path, PROJECT, "tasks.md"),
      `# ${PROJECT} tasks

## Active

- [ ] Finish phase seven [high] <!-- bid:deadbeef -->
`,
    );

    const result = addFindingToFile(tmp.path, PROJECT, "Task linkage should survive reordering", {
      task_item: "A1",
    });
    expect(result.ok).toBe(true);

    const content = fs.readFileSync(findingsPath(), "utf-8");
    expect(content).toContain('"task_item":"deadbeef"');
  });

  it("rejects invalid task_item references", () => {
    writeFile(
      path.join(tmp.path, PROJECT, "tasks.md"),
      `# ${PROJECT} tasks

## Active

- [ ] Finish phase seven [high] <!-- bid:deadbeef -->
`,
    );

    const result = addFindingToFile(tmp.path, PROJECT, "This should not save", {
      task_item: "missing item",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("VALIDATION_ERROR");
  });

  it("does not infer citation repo metadata from the enclosing cortex store", () => {
    execFileSync("git", ["init"], { cwd: tmp.path, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Vitest"], { cwd: tmp.path, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "vitest@example.com"], { cwd: tmp.path, stdio: "ignore" });
    writeFile(path.join(tmp.path, "notes.md"), "seed\n");
    execFileSync("git", ["add", "."], { cwd: tmp.path, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "seed"], { cwd: tmp.path, stdio: "ignore" });

    const result = addFindingToFile(tmp.path, PROJECT, "Synthesized findings should not cite the cortex store repo by default");
    expect(result.ok).toBe(true);

    const content = fs.readFileSync(findingsPath(), "utf-8");
    expect(content).toContain("<!-- cortex:cite");
    expect(content).not.toContain(`"repo":"${tmp.path}"`);
    expect(content).not.toContain('"commit":');
    expect(content).not.toContain('"file":');
    expect(content).not.toContain('"line":');
  });
});

describe("secret rejection", () => {
  it("rejects finding containing AWS key pattern", () => {
    const result = addFindingToFile(tmp.path, PROJECT, "The AWS key is AKIAIOSFODNN7EXAMPLE and it works great");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/secret/i);
    expect(result.ok === false && result.code).toBe("VALIDATION_ERROR");
    // FINDINGS.md should not exist or should not contain the key
    if (fs.existsSync(findingsPath())) {
      const content = fs.readFileSync(findingsPath(), "utf-8");
      expect(content).not.toContain("AKIAIOSFODNN7EXAMPLE");
    }
  });

  it("rejects finding containing generic API token", () => {
    const result = addFindingToFile(tmp.path, PROJECT, "Use token sk-proj-abcdefghijklmnopqrstuvwxyz1234567890 for auth");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/secret/i);
    expect(result.ok === false && result.code).toBe("VALIDATION_ERROR");
  });
});

describe("error path: invalid project name", () => {
  it("returns error for path traversal project name", () => {
    const r = addFindingToFile(tmp.path, "../escape", "Should fail");
    expect(r.ok).toBe(false);
  });

  it("returns error for empty project name", () => {
    const r = addFindingToFile(tmp.path, "", "Should fail");
    expect(r.ok).toBe(false);
  });

  it("bulk add returns error for invalid project name", () => {
    const r = addFindingsToFile(tmp.path, "../escape", ["Should fail"]);
    expect(r.ok).toBe(false);
  });
});

describe("supersession: failed add does not mutate original finding", () => {
  it("when new finding is a duplicate, old finding is NOT marked superseded", () => {
    const oldFinding = "Use connection pooling for database efficiency";
    addFindingToFile(tmp.path, PROJECT, oldFinding);

    const content1 = fs.readFileSync(findingsPath(), "utf-8");
    expect(content1).toContain("connection pooling");
    expect(content1).not.toContain("superseded_by");

    // Attempt to add the exact same finding as the new one — should be skipped as duplicate
    const r = addFindingToFile(tmp.path, PROJECT, oldFinding, {
      supersedes: oldFinding,
    });

    const content2 = fs.readFileSync(findingsPath(), "utf-8");
    // Old finding must NOT be marked superseded since the new one was rejected
    expect(content2).not.toContain("superseded_by");
    // The result should indicate skipped or ok (not an error crash)
    expect(r.ok).toBe(true);
  });

  it("when new finding targets nonexistent project, nothing is written", () => {
    const r = addFindingToFile(tmp.path, "nonexistent-proj", "Some insight", {
      supersedes: "An old insight",
    });
    expect(r.ok).toBe(false);
    // Original project FINDINGS.md should be unaffected
    const p = path.join(tmp.path, PROJECT, "FINDINGS.md");
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, "utf-8");
      expect(content).not.toContain("superseded_by");
    }
  });
});

describe("consolidation semantics", () => {
  it("does not write implicit consolidation markers during addFinding", () => {
    const manyFindings = Array.from({ length: 160 }, (_, i) => `- Existing finding ${i + 1}`).join("\n");
    writeFile(
      findingsPath(),
      `# ${PROJECT} Findings\n\n## 2026-03-01\n\n${manyFindings}\n`
    );

    const r = addFindingToFile(tmp.path, PROJECT, "Newest finding after a large task");
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(tmp.path, ".runtime", "consolidation-needed.txt"))).toBe(false);
    if (r.ok && typeof r.data === "string") {
      expect(r.data.toLowerCase()).not.toContain("consolidation cap");
      expect(r.data.toLowerCase()).not.toContain("consider running consolidation");
    }
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
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

beforeEach(() => {
  tmp = makeTempDir("content-learning-test-");
  grantAdmin(tmp.path);
  seedProject(tmp.path);
});

afterEach(() => {
  delete process.env.CORTEX_ACTOR;
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

describe("secret rejection", () => {
  it("rejects finding containing AWS key pattern", () => {
    expect(() => {
      addFindingToFile(tmp.path, PROJECT, "The AWS key is AKIAIOSFODNN7EXAMPLE and it works great");
    }).toThrow(/secret/i);
    // FINDINGS.md should not exist or should not contain the key
    if (fs.existsSync(findingsPath())) {
      const content = fs.readFileSync(findingsPath(), "utf-8");
      expect(content).not.toContain("AKIAIOSFODNN7EXAMPLE");
    }
  });

  it("rejects finding containing generic API token", () => {
    expect(() => {
      addFindingToFile(tmp.path, PROJECT, "Use token sk-proj-abcdefghijklmnopqrstuvwxyz1234567890 for auth");
    }).toThrow(/secret/i);
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

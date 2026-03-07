import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isDuplicateFinding,
  resolveCoref,
  addFindingsToFile,
  checkSemanticDedup,
} from "../shared-content.js";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import * as fs from "fs";
import * as path from "path";

describe("isDuplicateFinding", () => {
  it("detects exact match duplicates", () => {
    const existing = "- The auth middleware runs before rate limiting and order matters\n- Use parameterized queries for SQL";
    expect(isDuplicateFinding(existing, "- The auth middleware runs before rate limiting, order matters")).toBe(true);
  });

  it("allows non-duplicates through", () => {
    const existing = "- The auth middleware runs before rate limiting\n- Use parameterized queries for SQL";
    expect(isDuplicateFinding(existing, "- Database indexes need rebuilding after schema migration")).toBe(false);
  });

  it("detects near-duplicates via Jaccard similarity", () => {
    const existing = "- Always restart the dev server after changing environment variables\n";
    // Same meaning, slightly different wording
    const nearDup = "- Restart dev server when environment variables change";
    expect(isDuplicateFinding(existing, nearDup)).toBe(true);
  });

  it("does not flag clearly different learnings as Jaccard duplicates", () => {
    const existing = "- The database connection pool should be limited to 20 connections\n";
    const different = "- React components should use memo for expensive renders";
    expect(isDuplicateFinding(existing, different)).toBe(false);
  });

  it("skips superseded entries when checking duplicates", () => {
    const existing = "- Old approach to auth <!-- superseded_by: New approach to auth -->\n- Use parameterized queries for SQL";
    expect(isDuplicateFinding(existing, "- Old approach to auth with minor changes")).toBe(false);
  });
});

describe("resolveCoref", () => {
  it("replaces 'the project' with project name", () => {
    const result = resolveCoref("Always restart the project after config changes", { project: "myapp" });
    expect(result).toContain("myapp");
    expect(result).not.toContain("the project");
  });

  it("replaces 'this file' with filename", () => {
    const result = resolveCoref("Check this file for configuration", { file: "/home/user/src/config.ts" });
    expect(result).toContain("config.ts");
    expect(result).not.toContain("this file");
  });

  it("returns text as-is when no context provided", () => {
    const text = "It does something interesting";
    expect(resolveCoref(text, {})).toBe(text);
  });

  it("prepends project name for sentence-starting pronouns", () => {
    const result = resolveCoref("It requires Node 18+", { project: "myapp" });
    expect(result).toContain("[myapp]");
  });
});

describe("addFindingsToFile rejects secrets", () => {
  let tmpDir: string;
  let tmpCleanup: (() => void) | undefined;

  function makeCortex(): string {
    ({ path: tmpDir, cleanup: tmpCleanup } = makeTempDir("cortex-bulk-secrets-"));
    return tmpDir;
  }

  function makeProject(cortexDir: string, name: string, files: Record<string, string>): void {
    const dir = path.join(cortexDir, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, file), content);
    }
  }

  afterEach(() => {
    delete process.env.CORTEX_ACTOR;
    if (tmpCleanup) {
      tmpCleanup();
      tmpCleanup = undefined;
    }
  });

  it("puts secret-containing findings in rejected[], not added[]", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "myproj", { "summary.md": "# myproj\n" });

    const result = addFindingsToFile(cortex, "myproj", [
      "Always use parameterized queries",
      "Use AKIAIOSFODNN7EXAMPLE for the API",
      "Cache invalidation is hard",
    ]);

    expect(result.ok).toBe(true);
    expect(result.data.added).toContain("Always use parameterized queries");
    expect(result.data.added).toContain("Cache invalidation is hard");
    expect(result.data.added).not.toContain("Use AKIAIOSFODNN7EXAMPLE for the API");
    expect(result.data.rejected).toHaveLength(1);
    expect(result.data.rejected[0].text).toBe("Use AKIAIOSFODNN7EXAMPLE for the API");
    expect(result.data.rejected[0].reason).toContain("AWS access key");
  });
});

describe("checkSemanticDedup", () => {
  let tmpDir: string;
  let tmpCleanup: (() => void) | undefined;

  function makeCortex(): string {
    ({ path: tmpDir, cleanup: tmpCleanup } = makeTempDir("cortex-semantic-dedup-"));
    return tmpDir;
  }

  beforeEach(() => {
    process.env.CORTEX_FEATURE_SEMANTIC_DEDUP = "1";
  });

  afterEach(() => {
    delete process.env.CORTEX_FEATURE_SEMANTIC_DEDUP;
    delete process.env.CORTEX_ACTOR;
    vi.restoreAllMocks();
    if (tmpCleanup) {
      tmpCleanup();
      tmpCleanup = undefined;
    }
  });

  it("returns false when feature flag is off", async () => {
    delete process.env.CORTEX_FEATURE_SEMANTIC_DEDUP;
    const cortex = makeCortex();
    const result = await checkSemanticDedup(cortex, "proj", "some finding");
    expect(result).toBe(false);
  });

  it("uses cache on second call (cache hit)", async () => {
    process.env.CORTEX_FEATURE_SEMANTIC_DEDUP = "1";
    const cortex = makeCortex();
    // Create project with a finding that has moderate Jaccard overlap
    const projDir = path.join(cortex, "proj");
    fs.mkdirSync(projDir, { recursive: true });
    fs.mkdirSync(path.join(cortex, ".runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, "FINDINGS.md"),
      "# proj Findings\n\n## 2026-01-01\n\n- restart server after configuration changes to apply new settings\n"
    );

    // Pre-populate the cache with a result
    // a and b have Jaccard ~0.56 (5 shared tokens out of 9 union), in the 0.3-0.65 semantic-check range
    const crypto = await import("node:crypto");
    const a = "restart server after configuration changes applied";
    const b = "restart server after configuration changes to apply new settings";
    const key = crypto.createHash("sha256").update(a + "|||" + b).digest("hex");
    const cachePath = path.join(cortex, ".runtime", "dedup-cache.json");
    fs.writeFileSync(cachePath, JSON.stringify({ [key]: { result: true, ts: Date.now() } }));

    // This should return true from cache without calling Anthropic
    const result = await checkSemanticDedup(cortex, "proj", "restart server after configuration changes applied");
    expect(result).toBe(true);

    delete process.env.CORTEX_FEATURE_SEMANTIC_DEDUP;
  });
});

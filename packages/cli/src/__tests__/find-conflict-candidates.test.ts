import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir } from "../test-helpers.js";
import { findConflictCandidates } from "../tools/finding.js";

const PROJECT = "proj";

let tmp: { path: string; cleanup: () => void };

function writeFindings(bullets: string[]) {
  const dir = path.join(tmp.path, PROJECT);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(tmp.path, ".runtime"), { recursive: true });
  fs.writeFileSync(path.join(dir, "FINDINGS.md"), `# ${PROJECT} Findings\n\n## 2026-01-01\n\n${bullets.join("\n")}\n`);
}

beforeEach(() => { tmp = makeTempDir("find-conflict-candidates-"); });
afterEach(() => tmp.cleanup());

describe("findConflictCandidates", () => {
  it("returns a candidate for a genuine same-topic opposite-polarity conflict", () => {
    writeFindings(["- Always use Docker for build caching to speed up local development"]);
    const candidates = findConflictCandidates(
      tmp.path,
      PROJECT,
      "Never use Docker for build caching — bare metal is faster for our pipeline",
    );
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]).toContain("Docker");
  });

  it("returns nothing for unrelated findings that merely share one incidental entity", () => {
    // Regression: a security decision and a git-workflow decision both mention GitHub with
    // opposite polarity, but are about different topics — must not be surfaced as a conflict.
    writeFindings(["- [decision] GitHub branch protection on the auth gateway must never be disabled"]);
    const candidates = findConflictCandidates(
      tmp.path,
      PROJECT,
      "[decision] For GitHub pushes always commit direct to main and prefer the merge workflow",
    );
    expect(candidates).toEqual([]);
  });

  it("ignores inactive (superseded/contradicted) findings", () => {
    writeFindings([
      '- Always use Docker for build caching to speed up local development <!-- phren:status "superseded" -->',
    ]);
    const candidates = findConflictCandidates(
      tmp.path,
      PROJECT,
      "Never use Docker for build caching — bare metal is faster for our pipeline",
    );
    expect(candidates).toEqual([]);
  });

  it("returns nothing when the project has no findings file", () => {
    expect(findConflictCandidates(tmp.path, "nonexistent", "Never use Docker")).toEqual([]);
  });
});

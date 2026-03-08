import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseGitLogRecords, scoreFindingCandidate, ghCachePath, mineGithubCandidates, runGhJson } from "./cli-extract.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ── parseGitLogRecords ───────────────────────────────────────────────────────

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("./utils.js", async (importOriginal) => {
  const orig: any = await importOriginal();
  return { ...orig, runGit: vi.fn() };
});

vi.mock("./shared.js", async (importOriginal) => {
  const orig: any = await importOriginal();
  return {
    ...orig,
    ensureCortexPath: () => "/tmp/cortex-fake",
    detectProject: () => "test-proj",
    debugLog: () => {},
    addFindingToFile: vi.fn(),
    appendReviewQueue: vi.fn(() => 1),
    appendAuditLog: vi.fn(),
    getRetentionPolicy: () => ({ autoAcceptThreshold: 0.8 }),
    recordFeedback: vi.fn(),
    flushEntryScores: vi.fn(),
    entryScoreKey: (_p: string, _f: string, l: string) => `key:${l}`,
    EXEC_TIMEOUT_MS: 5000,
  };
});

vi.mock("./hooks.js", () => ({
  commandExists: vi.fn(() => false),
}));

import { execFileSync } from "child_process";
import { runGit as runGitUtil } from "./utils.js";

const mockExecFileSync = vi.mocked(execFileSync);
const mockRunGit = vi.mocked(runGitUtil);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseGitLogRecords", () => {
  it("parses records separated by \\x1e with \\x1f field separators", () => {
    const raw = "abc123\x1fFix the bug\x1fdetails here\x1edef456\x1fAdd feature\x1f\x1e";
    mockRunGit.mockReturnValue(raw);

    const records = parseGitLogRecords("/repo", 30);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({ hash: "abc123", subject: "Fix the bug", body: "details here" });
    expect(records[1]).toEqual({ hash: "def456", subject: "Add feature", body: "" });
  });

  it("returns empty array when git log returns nothing", () => {
    mockRunGit.mockReturnValue("");
    expect(parseGitLogRecords("/repo", 7)).toEqual([]);
  });

  it("returns empty array when git log returns null (error)", () => {
    mockRunGit.mockReturnValue(null);
    expect(parseGitLogRecords("/repo", 7)).toEqual([]);
  });

  it("skips records with missing hash or subject", () => {
    const raw = "\x1f\x1fbody only\x1eabc\x1fReal commit\x1fbod\x1e";
    mockRunGit.mockReturnValue(raw);
    const records = parseGitLogRecords("/repo", 30);
    expect(records).toHaveLength(1);
    expect(records[0].subject).toBe("Real commit");
  });
});

// ── scoreFindingCandidate ─────────────────────────────────────────────────────

describe("scoreFindingCandidate", () => {
  it("returns null for short commit-message-style entries", () => {
    expect(scoreFindingCandidate("Fix typo", "")).toBeNull();
    expect(scoreFindingCandidate("Add tests", "")).toBeNull();
    expect(scoreFindingCandidate("Update README", "")).toBeNull();
    expect(scoreFindingCandidate("Bump version", "")).toBeNull();
  });

  it("accepts short entries that contain insight keywords", () => {
    const result = scoreFindingCandidate("Fix workaround for auth", "");
    expect(result).not.toBeNull();
    expect(result!.score).toBeGreaterThan(0.5);
  });

  it("returns null for very short entries without insight keywords", () => {
    expect(scoreFindingCandidate("Short", "")).toBeNull();
    expect(scoreFindingCandidate("A small change", "tiny")).toBeNull();
  });

  it("scores merged PR subjects higher", () => {
    const result = scoreFindingCandidate(
      "Merge pull request #42 from user/fix-auth",
      "This fixes the authentication flow by adding retry logic for token refresh"
    );
    expect(result).not.toBeNull();
    expect(result!.score).toBeGreaterThanOrEqual(0.55);
  });

  it("cleans up merge PR prefix from text", () => {
    const result = scoreFindingCandidate(
      "Merge pull request #42 from user/branch Fix workaround for auth regression",
      ""
    );
    expect(result).not.toBeNull();
    expect(result!.text).not.toContain("Merge pull request");
    expect(result!.text).toContain("Fix workaround");
  });

  it("boosts score for CI-related entries", () => {
    const ciResult = scoreFindingCandidate(
      "Pipeline flake in nightly build causes random failures",
      "The CI pipeline has been flaking due to a test ordering issue"
    );
    expect(ciResult).not.toBeNull();
    expect(ciResult!.score).toBeGreaterThanOrEqual(0.55);
  });

  it("boosts score for finding signal keywords", () => {
    const result = scoreFindingCandidate(
      "Race condition in connection pool causes intermittent deadlock",
      "Must avoid concurrent access to the shared pool or a deadlock happens"
    );
    expect(result).not.toBeNull();
    expect(result!.score).toBeGreaterThanOrEqual(0.6);
  });

  it("caps score at 0.99", () => {
    // Combine all boosters
    const result = scoreFindingCandidate(
      "Merge pull request #99 from dev/hotfix: CI pipeline workaround for flaky regression deadlock",
      "review requested changes: must avoid this gotcha caveat pitfall migration race condition"
    );
    expect(result).not.toBeNull();
    expect(result!.score).toBeLessThanOrEqual(0.99);
  });

  it("returns null when score stays below 0.5", () => {
    // A long enough entry but without any signal boosters
    const result = scoreFindingCandidate(
      "Changed the color of the button from blue to green in the sidebar",
      ""
    );
    expect(result).toBeNull();
  });

  it("capitalizes the first letter of the cleaned text", () => {
    const result = scoreFindingCandidate(
      "fix: workaround for the timeout issue in production deployment system",
      ""
    );
    expect(result).not.toBeNull();
    expect(result!.text[0]).toMatch(/[A-Z]/);
  });
});

// ── COMMIT_MSG_PREFIX filter ─────────────────────────────────────────────────

describe("COMMIT_MSG_PREFIX filter", () => {
  const prefixes = ["fix", "add", "update", "remove", "delete", "rename", "move", "bump", "revert", "merge", "chore", "refactor", "style", "docs", "test", "ci", "build", "release", "wip"];

  for (const prefix of prefixes) {
    it(`rejects "${prefix} something" without insight keywords`, () => {
      const subject = `${prefix} something in the codebase that is long enough to pass length check`;
      expect(scoreFindingCandidate(subject, "")).toBeNull();
    });

    it(`accepts "${prefix} something" with insight keywords`, () => {
      const subject = `${prefix} workaround for regression`;
      const result = scoreFindingCandidate(subject, "");
      expect(result).not.toBeNull();
    });
  }
});

// ── ghCachePath ──────────────────────────────────────────────────────────────

describe("ghCachePath", () => {
  it("returns a path in os.tmpdir keyed by repo path hash", () => {
    const p = ghCachePath("/home/user/my-repo");
    expect(p).toContain(os.tmpdir());
    expect(p).toMatch(/cortex-gh-cache-/);
    expect(p).toMatch(/cortex-gh-cache-[0-9a-f]{12}-/);
  });

  it("includes the current date", () => {
    const p = ghCachePath("/home/user/repo");
    const dateKey = new Date().toISOString().slice(0, 10);
    expect(p).toContain(dateKey);
  });

  it("produces different paths for repos with the same basename but different absolute paths", () => {
    const p1 = ghCachePath("/path/to/my-repo");
    const p2 = ghCachePath("/other/path/my-repo");
    expect(p1).not.toBe(p2);
  });

  it("produces paths with no special characters from repo path", () => {
    const p = ghCachePath("/path/to/my repo!@#");
    expect(p).not.toMatch(/[!@#\s]/);
  });
});

// ── runGhJson ────────────────────────────────────────────────────────────────

describe("runGhJson", () => {
  it("returns null when gh is not installed", async () => {
    const { commandExists } = await import("./hooks.js");
    vi.mocked(commandExists).mockReturnValue(false);
    const result = await runGhJson("/repo", ["pr", "list"]);
    expect(result).toBeNull();
  });

  it("parses JSON output from gh", async () => {
    const { commandExists } = await import("./hooks.js");
    vi.mocked(commandExists).mockReturnValue(true);
    mockExecFileSync.mockReturnValue(JSON.stringify([{ number: 1, title: "Test PR" }]));

    const result = await runGhJson<Array<{ number: number; title: string }>>("/repo", ["pr", "list"]);
    expect(result).toEqual([{ number: 1, title: "Test PR" }]);
  });

  it("returns null on empty output", async () => {
    const { commandExists } = await import("./hooks.js");
    vi.mocked(commandExists).mockReturnValue(true);
    mockExecFileSync.mockReturnValue("");

    const result = await runGhJson("/repo", ["pr", "list"]);
    expect(result).toBeNull();
  });

  it("returns null on non-retryable error", async () => {
    const { commandExists } = await import("./hooks.js");
    vi.mocked(commandExists).mockReturnValue(true);
    mockExecFileSync.mockImplementation(() => {
      throw new Error("auth required");
    });

    const result = await runGhJson("/repo", ["pr", "list"]);
    expect(result).toBeNull();
  });
});

// ── mineGithubCandidates ─────────────────────────────────────────────────────

describe("mineGithubCandidates", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-gh-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns cached candidates if cache is fresh", async () => {
    const cachePath = ghCachePath(tmpDir);
    const cached = [{ text: "PR #1: cached", score: 0.7 }];
    fs.writeFileSync(cachePath, JSON.stringify(cached));

    const result = await mineGithubCandidates(tmpDir);
    expect(result).toEqual(cached);
  });

  it("returns empty array when gh is not installed and no cache", async () => {
    const { commandExists } = await import("./hooks.js");
    vi.mocked(commandExists).mockReturnValue(false);

    const result = await mineGithubCandidates(tmpDir);
    expect(result).toEqual([]);
  });
});

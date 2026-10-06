/**
 * Worktree attribution regression tests.
 *
 * A Claude Code worktree at `<repo>/.claude/worktrees/gracious-napier-332a40`
 * was registered as its own top-level phren project and accumulated 14 commits
 * over two months under an auto-generated codename that looked like junk while
 * actually holding real `intranet2` data.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir } from "./test-helpers.js";
import { resolveWorktreeParent, resolveRepoRootForPath } from "./git-worktree.js";

describe("resolveWorktreeParent", () => {
  let tmp: { path: string; cleanup: () => void };
  let repo: string;

  beforeEach(() => {
    tmp = makeTempDir("git-worktree-");
    repo = path.join(tmp.path, "intranet2");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  });

  afterEach(() => tmp.cleanup());

  // ── Agent worktree directories ────────────────────────────────────────────

  it("attributes a .claude/worktrees checkout to the parent repo", () => {
    const worktree = path.join(repo, ".claude", "worktrees", "gracious-napier-332a40");
    fs.mkdirSync(worktree, { recursive: true });

    const result = resolveWorktreeParent(worktree);
    expect(result).not.toBeNull();
    expect(result!.repoRoot).toBe(repo);
    expect(result!.reason).toBe("agent-worktree-dir");
  });

  it("attributes a nested path inside an agent worktree to the parent repo", () => {
    const inner = path.join(repo, ".claude", "worktrees", "codename", "packages", "api");
    fs.mkdirSync(inner, { recursive: true });
    expect(resolveWorktreeParent(inner)!.repoRoot).toBe(repo);
  });

  it("handles other agent tool directories", () => {
    for (const dotDir of [".agent", ".cursor", ".git"]) {
      const worktree = path.join(repo, dotDir, "worktrees", "codename");
      expect(resolveWorktreeParent(worktree)!.repoRoot).toBe(repo);
    }
  });

  it("leaves an ordinary `worktrees/` folder alone", () => {
    // Not inside a dot-directory — this is just a project that happens to have
    // a folder called worktrees, and it must not be re-attributed.
    const ordinary = path.join(repo, "worktrees", "something");
    fs.mkdirSync(ordinary, { recursive: true });
    expect(resolveWorktreeParent(ordinary)).toBeNull();
  });

  // ── Linked git worktrees (`git worktree add`) ─────────────────────────────

  it("attributes a linked worktree via its .git file", () => {
    const worktree = path.join(tmp.path, "intranet2-feature");
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(
      path.join(worktree, ".git"),
      `gitdir: ${path.join(repo, ".git", "worktrees", "feature")}\n`,
    );

    const result = resolveWorktreeParent(worktree);
    expect(result).not.toBeNull();
    expect(result!.repoRoot).toBe(repo);
    expect(result!.reason).toBe("linked-worktree");
  });

  it("does NOT treat a submodule as a worktree", () => {
    // A submodule is a separate repository and should get its own project.
    const submodule = path.join(repo, "vendor", "lib");
    fs.mkdirSync(submodule, { recursive: true });
    fs.writeFileSync(path.join(submodule, ".git"), `gitdir: ${path.join(repo, ".git", "modules", "vendor/lib")}\n`);
    expect(resolveWorktreeParent(submodule)).toBeNull();
  });

  it("does NOT treat the main working tree as a worktree", () => {
    expect(resolveWorktreeParent(repo)).toBeNull();
  });

  it("returns null for a plain directory", () => {
    const plain = path.join(tmp.path, "not-a-repo");
    fs.mkdirSync(plain, { recursive: true });
    expect(resolveWorktreeParent(plain)).toBeNull();
  });
});

describe("resolveRepoRootForPath", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => { tmp = makeTempDir("git-worktree-root-"); });
  afterEach(() => tmp.cleanup());

  it("returns the repo root for a worktree and the path itself otherwise", () => {
    const repo = path.join(tmp.path, "repo");
    const worktree = path.join(repo, ".claude", "worktrees", "abc123");
    fs.mkdirSync(worktree, { recursive: true });

    expect(resolveRepoRootForPath(worktree)).toBe(repo);
    expect(resolveRepoRootForPath(repo)).toBe(repo);
  });

  it("never throws on a nonexistent path", () => {
    expect(() => resolveRepoRootForPath("/no/such/path/anywhere")).not.toThrow();
  });
});

/**
 * Git worktree detection.
 *
 * Agent tooling (Claude Code and friends) creates throwaway worktrees under
 * `<repo>/.claude/worktrees/<codename>`. Each one looks like a standalone repo
 * to a naive check — it has a `.git` entry and a directory name — so phren used
 * to register them as brand-new top-level projects with auto-generated
 * codenames, splitting a repo's memory across directories that look like junk.
 *
 * These helpers map such a directory back to the repository it belongs to.
 * Deliberately dependency-free (fs + path only) so every layer — project
 * locator, init/setup, and the session hooks' project detection — can import it
 * without creating a cycle.
 */
import * as fs from "fs";
import * as path from "path";

/**
 * Directory names that hold agent-managed worktrees. A `worktrees` directory
 * only counts when it sits inside a dot-directory (`.claude/worktrees`,
 * `.git/worktrees`, `.agent/worktrees`), so an ordinary project that happens to
 * contain a `worktrees/` folder is left alone.
 */
const WORKTREE_CONTAINER_NAMES: ReadonlySet<string> = new Set(["worktrees", ".worktrees"]);

/** Marker inside a linked worktree's gitdir path: `<repo>/.git/worktrees/<name>`. */
const LINKED_WORKTREE_SEGMENT = `${path.sep}.git${path.sep}worktrees${path.sep}`;

export interface WorktreeAttribution {
  /** Root of the repository this worktree belongs to. */
  repoRoot: string;
  /** Why we concluded `dir` is a worktree — useful in debug output. */
  reason: "agent-worktree-dir" | "linked-worktree";
}

/**
 * If `dir` is (or lives inside) a git worktree, return the repository it belongs
 * to. Returns `null` for ordinary directories, for the main working tree, and
 * for git submodules — a submodule is a separate repository and *should* get its
 * own project.
 */
export function resolveWorktreeParent(dir: string): WorktreeAttribution | null {
  const resolved = path.resolve(dir);

  const agentParent = parentFromAgentWorktreePath(resolved);
  if (agentParent) return { repoRoot: agentParent, reason: "agent-worktree-dir" };

  const linkedParent = parentFromLinkedWorktree(resolved);
  if (linkedParent) return { repoRoot: linkedParent, reason: "linked-worktree" };

  return null;
}

/**
 * Normalize a path for project attribution: worktrees resolve to the repository
 * they came from, everything else is returned unchanged. Safe to call on any
 * path — it never throws.
 */
export function resolveRepoRootForPath(dir: string): string {
  try {
    return resolveWorktreeParent(dir)?.repoRoot ?? path.resolve(dir);
  } catch {
    return path.resolve(dir);
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Path-shape detection: `<repo>/.claude/worktrees/<name>` and friends. Handles
 * the case where the worktree has already been deleted or was never a real git
 * worktree, which the gitdir probe below cannot.
 */
function parentFromAgentWorktreePath(resolved: string): string | null {
  const segments = resolved.split(path.sep);
  // Scan shallowest-first so a worktree nested inside another worktree still
  // attributes to the outermost real repository in a single pass.
  for (let i = 1; i < segments.length; i++) {
    if (!WORKTREE_CONTAINER_NAMES.has(segments[i])) continue;
    // Only trust `worktrees` when it is tucked inside a tool's dot-directory.
    let j = i - 1;
    if (!segments[j]?.startsWith(".")) continue;
    while (j >= 1 && segments[j].startsWith(".")) j--;
    if (j < 1) continue;
    return segments.slice(0, j + 1).join(path.sep) || path.sep;
  }
  return null;
}

/**
 * Git plumbing detection, without shelling out: in a linked worktree `.git` is a
 * *file* containing `gitdir: <repo>/.git/worktrees/<name>`. In the main working
 * tree `.git` is a directory, and in a submodule the gitdir points at
 * `.git/modules/...` instead — neither is treated as a worktree.
 */
function parentFromLinkedWorktree(resolved: string): string | null {
  let current = resolved;
  while (true) {
    const parent = repoRootFromGitFile(path.join(current, ".git"));
    if (parent) return parent;
    const next = path.dirname(current);
    if (next === current) return null;
    current = next;
  }
}

function repoRootFromGitFile(gitPath: string): string | null {
  let raw: string;
  try {
    if (!fs.statSync(gitPath).isFile()) return null;
    raw = fs.readFileSync(gitPath, "utf8");
  } catch {
    return null;
  }

  const match = raw.match(/^\s*gitdir:\s*(.+?)\s*$/m);
  if (!match) return null;

  // Relative gitdir pointers are resolved against the directory holding `.git`.
  const gitDir = path.resolve(path.dirname(gitPath), match[1].replace(/[/\\]/g, path.sep));
  const idx = gitDir.indexOf(LINKED_WORKTREE_SEGMENT);
  if (idx === -1) return null; // submodule or something else — not a worktree
  return gitDir.slice(0, idx);
}

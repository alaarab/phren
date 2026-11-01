import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { git, withGitReadDeadline } from "./projects.js";
import { BridgeError, type Json } from "./protocol.js";
import { displayPath, resolveWorktreeEntry } from "./git-worktrees.js";

/** Safe removal of a linked worktree from the phone. A preview first describes
 * what removing it would lose; its token is a digest of that exact state, so a
 * later removal either confirms the same state or is refused with the new one.
 * The branch is never deleted, and only worktrees outside the main checkout and
 * the requesting pane's own checkout qualify. */

export interface WorktreeRemovalSession { pane: string; title: string }
export interface WorktreeRemovalSubmodule { path: string; unpushedCommits: number }
export interface WorktreeRemovalPreview {
  token: string;
  path: string;
  branch: string | null;
  dirty: string[];
  untracked: number;
  submodules: WorktreeRemovalSubmodule[];
  sessions: WorktreeRemovalSession[];
  removable: boolean;
  reason?: string;
}

/** A live pane, with the folder it is running in, considered for blocking. */
export interface WorktreeRemovalLiveSession { pane: string; title: string; cwd: string }

export interface WorktreeRemovalContext {
  /** The checkout the request's pane is in; never removable. */
  paneRoot?: string;
  /** Live panes on this server; any running inside the worktree blocks removal. */
  sessions?: WorktreeRemovalLiveSession[];
}

const MAX_DIRTY = 50;

/** Working-tree changes, with untracked paths collapsed as Git reports them. */
async function changes(abs: string): Promise<{ dirty: string[]; untracked: number }> {
  const tokens = (await git(abs, "status", "--porcelain=v1", "-z", "--untracked-files=normal")).split("\0");
  const dirty: string[] = [];
  let untracked = 0;
  for (let index = 0; index < tokens.length; index++) {
    const row = tokens[index]; if (!row) continue;
    const status = row.slice(0, 2), file = row.slice(3);
    if (status === "??") { untracked++; continue; }
    // Porcelain -z places the destination before the source of a rename.
    if (/[RC]/.test(status)) index++;
    if (dirty.length < MAX_DIRTY) dirty.push(file);
  }
  return { dirty, untracked };
}

/** A submodule's HEAD commit when no remote branch contains it, with the number
 * of its commits that no remote branch reaches, plus whether any submodule is
 * initialized. An uninitialized submodule has no checkout to inspect and does
 * not stop Git from removing the worktree. */
async function inspectSubmodules(abs: string): Promise<{ initialized: boolean; unpushed: WorktreeRemovalSubmodule[] }> {
  const output = await git(abs, "submodule", "status", "--recursive");
  const unpushed: WorktreeRemovalSubmodule[] = [];
  let initialized = false;
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const marker = /^[ +\-U]/.test(line) ? line[0] : "";
    // An uninitialized submodule has no checkout to inspect.
    if (marker === "-") continue;
    const rest = marker ? line.slice(1) : line;
    const space = rest.indexOf(" ");
    if (space < 0) continue;
    const head = rest.slice(0, space);
    let sub = rest.slice(space + 1);
    // `git submodule status` may append " (describe)" to the path.
    const describe = sub.lastIndexOf(" (");
    if (describe > 0 && sub.endsWith(")")) sub = sub.slice(0, describe);
    const checkout = path.join(abs, sub);
    if (!(await stat(checkout).catch(() => undefined))?.isDirectory()) continue;
    initialized = true;
    const count = Number((await git(checkout, "rev-list", "--count", head, "--not", "--remotes")).trim()) || 0;
    if (count > 0) unpushed.push({ path: sub, unpushedCommits: count });
  }
  return { initialized, unpushed: unpushed.sort((a, b) => a.path.localeCompare(b.path)) };
}

/** Look through the live panes for sessions whose folder is the worktree or
 * inside it. */
async function sessionsIn(abs: string, sessions: WorktreeRemovalLiveSession[]): Promise<WorktreeRemovalSession[]> {
  const found: WorktreeRemovalSession[] = [];
  for (const session of sessions) {
    const cwd = await realpath(session.cwd).catch(() => path.resolve(session.cwd));
    if (cwd !== abs && !cwd.startsWith(abs + path.sep)) continue;
    found.push({ pane: session.pane, title: session.title });
  }
  return found.sort((a, b) => a.pane.localeCompare(b.pane));
}

function tokenFor(preview: Omit<WorktreeRemovalPreview, "token">): string {
  return createHash("sha256").update(JSON.stringify([
    preview.path, preview.branch, preview.dirty, preview.untracked,
    preview.submodules, preview.sessions, preview.removable, preview.reason ?? null,
  ])).digest("hex");
}

async function computePreview(cwd: string, worktree: unknown, context: WorktreeRemovalContext): Promise<WorktreeRemovalPreview> {
  const { abs, branch, main, root, locked } = await resolveWorktreeEntry(cwd, worktree);
  if (abs === main) throw new BridgeError(409, "The main checkout cannot be removed as a worktree.", { code: "worktree-not-removable" });
  if (context.paneRoot) {
    const paneRoot = await realpath(context.paneRoot).catch(() => path.resolve(context.paneRoot!));
    if (abs === paneRoot) throw new BridgeError(409, "The pane's own checkout cannot be removed.", { code: "worktree-not-removable" });
  }
  const { dirty, untracked } = await changes(abs);
  const submodules = await inspectSubmodules(abs);
  const sessions = await sessionsIn(abs, context.sessions ?? []);
  // The removal command may only add --force for changes this preview shows;
  // a clean worktree is never forced and a lock is never overridden.
  const force = dirty.length > 0 || untracked > 0;
  const reason = sessions.length > 0 ? "sessions-open"
    : locked ? "locked"
    : submodules.initialized && !force ? "initialized-submodules"
    : undefined;
  const removable = reason === undefined;
  const state = {
    path: displayPath(abs, [root, ...(main && main !== root ? [main] : [])]),
    branch,
    dirty,
    untracked,
    submodules: submodules.unpushed,
    sessions,
    removable,
    ...(reason ? { reason } : {}),
  };
  return { token: tokenFor(state), ...state };
}

/** Preview a removal: what the worktree is, what it would lose, and whether
 * anything live is using it. A main or current checkout is refused outright. */
export function previewWorktreeRemoval(cwd: string, worktree: unknown, context: WorktreeRemovalContext = {}): Promise<WorktreeRemovalPreview> {
  return withGitReadDeadline(() => computePreview(cwd, worktree, context));
}

/** Remove a worktree after its preview token matches the state recomputed now.
 * Dirty or untracked files the preview showed let the removal use `--force`;
 * a token for a clean worktree never does. The branch is left in place. */
export async function removeWorktree(cwd: string, worktree: unknown, token: unknown, context: WorktreeRemovalContext = {}): Promise<Json> {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) throw new BridgeError(400, "Invalid removal token.");
  const preview = await computePreview(cwd, worktree, context);
  if (preview.token !== token) {
    throw new BridgeError(409, "The worktree changed since the preview.", { code: "worktree-changed", preview });
  }
  if (!preview.removable) {
    const message = preview.reason === "sessions-open" ? "A live session is using this worktree."
      : preview.reason === "locked" ? "This worktree is locked; unlock it before removing it."
      : "This worktree has initialized submodules; a clean worktree is never removed with force.";
    throw new BridgeError(409, message, { code: "worktree-not-removable", reason: preview.reason, preview });
  }
  const { abs, branch, root } = await resolveWorktreeEntry(cwd, worktree);
  const force = preview.dirty.length > 0 || preview.untracked > 0;
  await git(root, "worktree", "remove", ...(force ? ["--force"] : []), "--", abs);
  return { removed: true, branch };
}

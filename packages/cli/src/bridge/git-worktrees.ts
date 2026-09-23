import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { BridgeError, type Json } from "./protocol.js";
import { git, gitRoot } from "./projects.js";

/** Workers edit in their own worktrees, so the pane's repository diff never
 * shows their work. These are the repository's other worktrees, exactly as
 * `git worktree list` reports them, each addressed by an opaque id the phone
 * sends back. A path the phone names is never trusted: an id resolves only to
 * a worktree the listing reports for this pane's repository. */

const MAX_WORKTREES = 64;
export const worktreeIdPattern = /^[a-f0-9]{32}$/;

/** Someone known to be working in a worktree: a fan-out job from its
 * manifest, or a sub-agent whose own transcript runs there. */
export interface WorktreeWorker {
  /** The worker's working directory; a worktree is matched when this is it or inside it. */
  cwd: string;
  label: string;
  provider: string;
  /** This conversation's public child id, when the worker is one of its agents. */
  child?: string;
  state?: string;
}

interface ListedWorktree { abs: string; head: string; branch: string | null; locked: boolean }

export function worktreeId(abs: string): string {
  return createHash("sha256").update(`worktree\0${abs}`).digest("hex").slice(0, 32);
}

/** `git worktree list --porcelain`: one block per worktree. Bare entries and
 * worktrees missing on disk are left out; nothing there can be shown. */
async function listed(root: string): Promise<{ main: string | undefined; worktrees: ListedWorktree[] }> {
  const output = await git(root, "worktree", "list", "--porcelain");
  const blocks: Array<Record<string, string>> = [];
  let current: Record<string, string> | undefined;
  for (const line of output.split("\n")) {
    if (!line) { current = undefined; continue; }
    const space = line.indexOf(" ");
    const key = space < 0 ? line : line.slice(0, space), value = space < 0 ? "" : line.slice(space + 1);
    if (key === "worktree") { current = { worktree: value }; blocks.push(current); continue; }
    if (current) current[key] = value;
  }
  const worktrees: ListedWorktree[] = [];
  let main: string | undefined;
  for (const [index, block] of blocks.entries()) {
    if (block.bare !== undefined || block.prunable !== undefined) continue;
    const abs = await realpath(block.worktree).catch(() => undefined);
    if (!abs || !(await stat(abs).catch(() => undefined))?.isDirectory()) continue;
    if (index === 0) main = abs;
    const branch = block.branch?.startsWith("refs/heads/") ? block.branch.slice("refs/heads/".length) : null;
    worktrees.push({ abs, head: block.HEAD ?? "", branch, locked: block.locked !== undefined });
    if (worktrees.length >= MAX_WORKTREES) break;
  }
  return { main, worktrees };
}

/** Relative to the repository when the worktree lives inside it (the usual
 * `.claude/worktrees/agent-*`), otherwise with the home folder shortened. */
function displayPath(abs: string, roots: string[]): string {
  for (const root of roots) {
    const rel = path.relative(root, abs);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel.split(path.sep).join("/");
  }
  const home = homedir();
  return abs === home ? "~" : abs.startsWith(home + path.sep) ? "~/" + path.relative(home, abs).split(path.sep).join("/") : abs;
}

function uncommitted(status: string): number {
  const tokens = status.split("\0");
  let count = 0;
  for (let index = 0; index < tokens.length; index++) {
    const record = tokens[index]; if (!record) continue;
    count++;
    if (/[RC]/.test(record.slice(0, 2))) index++;
  }
  return count;
}

async function workerFor(abs: string, workers: WorktreeWorker[], all: string[] = []): Promise<WorktreeWorker | undefined> {
  // The primary checkout holds `.claude/worktrees/*`: a worker in one of those
  // belongs to that worktree, not to the checkout around it.
  const nested = all.filter(other => other.startsWith(abs + path.sep));
  let best: { worker: WorktreeWorker; score: number } | undefined;
  for (const worker of workers) {
    const cwd = await realpath(worker.cwd).catch(() => path.resolve(worker.cwd));
    if (cwd !== abs && !cwd.startsWith(abs + path.sep)) continue;
    if (nested.some(inner => cwd === inner || cwd.startsWith(inner + path.sep))) continue;
    // An exact checkout beats a directory inside it; this conversation's own
    // agent beats a manifest that only names the checkout.
    const score = (cwd === abs ? 2 : 0) + (worker.child ? 1 : 0);
    if (!best || score > best.score) best = { worker, score };
  }
  return best?.worker;
}

/** The pane repository's other worktrees with branch, HEAD, commits ahead of
 * and behind this pane's HEAD, uncommitted file count and, when known, the
 * worker editing there. */
export async function gitWorktrees(cwd: string, workers: WorktreeWorker[] = []): Promise<Json> {
  const root = await gitRoot(cwd);
  if (!root) throw new BridgeError(409, "This pane is not in a Git repository.");
  const { main, worktrees } = await listed(root);
  const base = (await git(root, "rev-parse", "--verify", "HEAD").catch(() => "")).trim();
  const roots = [root, ...(main && main !== root ? [main] : [])];
  const others = worktrees.filter(worktree => worktree.abs !== root);
  const rows = await Promise.all(others.map(async worktree => {
    let ahead = 0, behind = 0;
    if (base && worktree.head && worktree.head !== base) {
      try {
        const counts = (await git(root, "rev-list", "--left-right", "--count", `${base}...${worktree.head}`)).trim().split(/\s+/);
        behind = Number(counts[0]) || 0; ahead = Number(counts[1]) || 0;
      } catch { ahead = 0; behind = 0; }
    }
    const changed = uncommitted(await git(worktree.abs, "status", "--porcelain=v1", "-z", "--untracked-files=normal").catch(() => ""));
    const worker = await workerFor(worktree.abs, workers, worktrees.map(item => item.abs));
    return {
      id: worktreeId(worktree.abs), path: displayPath(worktree.abs, roots), branch: worktree.branch,
      head: worktree.head, ahead, behind, changed,
      ...(worktree.abs === main ? { main: true } : {}), ...(worktree.locked ? { locked: true } : {}),
      ...(worker ? { worker: { label: worker.label.slice(0, 200), provider: worker.provider,
        ...(worker.child ? { child: worker.child } : {}), ...(worker.state ? { state: worker.state } : {}) } } : {}),
    };
  }));
  // Git lists linked worktrees by their admin folder; the phone reads them
  // the repository's own first, then by path.
  const outside = (value: string) => value.startsWith("/") || value.startsWith("~") ? 1 : 0;
  rows.sort((a, b) => outside(a.path) - outside(b.path) || a.path.localeCompare(b.path));
  return { worktrees: rows };
}

/** The checkout for one listed worktree id of the pane's repository, or a
 * 404; never a path the phone supplied. */
export async function resolveWorktree(cwd: string, id: unknown): Promise<string> {
  if (typeof id !== "string" || !worktreeIdPattern.test(id)) throw new BridgeError(400, "Invalid worktree.");
  const root = await gitRoot(cwd);
  if (!root) throw new BridgeError(409, "This pane is not in a Git repository.");
  const match = (await listed(root)).worktrees.find(worktree => worktreeId(worktree.abs) === id);
  if (!match) throw new BridgeError(404, "That worktree is not part of this repository.");
  return match.abs;
}

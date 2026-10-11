import { BridgeError, type Json } from "./protocol.js";
import { git, gitRoot } from "./projects.js";
import { countGit } from "./metrics.js";
import { invalidateTree } from "./git.js";
import { runCombined } from "./git-publish.js";

/** Moving the checkout from the phone: switch or create a branch, fetch the
 * upstream remote, fast-forward to it. Like commit and push, a refusal from
 * Git itself is a normal `{ ok: false, output }` answer with its own words.
 * Nothing here rewrites history, forces, resets or stashes. */

const SYNC_TIMEOUT_MS = 110_000;
const SWITCH_TIMEOUT_MS = 60_000;

async function repository(cwd: string): Promise<string> {
  const root = await gitRoot(cwd);
  if (!root) throw new BridgeError(409, "This pane is not in a Git repository.", { code: "git-not-repository" });
  return root;
}

function refused(run: { output: string; timedOut: boolean }, command: string, timeout: number): Json {
  return { ok: false, output: run.timedOut ? `${run.output}\n[${command} did not finish within ${timeout / 1000} seconds]`.trim() : run.output || `${command} failed.` };
}

/** A branch name Git itself accepts, never an option. */
async function branchName(root: string, raw: unknown): Promise<string> {
  if (typeof raw !== "string" || !raw || raw.length > 250 || raw.startsWith("-") || /[\x00-\x1f\x7f\s]/.test(raw)) throw new BridgeError(400, "Enter a valid branch name.");
  try { await git(root, "check-ref-format", "--branch", raw); }
  catch { throw new BridgeError(400, `${raw} is not a valid branch name.`); }
  return raw;
}

async function exists(root: string, ref: string): Promise<boolean> {
  return git(root, "show-ref", "--verify", "--quiet", ref).then(() => true, () => false);
}

/** Tracked files with staged or unstaged edits. Untracked files never block a
 * switch unless Git itself refuses to overwrite one. */
async function trackedChanges(root: string): Promise<number> {
  const rows = (await git(root, "status", "--porcelain=v1", "-z", "--untracked-files=no")).split("\0");
  let count = 0;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]; if (!row) continue;
    count++;
    if (/[RC]/.test(row.slice(0, 2))) index++;
  }
  return count;
}

/** Switch to a local branch, or create one (from `startPoint`, a branch or
 * remote-tracking branch, else HEAD) and switch to it. A remote-tracking
 * start point sets it as the upstream. Uncommitted tracked edits travel with
 * a switch in Git; the phone must say it knows (`carryChanges`), and Git
 * still refuses whatever would be overwritten. */
export async function gitCheckout(cwd: string, body: Json): Promise<Json> {
  const root = await repository(cwd);
  const branch = await branchName(root, body.branch);
  const create = body.create === true;
  let startPoint: string | undefined, track = false;
  if (body.startPoint !== undefined && body.startPoint !== null) {
    if (!create) throw new BridgeError(400, "A start point only applies to a new branch.");
    const raw = body.startPoint;
    if (typeof raw !== "string" || !raw || raw.length > 512 || raw.startsWith("-") || /[\x00-\x1f\x7f\s]/.test(raw)) throw new BridgeError(400, "Enter a valid start point.");
    if (await exists(root, `refs/heads/${raw}`)) startPoint = `refs/heads/${raw}`;
    else if (await exists(root, `refs/remotes/${raw}`)) { startPoint = `refs/remotes/${raw}`; track = true; }
    else throw new BridgeError(404, `There is no branch named ${raw}.`, { code: "git-unknown-ref" });
  }
  const local = await exists(root, `refs/heads/${branch}`);
  if (create && local) throw new BridgeError(409, `A branch named ${branch} already exists.`, { code: "git-branch-exists" });
  if (!create && !local) throw new BridgeError(404, `There is no local branch named ${branch}.`, { code: "git-unknown-ref" });
  const previous = (await git(root, "branch", "--show-current")).trim();
  if (!create && previous === branch) return { ok: true, branch, previous, changed: false };
  const dirty = await trackedChanges(root);
  if (dirty > 0 && body.carryChanges !== true) {
    throw new BridgeError(409, `${dirty === 1 ? "1 file has" : `${dirty} files have`} uncommitted changes that would move to ${branch}. Confirm to carry them.`, { code: "git-dirty", changes: dirty });
  }
  const args = ["-C", root, "--no-pager", "switch", "--no-guess", ...(create ? [...(track ? ["--track"] : ["--no-track"]), "-c", branch, ...(startPoint ? [startPoint] : [])] : [branch])];
  invalidateTree(root);
  countGit("projects");
  const run = await runCombined("git", args, root, SWITCH_TIMEOUT_MS);
  invalidateTree(root);
  if (run.code !== 0) return refused(run, "git switch", SWITCH_TIMEOUT_MS);
  const upstream = (await git(root, "for-each-ref", "--format=%(upstream:short)", `refs/heads/${branch}`)).trim();
  return { ok: true, branch, previous, changed: true, created: create, ...(upstream ? { upstream } : {}), carried: dirty };
}

/** The current branch's upstream, as remote and `refs/heads/…` merge ref. */
async function upstreamOf(root: string): Promise<{ branch: string; remote?: string; merge?: string }> {
  const branch = (await git(root, "branch", "--show-current")).trim();
  if (!branch) return { branch };
  const remote = (await git(root, "config", "--get", `branch.${branch}.remote`).catch(() => "")).trim();
  const merge = (await git(root, "config", "--get", `branch.${branch}.merge`).catch(() => "")).trim();
  return remote && remote !== "." && merge.startsWith("refs/heads/") ? { branch, remote, merge } : { branch };
}

/** Fetch the upstream's remote (else `origin`) and prune what it deleted, so
 * ahead/behind counts and remote branches are current. Tags are not fetched. */
export async function gitFetch(cwd: string): Promise<Json> {
  const root = await repository(cwd);
  const { remote: upstreamRemote } = await upstreamOf(root);
  const remotes = (await git(root, "remote")).split("\n").map(line => line.trim()).filter(Boolean);
  const remote = upstreamRemote ?? (remotes.includes("origin") ? "origin" : remotes[0]);
  if (!remote || !remotes.includes(remote)) throw new BridgeError(409, "This repository has no remote to fetch from.", { code: "git-no-remote" });
  countGit("projects");
  const run = await runCombined("git", ["-C", root, "--no-pager", "fetch", "--prune", "--no-tags", "--quiet", remote], root, SYNC_TIMEOUT_MS);
  invalidateTree(root);
  if (run.code !== 0) return refused(run, "git fetch", SYNC_TIMEOUT_MS);
  return { ok: true, remote, ...(run.output ? { output: run.output } : {}) };
}

/** Fetch, then fast-forward the current branch to its upstream. Never a merge
 * commit or a rebase: a branch that has diverged is refused by Git and the
 * phone shows why. */
export async function gitPull(cwd: string): Promise<Json> {
  const root = await repository(cwd);
  const { branch, remote, merge } = await upstreamOf(root);
  if (!branch) throw new BridgeError(409, "HEAD is detached. Check out a branch on the computer first.", { code: "git-detached" });
  if (!remote || !merge) throw new BridgeError(409, `${branch} has no upstream to pull from. Push it first.`, { code: "git-no-upstream" });
  const before = (await git(root, "rev-parse", "HEAD")).trim();
  countGit("projects");
  invalidateTree(root);
  const run = await runCombined("git", ["-C", root, "--no-pager", "pull", "--ff-only", "--no-rebase", "--no-tags", "--quiet", remote, merge], root, SYNC_TIMEOUT_MS);
  invalidateTree(root);
  if (run.code !== 0) return refused(run, "git pull", SYNC_TIMEOUT_MS);
  const after = (await git(root, "rev-parse", "HEAD")).trim();
  const commits = before === after ? 0 : Number((await git(root, "rev-list", "--count", `${before}..${after}`)).trim()) || 0;
  return { ok: true, branch, upstream: `${remote}/${merge.slice("refs/heads/".length)}`, commits, ...(run.output ? { output: run.output } : {}) };
}

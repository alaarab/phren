import { lstat, readdir, readlink, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { execProbe as exec } from "../probe-processes.js";
import { git as runGit } from "../projects.js";

/**
 * The housekeeping safety rules. Every housekeeping check and action goes
 * through this module; nothing else in `bridge/housekeeping/` may run git,
 * delete a path or remove a worktree. The rules come from the owner, after
 * the 2026-11-08 incident in which a cleanup worker deleted worktrees with
 * unpushed commits and ran `git reset --hard` across about 24 repositories:
 *
 * 1. Never delete a worktree or repository that has uncommitted changes,
 *    untracked files, commits on no remote, a stash, an operation in
 *    progress, a dirty or unpushed submodule, a live process inside it or a
 *    pane bound to it. Inspection that fails counts as a blocker.
 * 2. Never run git reset, checkout, clean, restore, switch, push, branch or a
 *    stash change, and never pass --force. Git runs only through
 *    `housekeepingGit`, which admits a fixed set of read-only commands plus
 *    `worktree remove` (without force) and `worktree prune`.
 * 3. Suggest by default. Only a path inside an allow-listed cache root,
 *    old enough and not in use, may be acted on without the owner.
 */


// ---------------------------------------------------------------------------
// Rule 2: the git gate.

export class SafetyViolation extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "SafetyViolation"; }
}

/** Subcommands that only read. */
const READ_ONLY = new Set(["status", "rev-list", "rev-parse", "for-each-ref", "symbolic-ref", "log", "show-ref", "ls-files"]);
/** Subcommands that discard or rewrite work; named so the refusal says why. */
const BANNED = new Set(["reset", "checkout", "clean", "restore", "switch", "push", "branch", "rebase", "merge", "pull", "fetch",
  "commit", "am", "cherry-pick", "revert", "rm", "mv", "gc", "prune", "reflog", "update-ref", "filter-branch", "replace", "tag", "notes", "config"]);

/** Throws unless `args` is a git invocation housekeeping may run. Global
 * options before the subcommand (-c, -C, --git-dir, --work-tree) are refused
 * outright: they could re-target or reconfigure the command. */
export function assertHousekeepingGit(args: readonly string[]): void {
  const [sub, ...rest] = args;
  if (!sub || sub.startsWith("-")) throw new SafetyViolation("git-global-option", `Housekeeping never passes git global options (${sub ?? "none"}).`);
  for (const arg of rest) {
    if (arg === "--") break;
    if (arg === "--force" || arg === "-f" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg) && sub === "worktree" || arg.startsWith("--force"))
      throw new SafetyViolation("git-force", `Housekeeping never forces a git command (git ${sub} ${arg}).`);
  }
  if (BANNED.has(sub)) throw new SafetyViolation("git-banned", `Housekeeping never runs git ${sub}.`);
  if (READ_ONLY.has(sub)) return;
  const verb = rest[0];
  if (sub === "stash" && verb === "list") return;
  if (sub === "submodule" && verb === "status") return;
  if (sub === "worktree" && (verb === "list" || verb === "remove")) return;
  if (sub === "worktree" && verb === "prune" && rest.every(arg => ["prune", "--dry-run", "-n", "--verbose", "-v"].includes(arg))) return;
  throw new SafetyViolation("git-not-allowed", `Housekeeping may not run git ${[sub, verb].filter(Boolean).join(" ")}.`);
}

/** The only git runner housekeeping uses. */
export async function housekeepingGit(cwd: string, ...args: string[]): Promise<string> {
  assertHousekeepingGit(args);
  return runGit(cwd, ...args);
}

// ---------------------------------------------------------------------------
// Rule 1: checkout blockers.

export type BlockerCode =
  | "not-a-checkout" | "symlink" | "inspection-failed" | "main-checkout" | "linked-worktrees" | "locked"
  | "uncommitted-changes" | "untracked-files" | "unpushed-commits" | "stash" | "in-progress-operation"
  | "dirty-submodule" | "unpushed-submodule" | "live-process" | "bound-pane" | "in-use";

export interface Blocker { code: BlockerCode; detail: string }

const PLAIN: Record<BlockerCode, string> = {
  "not-a-checkout": "It isn't a checkout Phren can inspect.",
  symlink: "It is a symbolic link; Phren never follows one.",
  "inspection-failed": "Phren couldn't check it, so it stays.",
  "main-checkout": "It is the repository's main checkout.",
  "linked-worktrees": "Other worktrees depend on it.",
  locked: "The worktree is locked.",
  "uncommitted-changes": "It has uncommitted changes.",
  "untracked-files": "It has untracked files.",
  "unpushed-commits": "It has commits that aren't on any remote.",
  stash: "The repository has stashed changes.",
  "in-progress-operation": "A rebase, merge or similar is in progress.",
  "dirty-submodule": "A submodule has uncommitted changes.",
  "unpushed-submodule": "A submodule has commits that aren't on any remote.",
  "live-process": "A process is using it now.",
  "bound-pane": "An agent pane is working in it.",
  "in-use": "Something is using it now.",
};

/** One plain sentence for the first blocker, for the phone. */
export function plainReason(blockers: readonly Blocker[]): string {
  return blockers.length ? PLAIN[blockers[0].code] : "";
}

/** A process and the folder it runs in. */
export interface LiveProcess { pid: number; cwd: string; command?: string }
/** A pane and the folder its agent runs in. */
export interface BoundPane { pane: string; cwd: string; title?: string }

export interface InUseSources {
  processes: () => Promise<LiveProcess[]>;
  panes: () => Promise<BoundPane[]>;
}

const IN_PROGRESS = ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"];

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
const exists = (p: string) => lstat(p).then(() => true, () => false);

async function canonical(p: string): Promise<string> { return realpath(p).catch(() => path.resolve(p)); }

/** Processes and panes whose folder is `dir` or inside it. */
export async function inUseBlockers(dir: string, sources: InUseSources): Promise<Blocker[]> {
  const blockers: Blocker[] = [];
  const [processes, panes] = await Promise.all([sources.processes(), sources.panes()]);
  for (const proc of processes) {
    if (proc.pid === process.pid) continue;
    if (inside(await canonical(proc.cwd), dir)) blockers.push({ code: "live-process", detail: `pid ${proc.pid}${proc.command ? ` (${proc.command})` : ""} runs in ${proc.cwd}` });
  }
  for (const pane of panes) {
    if (inside(await canonical(pane.cwd), dir)) blockers.push({ code: "bound-pane", detail: `pane ${pane.pane}${pane.title ? ` (${pane.title})` : ""} runs in ${pane.cwd}` });
  }
  return blockers;
}

async function submoduleBlockers(dir: string): Promise<Blocker[]> {
  const blockers: Blocker[] = [];
  const output = await housekeepingGit(dir, "submodule", "status", "--recursive");
  for (const line of output.split("\n")) {
    if (!line.trim() || line[0] === "-") continue; // uninitialized: nothing checked out to lose
    const rest = /^[ +U]/.test(line) ? line.slice(1) : line;
    const space = rest.indexOf(" ");
    if (space < 0) continue;
    let sub = rest.slice(space + 1);
    const describe = sub.lastIndexOf(" (");
    if (describe > 0 && sub.endsWith(")")) sub = sub.slice(0, describe);
    const checkout = path.join(dir, sub);
    if (!(await stat(checkout).catch(() => undefined))?.isDirectory()) continue;
    if ((await housekeepingGit(checkout, "status", "--porcelain=v1", "--untracked-files=normal")).trim())
      blockers.push({ code: "dirty-submodule", detail: `submodule ${sub} has uncommitted changes` });
    const unpushed = Number((await housekeepingGit(checkout, "rev-list", "--count", "HEAD", "--not", "--remotes")).trim()) || 0;
    if (unpushed > 0) blockers.push({ code: "unpushed-submodule", detail: `submodule ${sub} has ${unpushed} commit(s) on no remote` });
  }
  return blockers;
}

export type CheckoutTarget = "worktree" | "repository";

/** What a checkout holds, as the inventory shows it. */
export interface CheckoutFacts {
  main: boolean;
  branch?: string;
  /** The repository's main checkout (for a linked worktree, the one it belongs to). */
  repo?: string;
  dirty: number;
  untracked: number;
  unpushed: number;
  stashes: number;
  inProgress: string[];
  locked: boolean;
  lastCommitAt?: string;
}

/**
 * What `dir` holds and every reason it must not be deleted (no blockers means
 * nothing would be lost). `worktree`: a linked worktree, removed with `git
 * worktree remove`; only its HEAD's commits matter, since its branch stays.
 * `repository`: the whole repository folder; every local branch counts, and
 * linked worktrees block. Stashes block either way: the owner's rule names
 * them without exception.
 */
export async function inspectCheckout(dir: string, target: CheckoutTarget, sources: InUseSources): Promise<{ facts?: CheckoutFacts; blockers: Blocker[] }> {
  const info = await lstat(dir).catch(() => undefined);
  if (!info) return { blockers: [{ code: "not-a-checkout", detail: `${dir} does not exist` }] };
  if (info.isSymbolicLink()) return { blockers: [{ code: "symlink", detail: `${dir} is a symbolic link; housekeeping never follows one` }] };
  if (!info.isDirectory()) return { blockers: [{ code: "not-a-checkout", detail: `${dir} is not a folder` }] };
  const abs = await canonical(dir);
  const blockers: Blocker[] = [];
  let facts: CheckoutFacts | undefined;
  try {
    const top = await canonical((await housekeepingGit(abs, "rev-parse", "--show-toplevel")).trim());
    if (top !== abs) return { blockers: [{ code: "not-a-checkout", detail: `${dir} is inside ${top}, not a checkout root` }] };
    const gitDir = await canonical(path.resolve(abs, (await housekeepingGit(abs, "rev-parse", "--git-dir")).trim()));
    const commonDir = await canonical(path.resolve(abs, (await housekeepingGit(abs, "rev-parse", "--git-common-dir")).trim()));
    const isMain = gitDir === commonDir;

    const worktrees = parseWorktreeList(await housekeepingGit(abs, "worktree", "list", "--porcelain"));
    if (target === "worktree" && isMain) blockers.push({ code: "main-checkout", detail: "this is the repository's main checkout, not a linked worktree" });
    if (target === "repository") {
      const linked = worktrees.filter(w => w.path !== abs && !w.prunable);
      if (linked.length) blockers.push({ code: "linked-worktrees", detail: `${linked.length} linked worktree(s) depend on it: ${linked.map(w => w.path).slice(0, 5).join(", ")}` });
    }
    const self = worktrees.find(w => w.path === abs);
    if (self?.locked !== undefined) blockers.push({ code: "locked", detail: `worktree is locked${self.locked ? `: ${self.locked}` : ""}` });

    const status = (await housekeepingGit(abs, "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=none")).split("\0").filter(Boolean);
    let tracked = 0, untracked = 0;
    for (let i = 0; i < status.length; i++) {
      const code = status[i].slice(0, 2);
      if (code === "??") untracked++; else tracked++;
      if (/[RC]/.test(code)) i++;
    }
    if (tracked) blockers.push({ code: "uncommitted-changes", detail: `${tracked} changed tracked path(s)` });
    if (untracked) blockers.push({ code: "untracked-files", detail: `${untracked} untracked path(s) not ignored` });

    const hasHead = await housekeepingGit(abs, "rev-parse", "--verify", "--quiet", "HEAD").then(() => true, () => false);
    let unpushed = 0, lastCommitAt: string | undefined;
    if (hasHead) {
      const refs = target === "repository" ? ["HEAD", "--branches"] : ["HEAD"];
      unpushed = Number((await housekeepingGit(abs, "rev-list", "--count", ...refs, "--not", "--remotes")).trim()) || 0;
      if (unpushed > 0) blockers.push({ code: "unpushed-commits", detail: `${unpushed} commit(s) on no remote branch` });
      const stamp = (await housekeepingGit(abs, "log", "-1", "--format=%cI", "HEAD")).trim();
      if (stamp) lastCommitAt = new Date(stamp).toISOString();
    }

    const stashes = (await housekeepingGit(abs, "stash", "list")).split("\n").filter(Boolean);
    if (stashes.length) blockers.push({ code: "stash", detail: `${stashes.length} stash entr${stashes.length === 1 ? "y" : "ies"}` });

    const inProgress: string[] = [];
    for (const marker of IN_PROGRESS) {
      if (await exists(path.join(gitDir, marker))) {
        inProgress.push(marker);
        blockers.push({ code: "in-progress-operation", detail: `${marker} is present: an operation is in progress` });
      }
    }
    blockers.push(...await submoduleBlockers(abs));
    const mainPath = worktrees[0] && !worktrees[0].bare ? worktrees[0].path : undefined;
    facts = { main: isMain, ...(self?.branch ? { branch: self.branch } : {}), ...(mainPath ? { repo: mainPath } : {}),
      dirty: tracked, untracked, unpushed, stashes: stashes.length, inProgress, locked: self?.locked !== undefined, ...(lastCommitAt ? { lastCommitAt } : {}) };
  } catch (error) {
    // Fail closed: what could not be inspected is kept.
    blockers.push({ code: "inspection-failed", detail: error instanceof Error ? error.message.slice(0, 300) : String(error) });
  }
  try { blockers.push(...await inUseBlockers(abs, sources)); }
  catch (error) { blockers.push({ code: "inspection-failed", detail: `could not list processes or panes: ${error instanceof Error ? error.message : error}` }); }
  return { ...(facts ? { facts } : {}), blockers };
}

/** Every reason `dir` must not be deleted; see `inspectCheckout`. */
export async function checkoutBlockers(dir: string, target: CheckoutTarget, sources: InUseSources): Promise<Blocker[]> {
  return (await inspectCheckout(dir, target, sources)).blockers;
}

export interface WorktreeEntry { path: string; branch?: string; locked?: string; prunable?: string; bare?: boolean }

export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) { current = { path: line.slice(9) }; out.push(current); continue; }
    if (!current) continue;
    if (line.startsWith("branch ")) current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "locked" || line.startsWith("locked ")) current.locked = line.slice(7);
    else if (line === "prunable" || line.startsWith("prunable ")) current.prunable = line.slice(9) || "prunable";
    else if (line === "bare") current.bare = true;
  }
  return out;
}

/** Remove a linked worktree only if it has no blockers right now, re-checked
 * against fresh state, and only with plain `git worktree remove`. A refusal
 * from git leaves the worktree where it is; nothing retries with force. */
export async function removeWorktreeSafely(dir: string, sources: InUseSources): Promise<{ removed: boolean; blockers: Blocker[] }> {
  const blockers = await checkoutBlockers(dir, "worktree", sources);
  if (blockers.length) return { removed: false, blockers };
  const abs = await canonical(dir);
  await housekeepingGit(abs, "worktree", "remove", "--", abs);
  return { removed: true, blockers: [] };
}

// ---------------------------------------------------------------------------
// Rule 3: the cache allowlist.

export interface CacheRule {
  id: string;
  /** Absolute root; only entries strictly inside it qualify. */
  root: string;
  /** Minimum age of an entry, by mtime, before it may be acted on. */
  minAgeDays: number;
}

/** Caches the disk-janitor proved safe to remove; every other path is
 * suggest-only. Platform-specific roots are listed only where they exist. */
export function cacheRules(home = homedir(), platform: NodeJS.Platform = process.platform): CacheRule[] {
  const rules: CacheRule[] = [
    { id: "phren-ci-builds", root: path.join(home, "phren-ci-builds"), minAgeDays: 7 },
    { id: "npm-cacache", root: path.join(home, ".npm", "_cacache"), minAgeDays: 30 },
  ];
  if (platform === "darwin") rules.push(
    { id: "xctest-devices", root: path.join(home, "Library/Developer/XCTestDevices"), minAgeDays: 2 },
    { id: "derived-data", root: path.join(home, "Library/Developer/Xcode/DerivedData"), minAgeDays: 14 },
    { id: "ios-device-support", root: path.join(home, "Library/Developer/Xcode/iOS DeviceSupport"), minAgeDays: 90 },
    { id: "swiftpm-cache", root: path.join(home, "Library/Caches/org.swift.swiftpm"), minAgeDays: 30 },
  );
  return rules;
}

/** Paths housekeeping never acts on, whatever a rule says. DeviceFS is a live
 * view of booted simulators that `du` reports as ~160 GB; docker volumes hold
 * data; the store and project folders hold work. */
export function protectedRoots(home = homedir()): string[] {
  return [
    path.join(home, "Library/Developer/CoreDevice"),
    "/var/lib/docker/volumes",
    path.join(home, ".docker/volumes"),
    path.join(home, ".phren"),
    path.join(home, "Projects"),
    path.join(home, "Sites"),
    path.join(home, ".ssh"),
  ];
}

export type CacheDecision =
  | { verdict: "auto"; rule: string }
  | { verdict: "suggest" | "keep"; rule?: string; reason: string; blockers?: Blocker[] };

export interface CacheContext extends InUseSources {
  rules?: CacheRule[];
  protected?: string[];
  now?: number;
}

/**
 * Whether `target` may be removed without the owner. `auto` only for an entry
 * strictly inside an allow-listed root (resolved without following a link at
 * the target), past the rule's age, under no protected root, and with no
 * process or pane in it. Anything else is `suggest` (the owner may approve)
 * or `keep` (a safety rule holds it).
 */
export async function cacheDecision(target: string, context: CacheContext): Promise<CacheDecision> {
  const info = await lstat(target).catch(() => undefined);
  if (!info) return { verdict: "keep", reason: "missing" };
  if (info.isSymbolicLink()) return { verdict: "keep", reason: "symlink" };
  // Resolve the parent, not the target, so a link at the target is never followed.
  const abs = path.join(await canonical(path.dirname(target)), path.basename(target));
  for (const root of context.protected ?? protectedRoots()) {
    const real = await canonical(root);
    if (inside(abs, real) || inside(real, abs)) return { verdict: "keep", reason: "protected-path" };
  }
  let matched: CacheRule | undefined;
  for (const rule of context.rules ?? cacheRules()) {
    const root = await canonical(rule.root);
    if (abs !== root && inside(abs, root)) { matched = rule; break; }
  }
  if (!matched) return { verdict: "suggest", reason: "outside-allowlist" };
  const ageDays = ((context.now ?? Date.now()) - info.mtimeMs) / 86_400_000;
  if (ageDays < matched.minAgeDays) return { verdict: "suggest", rule: matched.id, reason: "too-recent" };
  const blockers = await inUseBlockers(abs, context).catch(error => [{ code: "inspection-failed" as const, detail: String(error) }]);
  if (blockers.length) return { verdict: "keep", rule: matched.id, reason: "in-use", blockers };
  return { verdict: "auto", rule: matched.id };
}

/** Delete an allow-listed cache entry, re-deciding against fresh state first.
 * Refuses (returns the decision) unless the decision is `auto` now, or the
 * owner approved it and the only thing short of `auto` is its age: an owner
 * may clear a recent cache entry, never a path outside the cache roots. */
export async function removeCacheEntry(target: string, context: CacheContext, ownerApproved = false): Promise<{ removed: boolean; decision: CacheDecision }> {
  const decision = await cacheDecision(target, context);
  const approvedRecent = ownerApproved && decision.verdict === "suggest" && decision.reason === "too-recent";
  if (decision.verdict !== "auto" && !approvedRecent) return { removed: false, decision };
  await rm(target, { recursive: true, force: false, maxRetries: 0 });
  return { removed: true, decision };
}

// ---------------------------------------------------------------------------
// Owner-approved deletions beyond the caches: /tmp entries and node_modules.

/** Scratch roots whose direct children the owner may delete. */
export function tmpRoots(platform: NodeJS.Platform = process.platform): string[] {
  return platform === "darwin" ? ["/private/tmp"] : ["/tmp"];
}

const TMP_MIN_AGE_MS = 24 * 3_600_000;

export type PathDecision = { allowed: true; rule: string } | { allowed: false; reason: string; blockers?: Blocker[] };

export interface DeletionContext extends CacheContext {
  tmpRoots?: string[];
  uid?: number;
}

/**
 * Whether the owner may delete `target`, decided now against the disk:
 * - an entry inside an allow-listed cache root (any age, since the owner asked);
 * - a direct child of a scratch root this user owns, untouched for a day, not
 *   a git checkout (those go through the worktree rules), with nothing in it;
 * - a checkout's own `node_modules` (it has package.json), with nothing
 *   running in that checkout.
 * Never a symlink, never under a protected root except that node_modules.
 */
export async function deletionDecision(target: string, context: DeletionContext): Promise<PathDecision> {
  const info = await lstat(target).catch(() => undefined);
  if (!info) return { allowed: false, reason: "It is already gone." };
  if (info.isSymbolicLink()) return { allowed: false, reason: "It is a symbolic link; Phren never follows one." };
  const parent = await canonical(path.dirname(target));
  const abs = path.join(parent, path.basename(target));
  const inUse = async (dir: string): Promise<PathDecision | undefined> => {
    const blockers = await inUseBlockers(dir, context).catch(error => [{ code: "inspection-failed" as const, detail: String(error) }]);
    return blockers.length ? { allowed: false, reason: plainReason(blockers), blockers } : undefined;
  };

  if (path.basename(abs) === "node_modules" && info.isDirectory()) {
    if (!await exists(path.join(parent, "package.json")) || !await exists(path.join(parent, ".git")))
      return { allowed: false, reason: "Phren only clears node_modules at the top of a checkout." };
    return await inUse(parent) ?? { allowed: true, rule: "node-modules" };
  }

  const cache = await cacheDecision(target, context);
  if (cache.verdict === "auto") return { allowed: true, rule: cache.rule };
  if (cache.verdict === "suggest" && cache.rule) return { allowed: true, rule: cache.rule }; // only too recent; the owner asked
  if (cache.verdict === "keep" && cache.reason !== "protected-path")
    return { allowed: false, reason: cache.blockers?.length ? plainReason(cache.blockers) : "Phren won't remove it.", ...(cache.blockers ? { blockers: cache.blockers } : {}) };
  if (cache.verdict === "keep") return { allowed: false, reason: "It is under a folder Phren never touches." };

  for (const root of context.tmpRoots ?? tmpRoots()) {
    if (parent !== await canonical(root)) continue;
    if (info.uid !== (context.uid ?? process.getuid?.() ?? info.uid)) return { allowed: false, reason: "Another user owns it." };
    if ((context.now ?? Date.now()) - info.mtimeMs < TMP_MIN_AGE_MS) return { allowed: false, reason: "It was changed in the last day." };
    if (info.isDirectory() && await exists(path.join(abs, ".git"))) return { allowed: false, reason: "It is a git checkout; remove it as a worktree." };
    return await inUse(abs) ?? { allowed: true, rule: "tmp" };
  }
  return { allowed: false, reason: "Phren only deletes caches, scratch folders and node_modules." };
}

/** Delete what the owner approved, deciding again just before. */
export async function removeApprovedPath(target: string, context: DeletionContext): Promise<{ removed: boolean; decision: PathDecision }> {
  const decision = await deletionDecision(target, context);
  if (!decision.allowed) return { removed: false, decision };
  await rm(target, { recursive: true, force: false, maxRetries: 0 });
  return { removed: true, decision };
}

// ---------------------------------------------------------------------------
// Panes.

export interface PaneState { server: string; pane: string; status?: string; role?: string }
export interface PaneDispatch { id?: string; server: string; pane: string; returned?: { read: boolean }; closedAt?: string }

/** Why a pane must stay open, or undefined if the owner may close it. A
 * pane whose dispatch return is unread keeps the evidence (the 2026-11-08
 * lesson); a working or waiting agent and the conductor stay too. */
export function paneCloseBlock(pane: PaneState, dispatches: readonly PaneDispatch[]): string | undefined {
  if (pane.role === "conductor") return "It is the conductor.";
  if (pane.status === "working") return "Its agent is working.";
  if (pane.status === "blocked" || pane.status === "waiting") return "Its agent is waiting for an answer.";
  for (const receipt of dispatches) {
    if (receipt.closedAt || receipt.server !== pane.server || receipt.pane !== pane.pane) continue;
    if (!receipt.returned) return "Its dispatched work hasn't returned yet.";
    if (!receipt.returned.read) return "Its return hasn't been read yet.";
  }
  return undefined;
}

/** What an item of a given kind may be: only a cache can ever be `auto`. */
export function allowedVerdict(kind: string, proposed: "auto" | "suggest" | "keep"): "auto" | "suggest" | "keep" {
  return proposed === "auto" && kind !== "cache" ? "suggest" : proposed;
}

// ---------------------------------------------------------------------------
// Production in-use sources.

/** Every process's working directory this user can see: `lsof` on macOS,
 * `/proc/<pid>/cwd` on Linux. A failure throws, so callers fail closed. */
export async function liveProcessCwds(platform: NodeJS.Platform = process.platform): Promise<LiveProcess[]> {
  if (platform === "linux") {
    const out: LiveProcess[] = [];
    for (const entry of await readdir("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const cwd = await readlink(`/proc/${entry}/cwd`).catch(() => undefined);
      if (cwd) out.push({ pid: Number(entry), cwd });
    }
    return out;
  }
  // lsof exits 1 when some processes could not be read; its output is still valid.
  const { stdout } = await exec("lsof", ["-n", "-P", "-d", "cwd", "-F", "pcn"], { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 })
    .catch((error: { stdout?: string; code?: unknown }) => { if (typeof error.stdout === "string" && error.stdout) return { stdout: error.stdout }; throw error; });
  return parseLsofCwds(stdout);
}

export function parseLsofCwds(output: string): LiveProcess[] {
  const out: LiveProcess[] = [];
  let pid = 0, command: string | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) { pid = Number(line.slice(1)); command = undefined; }
    else if (line.startsWith("c")) command = line.slice(1);
    else if (line.startsWith("n") && pid) out.push({ pid, cwd: line.slice(1), ...(command ? { command } : {}) });
  }
  return out;
}

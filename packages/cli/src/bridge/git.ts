import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { BridgeError, type Json } from "./protocol.js";
import { git, gitRoot } from "./projects.js";

const exec = promisify(execFile);

/** A status code from `--name-status`: the letter alone, with `T` (type change)
 * shown as an edit and anything unrecognized treated as one. */
function statusLetter(code: string): string {
  const letter = code[0];
  return ["M", "A", "D", "R", "C", "U"].includes(letter) ? letter : "M";
}

/** `--name-status -z` records as path-to-status; a rename carries old then new. */
function parseNameStatus(out: string): Map<string, string> {
  const map = new Map<string, string>();
  const tokens = out.split("\0");
  for (let index = 0; index < tokens.length; index++) {
    const code = tokens[index]; if (!code) continue;
    if (code[0] === "R" || code[0] === "C") {
      index++; const destination = tokens[++index];
      if (destination) map.set(destination, code[0]);
    } else {
      const file = tokens[++index];
      if (file) map.set(file, code[0]);
    }
  }
  return map;
}

/** `--numstat -z` per-path line counts; a rename leaves the path empty and the
 * two names follow as their own tokens. */
function parseNumstat(out: string): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>();
  const tokens = out.split("\0");
  for (let index = 0; index < tokens.length; index++) {
    const record = tokens[index]; if (!record) continue;
    const parts = record.split("\t");
    if (parts.length < 2) continue;
    const additions = parts[0] === "-" ? 0 : Number(parts[0]) || 0;
    const deletions = parts[1] === "-" ? 0 : Number(parts[1]) || 0;
    let file = parts.slice(2).join("\t");
    if (!file) { index++; const destination = tokens[++index]; file = destination ?? ""; }
    if (file) map.set(file, { additions, deletions });
  }
  return map;
}

/** A count of a text file's lines, for an untracked file whose diff has no base. */
async function countLines(root: string, rel: string): Promise<number> {
  try {
    const abs = path.join(root, await repositoryPath(root, rel));
    if ((await stat(abs)).size > 5_000_000) return 0;
    const bytes = await readFile(abs);
    if (!bytes.length || bytes.includes(0)) return 0;
    let lines = 0;
    for (const byte of bytes) if (byte === 10) lines++;
    return bytes[bytes.length - 1] === 10 ? lines : lines + 1;
  } catch { return 0; }
}

/** Everything `git status` reports, kept apart by section so `gitLog` and
 * `gitTree` can reuse it. */
async function collect(root: string) {
  const branch = (await git(root, "branch", "--show-current")).trim();
  let upstream: string | undefined;
  let ahead = 0, behind = 0;
  try { upstream = (await git(root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")).trim() || undefined; }
  catch { upstream = undefined; }
  if (upstream) {
    try {
      const counts = (await git(root, "rev-list", "--left-right", "--count", `${upstream}...HEAD`)).trim().split(/\s+/);
      behind = Number(counts[0]) || 0; ahead = Number(counts[1]) || 0;
    } catch { ahead = 0; behind = 0; }
  }
  const [stagedRaw, unstagedRaw, stagedCounts, unstagedCounts, untrackedRaw] = await Promise.all([
    git(root, "diff", "--cached", "--name-status", "-z"),
    git(root, "diff", "--name-status", "-z"),
    git(root, "diff", "--cached", "--numstat", "-z"),
    git(root, "diff", "--numstat", "-z"),
    git(root, "ls-files", "--others", "--exclude-standard", "-z"),
  ]);
  const staged = parseNameStatus(stagedRaw), unstaged = parseNameStatus(unstagedRaw);
  const stagedStats = parseNumstat(stagedCounts), unstagedStats = parseNumstat(unstagedCounts);
  const untracked = untrackedRaw.split("\0").filter(Boolean);
  return { branch, upstream, ahead, behind, staged, unstaged, stagedStats, unstagedStats, untracked };
}

/** The remote's default branch as its `HEAD` records it. With no recorded
 * `HEAD`, `main` and `master` are treated as default so the guard errs on the
 * side of asking. */
export async function defaultBranch(root: string, remote = "origin"): Promise<string | null> {
  const head = (await git(root, "symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`).catch(() => "")).trim();
  if (head.startsWith(remote + "/")) return head.slice(remote.length + 1);
  const branches = new Set((await git(root, "for-each-ref", "--format=%(refname:short)", "refs/heads").catch(() => "")).split("\n").filter(Boolean));
  return branches.has("main") ? "main" : branches.has("master") ? "master" : null;
}

export interface GitStatusFile { path: string; status: string; staged: boolean; additions: number; deletions: number }
export interface GitStatus {
  branch: string; upstream: string | null; ahead: number; behind: number;
  staged: number; unstaged: number; untracked: number; additions: number; deletions: number; files: GitStatusFile[];
  /** The branch a push guards: the upstream remote's `HEAD`, else `main`/`master`. */
  defaultBranch: string | null;
}

async function repository(cwd: string): Promise<string> {
  const root = await gitRoot(cwd);
  if (!root) throw new BridgeError(409, "This pane is not in a Git repository.");
  return root;
}

/** Working-tree status, one record per section: a file edited in both the index
 * and the working tree appears once with `staged: true` and once with `false`. */
export async function gitStatus(cwd: string): Promise<GitStatus> {
  const root = await repository(cwd);
  treeCache.delete(root);
  const data = await collect(root);
  const fallback = await defaultBranch(root, data.upstream?.split("/")[0] || "origin");
  const files: GitStatusFile[] = [];
  for (const [file, status] of data.staged) {
    const counts = data.stagedStats.get(file) ?? { additions: 0, deletions: 0 };
    files.push({ path: file, status: statusLetter(status), staged: true, ...counts });
  }
  for (const [file, status] of data.unstaged) {
    const counts = data.unstagedStats.get(file) ?? { additions: 0, deletions: 0 };
    files.push({ path: file, status: statusLetter(status), staged: false, ...counts });
  }
  for (const file of data.untracked) files.push({ path: file, status: "?", staged: false, additions: await countLines(root, file), deletions: 0 });
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);
  return { branch: data.branch, upstream: data.upstream ?? null, ahead: data.ahead, behind: data.behind,
    staged: data.staged.size, unstaged: data.unstaged.size, untracked: data.untracked.length, additions, deletions, files,
    defaultBranch: fallback };
}

/** The repository's remotes, so a branch ref can be told from a remote-tracking
 * one even when a local branch name contains a slash. */
async function remotes(root: string): Promise<string[]> {
  return (await git(root, "remote").catch(() => "")).split("\n").map(line => line.trim()).filter(Boolean);
}

function refEntries(spec: string, remotes: string[]): Json[] {
  const refs: Json[] = [];
  for (const raw of spec.split(",").map(part => part.trim()).filter(Boolean)) {
    if (raw === "HEAD") { refs.push({ name: "HEAD", kind: "head" }); continue; }
    if (raw.startsWith("HEAD -> ")) {
      refs.push({ name: "HEAD", kind: "head" });
      const name = raw.slice(8);
      refs.push({ name, kind: remotes.some(remote => name.startsWith(remote + "/")) ? "remote" : "local" });
    } else if (raw.startsWith("tag: ")) refs.push({ name: raw.slice(5), kind: "tag" });
    else refs.push({ name: raw, kind: remotes.some(remote => raw.startsWith(remote + "/")) ? "remote" : "local" });
  }
  return refs;
}

/** Commits newest first, plus a one-line summary of what is not committed yet. */
export async function gitLog(cwd: string, limit = 60, ref?: string): Promise<Json> {
  const root = await repository(cwd);
  const count = Math.min(200, Math.max(1, Math.trunc(limit) || 60));
  let revision: string | undefined;
  if (ref !== undefined) {
    if (!ref || ref.length > 512 || ref.startsWith("-") || /[\x00-\x1f\x7f]/.test(ref)) throw new BridgeError(400, "Invalid branch ref.");
    // Resolve to a commit first so Git never interprets a ref as an option or path.
    try { revision = (await git(root, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`)).trim(); }
    catch { throw new BridgeError(400, "That branch ref does not name a commit."); }
  } else {
    revision = (await git(root, "rev-parse", "--verify", "HEAD").catch(() => "")).trim();
  }
  const known = await remotes(root);
  const output = revision ? await git(root, "log", "--decorate=short", "--date=iso-strict", "--format=%H%x00%h%x00%s%x00%an%x00%cI%x00%D%x00%P", "-n", String(count), revision, "--") : "";
  const commits: Json[] = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const [sha, short, subject, author, date, spec, parents] = line.split("\0");
    commits.push({ sha, short, subject, author, date, refs: refEntries(spec ?? "", known), parents: (parents ?? "").split(" ").filter(Boolean) });
  }
  const status = await gitStatus(root);
  const uncommitted = { files: new Set(status.files.map(file => file.path)).size, additions: status.additions, deletions: status.deletions };
  return { commits, uncommitted };
}

/** Local branches with their upstream and ahead/behind counts, and remote refs. */
export async function gitBranches(cwd: string): Promise<Json> {
  const root = await repository(cwd);
  const format = "%(refname)%00%(refname:short)%00%(upstream:short)%00%(upstream:track)%00%(committerdate:iso-strict)%00%(HEAD)";
  const output = await git(root, "for-each-ref", `--format=${format}`, "refs/heads", "refs/remotes");
  const local: Json[] = [], remote: Json[] = [];
  let current: string | null = null;
  for (const line of output.split("\n")) {
    if (!line) continue;
    const [refname, short, upstream, track, date, head] = line.split("\0");
    if (refname.startsWith("refs/remotes/")) {
      if (short.endsWith("/HEAD")) continue;
      remote.push({ name: short, date });
    } else if (refname.startsWith("refs/heads/")) {
      const gone = (track ?? "").includes("gone");
      const ahead = Number(/ahead (\d+)/.exec(track ?? "")?.[1]) || 0;
      const behind = Number(/behind (\d+)/.exec(track ?? "")?.[1]) || 0;
      if (head === "*") current = short;
      local.push({ name: short, ...(upstream && !gone ? { upstream } : {}), ahead, behind, date });
    }
  }
  return { current, local, remote };
}

const ghEnv = () => ({ ...process.env, GIT_CONFIG_NOSYSTEM: "1", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" });

/** A check rollup as one word: any failure fails, anything unfinished is
 * pending, and only finished successes (or skips) pass. No checks is null. */
export function checkRollup(items: unknown): "passing" | "failing" | "pending" | null {
  if (!Array.isArray(items) || !items.length) return null;
  let pending = false;
  for (const raw of items) {
    const item = raw && typeof raw === "object" ? raw as Json : {};
    const conclusion = String(item.conclusion ?? "").toUpperCase(), state = String(item.state ?? "").toUpperCase();
    const status = String(item.status ?? "").toUpperCase();
    if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(conclusion) || ["FAILURE", "ERROR"].includes(state)) return "failing";
    // A commit status has a state; a check run has a status and, once
    // completed, a conclusion.
    if (state && !status) { if (state !== "SUCCESS") pending = true; }
    else if (status !== "COMPLETED") pending = true;
  }
  return pending ? "pending" : "passing";
}

/** The checked-out branch's pull request in any state, with its checks, or
 * null when the branch has none (or gh cannot say). */
async function currentPull(root: string, branch: string): Promise<Json | null> {
  try {
    const { stdout } = await exec("gh", ["pr", "view", "--json", "number,title,url,state,isDraft,headRefName,baseRefName,statusCheckRollup"], {
      cwd: root, timeout: 15_000, maxBuffer: 4_194_304, env: ghEnv(),
    });
    const pull = JSON.parse(stdout || "null");
    if (!pull || typeof pull !== "object" || typeof pull.number !== "number" || pull.headRefName !== branch) return null;
    return { number: pull.number, title: String(pull.title ?? ""), url: String(pull.url ?? ""), head: branch,
      base: String(pull.baseRefName ?? ""), draft: pull.isDraft === true, state: String(pull.state ?? ""), checks: checkRollup(pull.statusCheckRollup) };
  } catch { return null; }
}

/** Open pull requests through `gh`, or `{ available: false }` when the tool is
 * missing or not signed in. A failure is a normal answer, never an error.
 * `current` is the checked-out branch's own pull request in any state (open,
 * draft, merged or closed) with its checks, which the session card shows. */
export async function gitPulls(cwd: string): Promise<Json> {
  const root = await repository(cwd);
  const branch = (await git(root, "branch", "--show-current").catch(() => "")).trim();
  try {
    const [{ stdout }, current] = await Promise.all([
      exec("gh", ["pr", "list", "--json", "number,title,headRefName,baseRefName,author,url,isDraft,state,updatedAt", "--limit", "50"], {
        cwd: root, timeout: 15_000, maxBuffer: 4_194_304, env: ghEnv(),
      }),
      branch ? currentPull(root, branch) : Promise.resolve(null),
    ]);
    const parsed = JSON.parse(stdout || "[]");
    const pulls = (Array.isArray(parsed) ? parsed : []).map((pull: Json) => {
      const author = pull.author && typeof pull.author === "object" ? pull.author as Json : {};
      return { number: pull.number, title: pull.title, head: pull.headRefName, base: pull.baseRefName,
        author: String(author.login ?? author.name ?? ""), url: pull.url, draft: pull.isDraft === true, state: pull.state, updated: pull.updatedAt };
    });
    return { available: true, pulls, branch: branch || null, current };
  } catch { return { available: false, pulls: [], branch: branch || null, current: null }; }
}

/** A repo-relative tree path, or the repository root for `""`. */
async function repositoryPath(root: string, raw: unknown, allowRoot = false): Promise<string> {
  if (typeof raw !== "string" || raw.length > 4096 || raw.includes("\0") || path.isAbsolute(raw) || path.win32.isAbsolute(raw) || raw.startsWith("\\")) throw new BridgeError(400, "Invalid path.");
  const segments = raw.split(/[\\/]/);
  if (segments.includes("..")) throw new BridgeError(400, "Invalid path.");
  const clean = segments.filter(part => part && part !== ".").join("/");
  if ((!clean && !allowRoot) || clean.startsWith("-")) throw new BridgeError(400, "Invalid path.");
  const abs = path.resolve(root, clean);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new BridgeError(403, "This path is outside the repository.");
  // Deleted files still need stage/restore. Check their nearest existing
  // ancestor, but never treat a dangling symlink as a missing ordinary path.
  let existing = abs;
  while (true) {
    try { await lstat(existing); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || existing === root) throw new BridgeError(400, "Invalid path.");
      existing = path.dirname(existing);
    }
  }
  let resolved: string;
  try { resolved = await realpath(existing); }
  catch { throw new BridgeError(403, "This path cannot be resolved inside the repository."); }
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new BridgeError(403, "This path is outside the repository.");
  return clean;
}

type TreeEntry = { name: string; path: string; kind: "dir" | "file"; status?: string; fileCount?: number; ignored?: true };
type TreeSnapshot = { version: string; levels: Map<string, TreeEntry[]> };
const treeCache = new Map<string, { head: string; expires: number; snapshot: Promise<TreeSnapshot> }>();
/** Drop the cached tree after a write (commit, push) outside this module. */
export function invalidateTree(root: string): void { treeCache.delete(root); }
const TREE_TTL_MS = 2_000;

/** Build directory children once, without diff hunks, line counts or upstream walks. */
async function treeSnapshot(root: string, head: string): Promise<TreeSnapshot> {
  const [tracked, porcelain] = await Promise.all([
    git(root, "ls-files", "-z"),
    git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all"),
  ]);
  const changed = new Map<string, string>();
  const files = new Set(tracked.split("\0").filter(Boolean));
  const tokens = porcelain.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const row = tokens[i];
    if (!row) continue;
    const xy = row.slice(0, 2), file = row.slice(3);
    const letter = xy === "??" ? "?" : statusLetter(xy[1] !== " " ? xy[1] : xy[0]);
    changed.set(file, letter);
    files.add(file);
    // Porcelain -z places the destination before the source of a rename.
    if (/[RC]/.test(xy)) i++;
  }
  const levels = new Map<string, Map<string, TreeEntry>>();
  levels.set("", new Map());
  for (const file of files) {
    const parts = file.split("/");
    if (parts.includes("node_modules") || parts.includes(".git")) continue;
    let parent = "";
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i], full = parent ? `${parent}/${name}` : name;
      const directory = i < parts.length - 1;
      let siblings = levels.get(parent);
      if (!siblings) { siblings = new Map(); levels.set(parent, siblings); }
      let entry = siblings.get(name);
      if (!entry || (directory && entry.kind === "file")) {
        // A deleted tracked file can coexist with untracked descendants at
        // the same path. Descendants make this a navigable directory.
        entry = { name, path: full, kind: directory ? "dir" : "file", ...(directory ? { fileCount: 0 } : {}) };
        siblings.set(name, entry);
      }
      if (directory) {
        entry.fileCount = (entry.fileCount ?? 0) + 1;
        if (changed.has(file)) entry.status = "changed";
      } else if (changed.has(file)) entry.status = entry.kind === "dir" ? "changed" : changed.get(file);
      parent = full;
    }
  }
  const version = createHash("sha256").update(head).update(tracked).update(porcelain).digest("hex");
  return { version, levels: new Map([...levels].map(([directory, entries]) => [directory,
    [...entries.values()].sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1)])) };
}

const MAX_IGNORED_ENTRIES = 1_000;
const ignoredCache = new Map<string, { expires: number; listing: Promise<string[]> }>();

/** Git-ignored paths as `git ls-files --others --ignored --exclude-standard
 * --directory` reports them: a wholly ignored folder once, with a trailing
 * slash, instead of every file inside it. */
async function ignoredListing(root: string): Promise<string[]> {
  let cached = ignoredCache.get(root);
  if (!cached || cached.expires <= Date.now()) {
    if (ignoredCache.size >= 32) ignoredCache.delete(ignoredCache.keys().next().value!);
    cached = { expires: Date.now() + TREE_TTL_MS,
      listing: git(root, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z").then(out => out.split("\0").filter(Boolean)) };
    ignoredCache.set(root, cached);
  }
  try { return await cached.listing; }
  catch (error) { ignoredCache.delete(root); throw error; }
}

/** The ignored entries directly under `prefix`, marked `ignored`. Inside a
 * wholly ignored folder Git lists nothing further, so that level is read from
 * the disk itself (no `.git`, symlinks shown as files and never followed). */
async function ignoredEntries(root: string, prefix: string, shown: TreeEntry[]): Promise<TreeEntry[]> {
  const listing = await ignoredListing(root);
  const taken = new Set(shown.map(entry => entry.name));
  const entries = new Map<string, TreeEntry>();
  const inside = prefix && listing.some(item => item.endsWith("/") && (prefix + "/").startsWith(item));
  if (inside) {
    const dirents = await readdir(path.join(root, prefix), { withFileTypes: true }).catch(() => []);
    for (const dirent of dirents) {
      if (dirent.name === ".git" || taken.has(dirent.name) || entries.size >= MAX_IGNORED_ENTRIES) continue;
      entries.set(dirent.name, { name: dirent.name, path: `${prefix}/${dirent.name}`, kind: dirent.isDirectory() ? "dir" : "file", ignored: true });
    }
  } else {
    const base = prefix ? prefix + "/" : "";
    for (const item of listing) {
      if (!item.startsWith(base) || item.length <= base.length) continue;
      const rest = item.slice(base.length), slash = rest.indexOf("/");
      const name = slash < 0 ? rest : rest.slice(0, slash);
      if (!name || name === ".git" || taken.has(name) || entries.has(name)) continue;
      if (entries.size >= MAX_IGNORED_ENTRIES) break;
      entries.set(name, { name, path: base + name, kind: slash < 0 ? "file" : "dir", ignored: true });
    }
  }
  return [...entries.values()];
}

/** One lazy directory response from a bounded repo/HEAD/status-hash snapshot.
 * Every request still validates the pane's repo and the requested path. A HEAD
 * move invalidates immediately; external working-tree edits age out after 2s.
 * Status refresh and phone mutations invalidate immediately as well. With
 * `ignored`, git-ignored folders and files at that level are added, marked. */
export async function gitTree(cwd: string, relPath: unknown = "", ignored = false): Promise<Json> {
  const root = await repository(cwd);
  const prefix = await repositoryPath(root, relPath, true);
  const head = await git(root, "rev-parse", "HEAD").catch(() => "unborn");
  let cached = treeCache.get(root);
  if (!cached || cached.head !== head || cached.expires <= Date.now()) {
    if (treeCache.size >= 32) treeCache.delete(treeCache.keys().next().value!);
    cached = { head, expires: Date.now() + TREE_TTL_MS, snapshot: treeSnapshot(root, head) };
    treeCache.set(root, cached);
  }
  try {
    const snapshot = await cached.snapshot;
    const entries = snapshot.levels.get(prefix) ?? [];
    if (!ignored) return { path: prefix, version: snapshot.version, entries };
    const extra = await ignoredEntries(root, prefix, entries);
    const all = [...entries, ...extra].sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1);
    return { path: prefix, version: snapshot.version, entries: all };
  } catch (error) {
    if (treeCache.get(root) === cached) treeCache.delete(root);
    throw error;
  }
}

/** The phone's paths are repo-relative, at most 64, and can never climb out. */
async function repositoryPaths(root: string, raw: unknown): Promise<string[]> {
  const list = Array.isArray(raw) ? raw : [];
  if (!list.length || list.length > 64) throw new BridgeError(400, "Choose between 1 and 64 paths.");
  const paths: string[] = [];
  for (const entry of list) {
    const clean = await repositoryPath(root, entry);
    if (clean && !paths.includes(clean)) paths.push(clean);
  }
  if (!paths.length) throw new BridgeError(400, "Choose between 1 and 64 paths.");
  return paths;
}

export async function gitStage(cwd: string, paths: unknown): Promise<Json> {
  const root = await repository(cwd);
  treeCache.delete(root);
  try {
    await git(root, "add", "--", ...(await repositoryPaths(root, paths)).map(file => `:(literal)${file}`));
    return { ok: true };
  } finally { treeCache.delete(root); }
}

export async function gitUnstage(cwd: string, paths: unknown): Promise<Json> {
  const root = await repository(cwd);
  treeCache.delete(root);
  try {
    const files = (await repositoryPaths(root, paths)).map(file => `:(literal)${file}`);
    const hasHead = await git(root, "rev-parse", "--verify", "HEAD").then(() => true, () => false);
    if (hasHead) await git(root, "restore", "--staged", "--", ...files);
    else await git(root, "rm", "--force", "--cached", "--", ...files);
    return { ok: true };
  } finally { treeCache.delete(root); }
}

/** Destructive: tracked files go back to the index, untracked files are
 * removed. The phone confirms first; no `-d` (directories) and no `-x`. */
export async function gitDiscard(cwd: string, paths: unknown): Promise<Json> {
  const root = await repository(cwd);
  treeCache.delete(root);
  try {
    const files = await repositoryPaths(root, paths);
    const untracked = new Set((await git(root, "ls-files", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean));
    for (const file of files) {
      const literal = `:(literal)${file}`;
      if (untracked.has(file)) await git(root, "clean", "-f", "--", literal);
      else await git(root, "checkout", "--", literal);
    }
    return { ok: true };
  } finally { treeCache.delete(root); }
}

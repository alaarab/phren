import { checkoutGitEnv } from "./projects.js";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, copyFile, mkdir, readdir, readFile, realpath, rm, stat, unlink, utimes } from "node:fs/promises";
import { homeDir } from "../home-paths.js";
import path from "node:path";
import { promisify } from "node:util";
import { BridgeError, bridgeRoot, object, type Json } from "./protocol.js";
import { z } from "zod";
import { ProcessPool } from "./limits.js";
import { phrenStoreRoot } from "./transcripts.js";
import { countGit, countTick } from "./metrics.js";

const exec = promisify(execFile);

/** One file a shell command changed, with the patch between the working
 * tree before the call and after it. `root` is the repository; `path` is
 * relative to it. */
export const changedFileSchema = z.object({ root: z.string(), path: z.string(), status: z.string(), patch: z.string(),
  added: z.number().int().nonnegative(), removed: z.number().int().nonnegative(), redacted: z.boolean().optional(), binary: z.boolean().optional(), truncated: z.boolean().optional() });
export type ChangedFile = z.infer<typeof changedFileSchema>;
const changeRowSchema = z.object({ toolUseId: z.string(), files: z.array(changedFileSchema) });
export const secretName = (file: string): boolean => /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|keychain-db|tfstate)|id_rsa.*|id_ed25519.*|(?:.*\.)?credentials\.json|\.netrc|\.npmrc|\.pypirc)$/i.test(path.basename(file));
/** Two Git jobs at a time: one repository's tree read (shared by every call
 * waiting for it), one call's diff, or a repository lookup. Each holds its slot
 * for all of its Git processes, so under load jobs finish in turn rather than
 * all late together. */
const capturePool = new ProcessPool(2);

/** Tools whose filesystem changes are captured around the lifecycle callback. */
export const SHELL_TOOLS = new Set(["Bash", "bash", "shell", "Shell", "exec_command", "shell_command", "local_shell", "write_stdin"]);

const NAMED = /(?<![\w@:/])(?:~\/|\.\/|\/)[\w.@+~-]+(?:\/[\w.@+~-]+)*/g;
/** The places a command names — the same rule the phone applies. */
const FILE_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit", "apply_patch", "str_replace_editor", "create_file", "replace_string_in_file", "multi_replace_string_in_file"]);
export function capturesChanges(tool: string, input: Json): boolean {
  return SHELL_TOOLS.has(tool) || FILE_TOOLS.has(tool.split(".").at(-1)!.toLowerCase()) || typeof input.command === "string" || typeof input.cmd === "string";
}

export function namedPaths(command: string, input: Json = {}): string[] {
  const found = new Set<string>();
  for (const match of command.slice(0, 65_536).matchAll(NAMED)) { if (match[0].length > 2) found.add(match[0]); if (found.size === 24) break; }
  for (const value of [input.file_path, input.path, input.notebook_path,
    ...((Array.isArray(input.replacements) ? input.replacements : []).map(v => object(v).filePath))]) {
    if (typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0")) found.add(value);
  }
  // Patch headers are paths, never execute their content or scan new file text.
  const patch = [input.patch, input.input, input.command, command].filter((v): v is string => typeof v === "string").join("\n").slice(0, 262144);
  for (const match of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) {
    const value = (match[1] ?? match[2]).trim(); if (value && value.length <= 4096 && !value.includes("\0")) found.add(value);
    if (found.size >= 48) break;
  }
  return [...found].slice(0, 48);
}

/** Only inside a `capturePool` slot. */
async function git(cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}, signal?: AbortSignal): Promise<string> {
  countGit("changes");
  return (await exec("git", ["-C", cwd, "--no-pager", ...args], {
    signal, timeout: 10_000, maxBuffer: 8_388_608, env: { ...checkoutGitEnv(), ...extra },
  })).stdout;
}

/** A capture that ran out of time (the hook budget, Git's own timeout, or the
 * Hook closing). The call shows no changes; nothing is wrong with the repository. */
class CaptureTimeout extends Error {}
function timedOut(error: unknown): boolean {
  const failure = error as { name?: string; code?: string; killed?: boolean } | undefined;
  return error instanceof CaptureTimeout || failure?.name === "AbortError" || failure?.code === "ABORT_ERR" || failure?.killed === true;
}
/** `work`, but given up on (not stopped) when `signal` fires. */
function until<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** One tree read of a repository and the calls waiting for it. */
interface Read { result: Promise<string>; waiting: number; controller: AbortController }
/** One repository lookup and the calls waiting for it. */
interface Lookup { result: Promise<Repository | undefined>; waiting: number; controller: AbortController }
/** What a capture needs to know about one repository. */
interface Repository { root: string; objects: string; index: string }

/** The nearest folder at or above `dir` with a `.git` entry: where Git's own
 * discovery would start looking, found without starting a Git process. */
async function checkoutOf(dir: string): Promise<string | undefined> {
  for (let at = dir; ; at = path.dirname(at)) {
    if (await stat(path.join(at, ".git")).then(() => true, () => false)) return at;
    if (path.dirname(at) === at) return undefined;
  }
}

/** One repository's captures share a scratch object store, kept between
 * calls so each blob is written once, where every call used to write all its
 * modified and untracked files twice into a store of its own. One read runs at
 * a time and serves every call that asked for the tree while it waited.
 * Retired after `SCRATCH_AGE` or a failed read; deleted once no snapshot holds
 * a tree in it. */
class Scratch {
  readonly env: NodeJS.ProcessEnv;
  readonly born = Date.now();
  /** Snapshots holding a tree whose objects live here. */
  users = 0;
  retired = false;
  private created?: Promise<unknown>;
  private reads = 0;
  private running?: Read;
  private next?: Read;
  constructor(readonly repo: Repository, readonly dir: string, private readonly closing: AbortSignal, private readonly settled: () => void) {
    this.env = { GIT_OBJECT_DIRECTORY: path.join(dir, "objects"), GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(repo.objects), GIT_INDEX_FILE: path.join(dir, "index") };
  }
  get busy(): boolean { return !!(this.running || this.next); }
  /** The working tree as read no earlier than this call: the read already
   * running may have started before the caller's tool ran or finished, so a
   * caller arriving then waits for the next one, shared with later arrivals.
   * A read every caller gave up on is stopped. */
  tree(signal: AbortSignal): Promise<string> {
    let read = this.next;
    if (!read && this.running) {
      const queued: Read = this.next = { waiting: 0, controller: new AbortController(), result: this.running.result.then(() => {}, () => {}).then(() => {
        this.next = undefined; return this.start(queued);
      }) };
      read = queued;
    }
    if (!read) { read = { waiting: 0, controller: new AbortController() } as Read; this.start(read); }
    // A queued read its earlier callers gave up on has not started; it can still serve this one.
    if (read.controller.signal.aborted && read === this.next) read.controller = new AbortController();
    read.waiting++;
    return until(read.result, signal).catch(error => {
      if (signal.aborted && --read.waiting === 0) read.controller.abort();
      throw error;
    });
  }
  private start(read: Read): Promise<string> {
    const signal = AbortSignal.any([this.closing, read.controller.signal]);
    this.running = read;
    // An index of its own: an aborted read's Git may still be exiting while the next one starts.
    const env = { ...this.env, GIT_INDEX_FILE: path.join(this.dir, `index-${++this.reads}`) };
    read.result = capturePool.run(signal, async () => {
      await (this.created ??= mkdir(path.join(this.dir, "objects"), { recursive: true, mode: 0o700 }));
      try {
        await this.seed(env.GIT_INDEX_FILE);
        await git(this.repo.root, ["add", "-A", "--", "."], env, signal);
        return (await git(this.repo.root, ["write-tree"], env, signal)).trim();
      } finally { await unlink(env.GIT_INDEX_FILE).catch(() => undefined); }
    }).catch(error => { if (!timedOut(error)) this.retired = true; throw error; })
      .finally(() => { if (this.running === read) this.running = undefined; this.settled(); });
    read.result.catch(() => {});
    return read.result;
  }
  /** Both the index and all new blobs/trees stay in scratch storage. The real
   * object store is a read-only alternate, including for linked worktrees.
   * Every read starts from a fresh copy of the real index: one kept from the
   * last read would trust its own stat data, and miss a same-size rewrite that
   * restored the file's mtime within the second its ctime was recorded. */
  private async seed(temp: string): Promise<void> {
    // Keep the real index's mtime (a second early, for rounding): Git rechecks
    // the content of entries as new as the index, so a file rewritten to the
    // same size in one instant is still seen. Read before the copy, so an index
    // replaced meanwhile only makes more entries racy. An epoch mtime instead
    // made every tracked file racy, and rehashing them all overran the budget
    // on a busy machine (about 3 s for 6,000 files).
    const index = this.repo.index;
    const real = await stat(index).catch(error => { if (error.code !== "ENOENT") throw error; return undefined; });
    if (real && await copyFile(index, temp).then(() => true, error => { if (error.code !== "ENOENT") throw error; return false; })) {
      await utimes(temp, real.atimeMs / 1000, real.mtimeMs / 1000 - 1);
    }
  }
}
const SCRATCH_AGE = 10 * 60_000;
const REPOSITORY_TTL = 5 * 60_000;

const NO_DIFF = ["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
async function treeDiff(root: string, before: string, after: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<ChangedFile[]> {
  if (before === after) return [];
  const records = (await git(root, [...NO_DIFF, "--name-status", "-z", before, after], env, signal)).split("\0");
  const files: ChangedFile[] = [];
  for (let i = 0; i + 1 < records.length; i += 2) {
    const status = records[i].slice(0, 1), original = records[i + 1]; let file = original;
    if (/[RC]/.test(status)) file = records[++i + 1]; // the new name follows the old
    if (!file) continue;
    if (files.length >= 40) throw new BridgeError(413, "This tool changed more than 40 files; open repository Changes for the full status.", { code: "git-output-limit" });
    const specs = [...new Set([original, file])].map(name => `:(literal)${name}`);
    const counts = (await git(root, [...NO_DIFF, "--numstat", before, after, "--", ...specs], env, signal)).split("\t");
    const binary = counts[0] === "-" || counts[1] === "-";
    const redacted = secretName(original) || secretName(file) || binary;
    let overflowed = false;
    let patch = redacted ? "" : await git(root, [...NO_DIFF, before, after, "--", ...specs], env, signal).catch(error => {
      // One patch past Git's output buffer is shown truncated, not as a failed capture.
      const failure = error as { code?: string; stdout?: string };
      if (failure.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw error;
      overflowed = true; return String(failure.stdout ?? "");
    });
    const truncated = overflowed || patch.length > 200_000;
    if (truncated) patch = patch.slice(0, 200_000) + "\n… (truncated)\n";
    const added = Number(counts[0]) || 0, removed = Number(counts[1]) || 0;
    files.push({ root, path: file, status, patch, added, removed, binary, truncated, ...(redacted ? { redacted: true } : {}) });
  }
  return files;
}

/** `taking` until its trees are all read: a PostToolUse arriving before then
 * (its PreToolUse callback gave up, so the tool ran meanwhile) has no true
 * before-state to diff against. */
interface Tree { scratch: Scratch; hash?: string }
interface Snapshot { at: number; conversation: string; own: Set<string>; trees: Map<string, Tree>; roots: string[]; result?: Promise<ChangedFile[]>; expiry?: NodeJS.Timeout; taking?: boolean; dropped?: boolean }
/** Files one tool call named in its own input (an Edit's file_path, a patch's
 * headers), from its start to its end. Another conversation's claim over a
 * file keeps that file out of a shell call's diff taken over the same time. */
interface Claim { conversation: string; toolUseId: string; paths: Set<string>; start: number; end?: number }
const CLAIM_RETENTION = 10 * 60_000;

/** The real path of a file that may not exist yet: its folder's real path plus its name. */
async function realPathOf(file: string): Promise<string> {
  return realpath(file).catch(async () => path.join(await realpath(path.dirname(file)).catch(() => path.dirname(file)), path.basename(file)));
}

/** The files a call names in its structured input, never the words of a command line. */
export function claimedPaths(input: Json, cwd: string, home = homeDir()): string[] {
  const found = new Set<string>();
  for (const value of [input.file_path, input.path, input.notebook_path,
    ...((Array.isArray(input.replacements) ? input.replacements : []).map(v => object(v).filePath))]) {
    if (typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0")) found.add(value);
  }
  const patch = [input.patch, input.input].filter((v): v is string => typeof v === "string").join("\n").slice(0, 262144);
  for (const match of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) {
    const value = (match[1] ?? match[2]).trim(); if (value && value.length <= 4096 && !value.includes("\0")) found.add(value);
    if (found.size >= 48) break;
  }
  return [...found].map(value => value === "~" || value.startsWith("~/") ? path.join(home, value.slice(1)) : path.resolve(cwd, value));
}
const PENDING_FOR = 6_000;
const BUDGET = 2_500;
const DAY = 86_400_000;

/** Remove old records first, then oldest records until within the disk budget. */
export async function pruneChanges(now = Date.now()): Promise<void> {
  const dir = path.join(bridgeRoot(), "changes");
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const file = path.join(dir, entry.name), info = await stat(file).catch(() => undefined);
    if (info) files.push({ file, size: info.size, at: info.mtimeMs });
  }
  files.sort((a, b) => b.at - a.at);
  let size = 0;
  for (const file of files) {
    if (now - file.at > 30 * DAY || size + file.size > 268_435_456) await unlink(file.file).catch(() => undefined);
    else size += file.size;
  }
  // Scratch a stopped Hook left behind; a live one is rewritten on every read
  // and retired within SCRATCH_AGE of its first.
  const scratch = path.join(bridgeRoot(), "changes-scratch");
  for (const entry of await readdir(scratch, { withFileTypes: true }).catch(() => [])) {
    const dir = path.join(scratch, entry.name), info = await stat(dir).catch(() => undefined);
    if (info && now - info.mtimeMs > DAY) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function startChangeRetention(): Promise<() => void> {
  await pruneChanges();
  const timer = setInterval(async () => { countTick("change-retention"); await pruneChanges().catch(() => {}); }, DAY);
  timer.unref();
  return () => clearInterval(timer);
}

interface CachedChanges { files: Map<string, ChangedFile[]>; loaded?: Promise<void> }

/** Snapshots live only around a shell call. Persisted results are validated
 * when loaded; the LRU retains at most 16 conversations, including loads. */
export class ToolChanges {
  /** Called after a non-empty change event is recorded, so modules that follow
   * file changes (the code index) can react without polling. */
  onRecord?: (files: ChangedFile[]) => void;
  private snapshots = new Map<string, Snapshot>();
  private results = new Map<string, CachedChanges>();
  private controllers = new Set<AbortController>();
  private claims: Claim[] = [];
  private failures = new Map<string, Error>();
  /** Conversation and repository root pairs already shown that Git could not capture changes. */
  private reported = new Set<string>();
  private repositories = new Map<string, { at: number; lookup: Lookup }>();
  private scratches = new Map<string, Scratch>();
  private closing = new AbortController();
  /** The failure to show on this call's row, if any. A capture that ran out of
   * time shows no changes rather than an error: a busy machine is not
   * something to act on per call, and repository Changes still has the
   * status. A broken capture (Git missing, a corrupt repository) shows on the
   * first call it hits in a conversation, not on every later one. A per-call
   * limit (too many files) shows on its own call. */
  private failed(conversation: string, key: string, error: unknown, roots: readonly string[] = []): Error | undefined {
    if (timedOut(error)) return undefined;
    const failure = error instanceof BridgeError ? error : new BridgeError(503, "Git change capture failed. Refresh repository Changes for the current status.", { code: "git-capture-failed" });
    if (failure.details?.code === "git-capture-failed") {
      // A breakage is news once per repository: a healthy checkout's capture
      // must not let a corrupt sibling repo report its error again.
      const marks = roots.length ? [...new Set(roots)].map(root => `${conversation}\0${root}`) : [`${conversation}\0`];
      if (marks.every(mark => this.reported.has(mark))) return undefined;
      for (const mark of marks) {
        if (this.reported.size >= 512) this.reported.delete(this.reported.keys().next().value!);
        this.reported.add(mark);
      }
    }
    if (this.failures.size >= 512) this.failures.delete(this.failures.keys().next().value!);
    this.failures.set(key, failure);
    return failure;
  }
  /** A hook callback's wall-clock cap on Git work; past it the call records
   * no change. Tests about what is captured raise it, since a loaded Windows
   * runner's Git can take longer than a person's machine ever does. */
  private readonly budgetMs: number;
  constructor(options: { budgetMs?: number } = {}) { this.budgetMs = options.budgetMs ?? BUDGET; }

  private file(conversation: string) { return path.join(bridgeRoot(), "changes", conversation.replace(/[^A-Za-z0-9._-]/g, "_") + ".jsonl"); }
  private async budget<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController(); this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.budgetMs);
    try { return await work(controller.signal); }
    catch (error) { throw controller.signal.aborted ? new CaptureTimeout() : error; }
    finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
  private async discard(snapshot: Snapshot) {
    clearTimeout(snapshot.expiry);
    const trees = [...snapshot.trees.values()]; snapshot.trees.clear();
    for (const tree of trees) { tree.scratch.users--; await this.sweep(tree.scratch); }
  }
  async close() {
    for (const controller of this.controllers) controller.abort();
    for (const { lookup } of this.repositories.values()) lookup.controller.abort();
    this.repositories.clear();
    this.closing.abort();
    for (const snapshot of this.snapshots.values()) { await snapshot.result?.catch(() => {}); await this.discard(snapshot); }
    this.snapshots.clear();
    for (const scratch of this.scratches.values()) scratch.retired = true;
    await Promise.all([...this.scratches.values()].map(scratch => this.sweep(scratch)));
  }

  /** The repository holding `target` (a file, a folder, or something not yet
   * created), confined to the user's home; undefined otherwise. Git is asked
   * once per checkout every few minutes, not once per path a command names. */
  private async repositoryOf(target: string, cwd: string, signal: AbortSignal, home = homeDir()): Promise<Repository | undefined> {
    const absolute = target === "~" || target.startsWith("~/") ? path.join(home, target.slice(1)) : path.resolve(cwd, target);
    let existing = absolute;
    while (!(await stat(existing).catch(() => undefined))) {
      const parent = path.dirname(existing); if (parent === existing) return undefined;
      existing = parent;
    }
    const real = await realpath(existing);
    home = await realpath(home);
    if (real !== home && !real.startsWith(home + path.sep)) return undefined;
    const dir = (await stat(real)).isDirectory() ? real : path.dirname(real), checkout = await checkoutOf(dir);
    if (!checkout) return undefined;
    const now = Date.now(), known = this.repositories.get(checkout);
    // A lookup every caller gave up on is not reused: a new call starts a fresh one.
    if (known && now - known.at < REPOSITORY_TTL && !known.lookup.controller.signal.aborted) return this.awaitRepository(known.lookup, signal);
    if (this.repositories.size >= 256) this.repositories.clear();
    // The lookup belongs to the repository, not to whichever call asked first:
    // it stops only once every call waiting for it has given up.
    const lookup: Lookup = { waiting: 0, controller: new AbortController(), result: Promise.resolve(undefined) };
    this.repositories.set(checkout, { at: now, lookup });
    // Asked from the target's own folder, so Git's discovery limits (GIT_CEILING_DIRECTORIES) still apply.
    const repository = capturePool.run(lookup.controller.signal, async () => {
      const [root, objects, index] = (await git(dir, ["rev-parse", "--show-toplevel", "--git-path", "objects", "--git-path", "index"], {}, lookup.controller.signal)).split(/\r?\n/);
      return { root: await realpath(root), objects: await realpath(path.resolve(dir, objects)), index: path.resolve(dir, index) };
    }).catch(error => {
      if (/not a git repository/.test(String((error as { stderr?: string }).stderr))) return undefined;
      // Asked again next time rather than remembered.
      if (this.repositories.get(checkout)?.lookup === lookup) this.repositories.delete(checkout);
      throw error;
    });
    lookup.result = repository;
    repository.catch(() => {});
    return this.awaitRepository(lookup, signal);
  }

  /** Wait for a shared repository lookup, dropping this caller's interest when
   * it gives up; the lookup is stopped only when no caller is left. */
  private awaitRepository(lookup: Lookup, signal: AbortSignal): Promise<Repository | undefined> {
    lookup.waiting++;
    return until(lookup.result, signal).finally(() => {
      if (--lookup.waiting === 0 && signal.aborted) lookup.controller.abort();
    });
  }

  /** The scratch a new snapshot of `repository` reads into. */
  private scratchFor(repository: Repository): Scratch {
    const now = Date.now();
    for (const scratch of this.scratches.values()) {
      if (scratch.retired || now - scratch.born > SCRATCH_AGE) { scratch.retired = true; void this.sweep(scratch); }
    }
    const current = this.scratches.get(repository.root);
    if (current && !current.retired) return current;
    const dir = path.join(bridgeRoot(), "changes-scratch", `repo-${randomBytes(8).toString("hex")}`);
    const scratch: Scratch = new Scratch(repository, dir, this.closing.signal, () => void this.sweep(scratch));
    this.scratches.set(repository.root, scratch);
    return scratch;
  }
  /** Delete a retired scratch once nothing reads it or holds a tree in it. */
  private async sweep(scratch: Scratch): Promise<void> {
    if (!scratch.retired || scratch.users > 0 || scratch.busy) return;
    if (this.scratches.get(scratch.repo.root) === scratch) this.scratches.delete(scratch.repo.root);
    await rm(scratch.dir, { recursive: true, force: true }).catch(() => undefined);
  }

  async before(conversation: string, toolUseId: string, cwd: string, command: string, input: Json = {}): Promise<void> {
    const key = `${conversation}\0${toolUseId}`;
    if (!toolUseId) return;
    // Real paths, like the repository roots the diff reports (/var → /private/var).
    const claimed = await Promise.all(claimedPaths(input, cwd).map(realPathOf));
    this.claim(conversation, toolUseId, claimed);
    if (this.snapshots.size >= 64 || this.snapshots.has(key)) return;
    const snapshot: Snapshot = { at: Date.now(), conversation, own: new Set(claimed), trees: new Map(), roots: [], taking: true };
    this.snapshots.set(key, snapshot);
    try {
      await this.budget(async signal => {
        await realpath(cwd); // A vanished checkout must not resolve to its parent repository.
        const repositories = new Map<string, Repository>();
        for (const target of [cwd, phrenStoreRoot(), ...namedPaths(command, input)]) {
          signal.throwIfAborted();
          if (repositories.size >= 6) break;
          const repository = await this.repositoryOf(target, cwd, signal); if (repository) repositories.set(repository.root, repository);
        }
        snapshot.roots = [...repositories.keys()];
        await Promise.all([...repositories.values()].map(async repository => {
          const tree: Tree = { scratch: this.scratchFor(repository) };
          tree.scratch.users++; snapshot.trees.set(repository.root, tree);
          tree.hash = await tree.scratch.tree(signal);
        }));
        signal.throwIfAborted();
      });
      snapshot.taking = false;
      if (snapshot.dropped) { await this.discard(snapshot); return; }
      if (!snapshot.trees.size) { this.snapshots.delete(key); return; }
      // A missing PostToolUse/reader cannot retain untracked contents forever.
      snapshot.expiry = setTimeout(() => {
        if (!snapshot.result) { this.snapshots.delete(key); void this.discard(snapshot).catch(() => {}); }
      }, 30 * 60_000);
      snapshot.expiry.unref();
    } catch (error) { this.failed(conversation, key, error, snapshot.roots); if (this.snapshots.get(key) === snapshot) this.snapshots.delete(key); await this.discard(snapshot); }
  }

  /** Forget the snapshot of a tool call whose PreToolUse callback gave up
   * before the snapshot was taken: the tool may have run while it was read,
   * so no diff is shown for that call rather than a wrong one. */
  drop(conversation: string, toolUseId: string): void {
    const key = `${conversation}\0${toolUseId}`, snapshot = this.snapshots.get(key);
    if (!snapshot || snapshot.result) return;
    this.snapshots.delete(key);
    if (snapshot.taking) snapshot.dropped = true;
    else void this.discard(snapshot).catch(() => {});
  }

  private claim(conversation: string, toolUseId: string, paths: string[]) {
    const now = Date.now();
    this.claims = this.claims.filter(claim => claim.end === undefined ? now - claim.start < 30 * 60_000 : now - claim.end < CLAIM_RETENTION);
    if (paths.length && this.claims.length < 512) this.claims.push({ conversation, toolUseId, paths: new Set(paths), start: now });
  }
  /** Whether another conversation's call named this file while `snapshot` ran. */
  private claimedElsewhere(snapshot: Snapshot, file: string, until: number): boolean {
    return this.claims.some(claim => claim.conversation !== snapshot.conversation && claim.paths.has(file)
      && claim.start <= until && (claim.end ?? until) >= snapshot.at);
  }

  async after(conversation: string, toolUseId: string): Promise<void> {
    const key = `${conversation}\0${toolUseId}`, snapshot = this.snapshots.get(key);
    for (const claim of this.claims) if (claim.conversation === conversation && claim.toolUseId === toolUseId) claim.end ??= Date.now();
    if (!snapshot) return;
    if (snapshot.taking) { this.drop(conversation, toolUseId); return; }
    snapshot.result ??= this.compute(snapshot);
    let files: ChangedFile[];
    try { files = await snapshot.result; }
    catch (error) {
      if (this.snapshots.get(key) === snapshot) { this.snapshots.delete(key); this.failed(conversation, key, error, snapshot.roots); }
      const failure = this.failures.get(key);
      if (failure) throw failure;
      return;
    }
    if (this.snapshots.get(key) === snapshot) {
      this.snapshots.delete(key); await this.record(conversation, toolUseId, files);
      // Capture works again for these repositories: a later breakage there is news worth one more row.
      for (const root of snapshot.roots) this.reported.delete(`${conversation}\0${root}`);
    }
  }
  private async compute(snapshot: Snapshot): Promise<ChangedFile[]> {
    try {
      return await this.budget(async signal => {
        const trees = [...snapshot.trees.entries()];
        const after = await Promise.all(trees.map(([, tree]) => tree.scratch.tree(signal)));
        const files = await capturePool.run(signal, async () => {
          const found: ChangedFile[] = [];
          for (const [i, [root, tree]] of trees.entries()) found.push(...await treeDiff(root, tree.hash!, after[i], tree.scratch.env, signal));
          return found;
        });
        // A file another agent's edit named during this call is its change,
        // not this call's, even though it landed inside the same window.
        // A call that names its files (an Edit, a Write, a patch) changed
        // only those, whatever else moved in the repository meanwhile.
        const until = Date.now();
        const kept: ChangedFile[] = [];
        for (const file of files) {
          // Both sides as real paths: a root reported through a symlinked
          // folder (/var on macOS) still matches the call's own claim.
          const absolute = await realPathOf(path.resolve(file.root, file.path));
          if (snapshot.own.size ? snapshot.own.has(absolute) : !this.claimedElsewhere(snapshot, absolute, until)) kept.push(file);
        }
        return kept;
      });
    } finally { await this.discard(snapshot); }
  }
  private cache(conversation: string): CachedChanges {
    const entry = this.results.get(conversation) ?? { files: new Map<string, ChangedFile[]>() };
    this.results.delete(conversation); this.results.set(conversation, entry);
    while (this.results.size > 16) this.results.delete(this.results.keys().next().value!);
    return entry;
  }
  private async load(conversation: string): Promise<CachedChanges> {
    const entry = this.cache(conversation);
    entry.loaded ??= (async () => {
      const file = this.file(conversation);
      const size = (await stat(file).catch(() => undefined))?.size ?? 0;
      const text = size <= 16_777_216 ? await readFile(file, "utf8").catch(() => "") : "";
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          const row = changeRowSchema.parse(JSON.parse(line));
          // Also sanitize old records made before patch redaction existed.
          entry.files.set(row.toolUseId, row.files.map(file => secretName(file.path) || file.redacted || /^(?:Binary files |GIT binary patch)/m.test(file.patch)
            ? { ...file, patch: "", redacted: true } : file));
        } catch { /* Torn or invalid rows are not transcript events. */ }
      }
    })();
    await entry.loaded;
    return entry;
  }
  private async record(conversation: string, toolUseId: string, files: ChangedFile[]) {
    (await this.load(conversation)).files.set(toolUseId, files);
    if (!files.length) return;
    const file = this.file(conversation);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const size = (await stat(file).catch(() => undefined))?.size ?? 0;
    const line = JSON.stringify({ toolUseId, files }) + "\n";
    if (size + Buffer.byteLength(line) <= 16_777_216) await appendFile(file, line, { mode: 0o600 });
    this.onRecord?.(files);
  }
  /** Every change this conversation's tool calls recorded, oldest first. */
  async history(conversation: string): Promise<{ toolUseId: string; files: ChangedFile[] }[]> {
    return [...(await this.load(conversation)).files.entries()].filter(([, files]) => files.length).map(([toolUseId, files]) => ({ toolUseId, files }));
  }
  async recordedPaths(conversation: string): Promise<string[]> {
    return [...new Set([...(await this.load(conversation)).files.values()].flatMap(files => files.flatMap(file => [file.root, path.resolve(file.root, file.path)])))];
  }
  view(conversation: string): ChangeLookup {
    return {
      pending: toolUseId => {
        const snapshot = this.snapshots.get(`${conversation}\0${toolUseId}`);
        return !!snapshot && !snapshot.result && Date.now() - snapshot.at < PENDING_FOR;
      },
      changes: async toolUseId => {
        const failure = this.failures.get(`${conversation}\0${toolUseId}`);
        if (failure) throw failure;
        await this.after(conversation, toolUseId);
        const known = (await this.load(conversation)).files.get(toolUseId);
        return known?.length ? known : undefined;
      },
    };
  }
}

export interface ChangeLookup {
  pending(toolUseId: string): boolean;
  changes(toolUseId: string): Promise<ChangedFile[] | undefined>;
}

/** The tool calls whose output a transcript row carries. */
export function outputCallIds(raw: Json, source: string): string[] {
  const ids = (value: unknown) => typeof value === "string" && value ? [value] : [];
  if (source === "codex") {
    const p = (raw.payload ?? {}) as Json;
    return ["function_call_output", "custom_tool_call_output"].includes(String(p.type)) ? ids(p.call_id) : [];
  }
  if (source === "copilot") return raw.type === "tool.execution_complete" ? ids(((raw.data ?? {}) as Json).toolCallId) : [];
  const message = (source === "phren" || source === "opencode" ? ((raw.data ?? {}) as Json).message : raw.message) as Json | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap(block => block && typeof block === "object" && (block as Json).type === "tool_result" ? ids((block as Json).tool_use_id) : []);
}

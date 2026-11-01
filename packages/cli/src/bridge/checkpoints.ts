/** Files-only turn checkpoints. Private, parentless commits never move the user's refs/index. */
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, rmdirSync, unlinkSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { lstat, mkdtemp, open, readlink, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { checkoutGitEnv } from "./projects.js";
import { BridgeError, type Json, type Target } from "./protocol.js";
import { readTurn, turnPhase } from "./turn-records.js";
import { ownRecord, liveBackground } from "./session-activity.js";
import { readFinalTurn } from "./schedule-watch.js";
import { childAgentTree, runningChildAgents } from "./transcripts.js";

// A callback can arrive while restore awaits an old disk record. Invalidate synchronously,
// before callback placement/status/record I/O; daemon callbacks already name their true session.
const activityGenerations = new Map<string, number>();
let activityClock = 0;
const activityKeys = (target: Target) => [`pane:${target.server}:${target.pane}`, `session:${target.source}:${target.session}`];
export function checkpointActivityArrived(target: Target): void {
  const generation = ++activityClock;
  // Pane identity also covers a new conversation taking over; session identity covers daemon placement.
  for (const key of activityKeys(target)) activityGenerations.set(key, generation);
}
const activityGeneration = (target: Target) => Math.max(...activityKeys(target).map(key => activityGenerations.get(key) ?? 0));

const exec = promisify(execFile);
const LIMIT = 50;
const secret = randomBytes(32);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const rowSchema = z.object({ id: z.string().uuid(), turn: z.number().int().nonnegative(),
  boundary: z.enum(["prompt", "stop", "recovery"]), at: z.string().datetime(), prompt: z.string().max(240), filesChanged: z.number().int().nonnegative(),
  promptEntryId: z.string().min(1).max(256).optional() });
export type CheckpointRow = z.infer<typeof rowSchema>;
type FileChange = { path: string; status: "A" | "M" | "D" };
type Context = {
  root: string; dir: string; prefix: string;
  check: () => void;
  run: (...args: string[]) => Promise<string>;
  input: (index: string | undefined, args: string[], input: string | Buffer) => Promise<string>;
  bytes: (oid: string) => Promise<Buffer>;
  private: (index: string, ...args: string[]) => Promise<string>;
};

function conflict(code: string, message: string): never { throw new BridgeError(409, message, { code }); }
function safePath(file: string): void {
  if (!file || file.length > 4096 || path.isAbsolute(file) || path.win32.isAbsolute(file) || file.includes("\\") || file.includes("\0") || file.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    conflict("checkpoint-unsafe-path", "The checkpoint contains an unsafe path.");
  }
}
async function context(cwd: string, target: Target, budget = 15_000): Promise<Context> {
  const deadline = performance.now() + budget;
  const runEnv = async (root: string, extra: NodeJS.ProcessEnv, ...args: string[]) => {
    const left = Math.floor(deadline - performance.now());
    if (left <= 0) throw new Error("Checkpoint time budget exceeded");
    return (await exec("git", ["-C", root, "--no-pager", ...args], { env: { ...checkoutGitEnv(), ...extra }, timeout: left, killSignal: "SIGKILL", maxBuffer: 8_388_608 })).stdout;
  };
  const runAt = (root: string, ...args: string[]) => runEnv(root, {}, ...args);
  let root: string, dir: string, common: string;
  try {
    root = await realpath((await runAt(cwd, "rev-parse", "--show-toplevel")).trimEnd());
    dir = await realpath((await runAt(root, "rev-parse", "--absolute-git-dir")).trimEnd());
    common = await realpath(path.resolve(root, (await runAt(root, "rev-parse", "--git-common-dir")).trimEnd()));
  } catch (error) {
    if (String((error as { stderr?: string }).stderr).includes("not a git repository")) conflict("checkpoint-not-isolated", "Checkpoints require a linked Git worktree.");
    throw error;
  }
  if (!(await lstat(path.join(root, ".git"))).isFile() || path.dirname(dir) !== path.join(common, "worktrees")) {
    conflict("checkpoint-not-isolated", "Checkpoints require a linked Git worktree.");
  }
  const check = () => { if (performance.now() >= deadline) throw new Error("Checkpoint time budget exceeded"); };
  return { check, root, dir, prefix: `refs/phren/checkpoints/${hash(root)}/${hash(`${target.source}:${target.session}`)}/`, run: (...args) => runAt(root, ...args),
    input: (index, args, input) => new Promise<string>((resolve, reject) => {
      const left = Math.floor(deadline - performance.now());
      if (left <= 0) { reject(new Error("Checkpoint time budget exceeded")); return; }
      const child = execFile("git", ["-C", root, ...args], { env: { ...checkoutGitEnv(), ...(index ? { GIT_INDEX_FILE: index } : {}) }, timeout: left, killSignal: "SIGKILL", maxBuffer: 8_388_608 },
        (error, stdout) => error ? reject(error) : resolve(stdout));
      child.stdin!.on("error", () => {}); child.stdin!.end(input);
    }),
    bytes: async oid => { check(); return (await exec("git", ["-C", root, "cat-file", "blob", oid], { env: checkoutGitEnv(), encoding: "buffer", timeout: Math.max(1, Math.floor(deadline - performance.now())), maxBuffer: 8_388_608 })).stdout; },
    private: (index, ...args) => runEnv(root, { GIT_INDEX_FILE: index }, "-c", "core.fsmonitor=false", ...args) };
}

async function locked<T>(ctx: Context, action: () => Promise<T>): Promise<T> {
  const file = path.join(ctx.dir, "phren-checkpoint.lock");
  const lock = await open(file, "wx", 0o600).catch(() => conflict("checkpoint-busy", "Another checkpoint operation is running."));
  try { return await action(); } finally { await lock.close(); await rm(file, { force: true }); }
}

async function rows(ctx: Context): Promise<CheckpointRow[]> {
  const raw = await ctx.run("for-each-ref", "--format=%(contents:subject)", ctx.prefix);
  return raw.split("\n").filter(Boolean).map(line => rowSchema.parse(JSON.parse(line))).sort((a, b) => a.at.localeCompare(b.at) || a.turn - b.turn);
}
async function tree(ctx: Context): Promise<string> {
  const temp = await mkdtemp(path.join(ctx.dir, "phren-checkpoint-"));
  try {
    const index = path.join(temp, "index");
    // Read only index membership, never its cached blobs/flags, and hash raw bytes without clean filters or CRLF conversion.
    const names = [...new Set((await ctx.run("ls-files", "--cached", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean))];
    const regular: Array<{ file: string; mode: string }> = [], records: string[] = [];
    for (const file of names) {
      ctx.check();
      safePath(file);
      if (nonDirectoryParent(ctx.root, file)) continue; // A tracked directory was replaced by a file/symlink.
      validateParents(ctx.root, file, []);
      const info = await lstat(path.join(ctx.root, file)).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
      if (!info) continue;
      if (info.isSymbolicLink()) {
        const oid = (await ctx.input(undefined, ["hash-object", "-w", "--stdin"], await readlink(path.join(ctx.root, file)))).trim();
        records.push(`120000 ${oid}\t${file}\0`);
      } else if (info.isFile()) regular.push({ file, mode: info.mode & 0o111 ? "100755" : "100644" });
      else conflict("checkpoint-unsupported-tree", "Checkpoints do not support submodules or nested Git repositories.");
    }
    if (regular.length) {
      // Git's stdin-paths accepts C-quoted UTF-8 byte strings, including tabs/newlines in filenames.
      const quoted = regular.map(({ file }) => '"' + [...Buffer.from(file)].map(byte => "\\" + byte.toString(8).padStart(3, "0")).join("") + '"').join("\n") + "\n";
      const oids = (await ctx.input(undefined, ["hash-object", "-w", "--no-filters", "--stdin-paths"], quoted)).trim().split("\n");
      regular.forEach(({ file, mode }, i) => records.push(`${mode} ${oids[i]}\t${file}\0`));
    }
    await ctx.private(index, "read-tree", "--empty");
    await ctx.input(index, ["update-index", "-z", "--index-info"], records.join(""));
    const result = (await ctx.private(index, "write-tree")).trim();
    return result;
  } finally { await rm(temp, { recursive: true, force: true }); }
}

async function changes(ctx: Context, from: string, to: string): Promise<FileChange[]> {
  const tokens = (await ctx.run("diff-tree", "--no-commit-id", "--no-renames", "--name-status", "-r", "-z", from, to)).split("\0");
  const files: FileChange[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const file = tokens[i + 1]; safePath(file);
    files.push({ path: file, status: tokens[i] === "A" ? "A" : tokens[i] === "D" ? "D" : "M" });
  }
  return files;
}
async function save(ctx: Context, current: string, meta: Omit<CheckpointRow, "id" | "filesChanged">, force = false): Promise<CheckpointRow> {
  const previous = await rows(ctx), last = previous.at(-1);
  if (!force && last && (await ctx.run("rev-parse", `${ctx.prefix}${last.id}^{tree}`)).trim() === current) return last;
  const base = last ? `${ctx.prefix}${last.id}` : "HEAD";
  const row: CheckpointRow = { ...meta, id: randomUUID(), filesChanged: (await changes(ctx, base, current)).length };
  // Parentless: pruning a ref also makes that snapshot collectable, even when later snapshots survive.
  const commit = (await ctx.run("-c", "user.name=Phren checkpoint", "-c", "user.email=checkpoint@phren.local", "commit-tree", current, "-m", JSON.stringify(row))).trim();
  const prune = previous.slice(0, Math.max(0, previous.length + 1 - LIMIT));
  await ctx.input(undefined, ["update-ref", "--stdin"], `start\ncreate ${ctx.prefix}${row.id} ${commit}\n${prune.map(old => `delete ${ctx.prefix}${old.id}\n`).join("")}prepare\ncommit\n`);
  return row;
}

/** Budget includes all Git subprocesses; a failed/slow capture never fails the lifecycle callback. */
let warned = false;
const prompts = new Map<string, { turn: number; text: string }>();
export async function checkpointBoundary(cwd: string, target: Target, event: string, turn: number, prompt = "", promptEntryId?: string): Promise<void> {
  if (event !== "UserPromptSubmit" && event !== "Stop") return;
  try {
    const ctx = await context(cwd, target, 300);
    if (event === "UserPromptSubmit") {
      prompts.delete(ctx.prefix);
      prompts.set(ctx.prefix, { turn, text: prompt.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 240) });
      if (prompts.size > 256) prompts.delete(prompts.keys().next().value!);
    }
    const identity = event === "UserPromptSubmit" ? promptEntryId : undefined;
    await locked(ctx, async () => {
      const previous = await rows(ctx), last = previous.at(-1);
      const remembered = prompts.get(ctx.prefix);
      const excerpt = remembered?.turn === turn ? remembered.text : last?.turn === turn ? last.prompt : "";
      await save(ctx, await tree(ctx), { turn, boundary: event === "Stop" ? "stop" : "prompt", at: new Date().toISOString(),
        prompt: excerpt, ...(identity ? { promptEntryId: identity } : {}) }, Boolean(identity));
    });
  } catch (error) {
    if (error instanceof BridgeError && ["checkpoint-not-isolated", "checkpoint-busy"].includes(String(error.details?.code))) return;
    if (!warned) { warned = true; console.warn("[phren-hook] Checkpoint capture skipped (failed or exceeded its 300 ms budget)."); }
  }
}

async function idle(target: Target, readPane: () => Promise<Json>): Promise<void> {
  const pane = await readPane();
  const record = ownRecord(await readTurn(target.server, target.pane), pane, target.source, target.session);
  const phase = record && turnPhase(record);
  const [background, children] = await Promise.all([
    liveBackground(record, readFinalTurn),
    childAgentTree(target.source, target.session).then(runningChildAgents),
  ]);
  if (!["idle", "done"].includes(String(pane.agent_status)) || phase?.phase === "working" || background || children.length) {
    conflict("checkpoint-working", "The agent is working. Wait for it to stop before restoring files.");
  }
}
function token(ctx: Context, id: string, current: string): string {
  return createHash("sha256").update(secret).update(`${ctx.prefix}\0${id}\0${current}`).digest("hex");
}
async function selected(ctx: Context, value: unknown): Promise<CheckpointRow> {
  const id = z.string().uuid().parse(value);
  const row = (await rows(ctx)).find(row => row.id === id);
  if (!row) throw new BridgeError(404, "That checkpoint is no longer available.", { code: "checkpoint-not-found" });
  return row;
}

/** Only the pane's own checkout and conversation; child/worktree selectors are deliberately excluded. */
export async function checkpointRoute(cwd: string, target: Target, action: string, data: Record<string, unknown>, readPane: () => Promise<Json>): Promise<unknown> {
  try { return await handleCheckpointRoute(cwd, target, action, data, readPane); }
  catch (error) {
    if (error instanceof BridgeError || error instanceof z.ZodError) throw error;
    const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
    if (failure.killed || failure.signal || /time budget/.test(String(error))) throw new BridgeError(504, "Checkpoint preparation exceeded its time budget.", { code: "checkpoint-timeout" });
    if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new BridgeError(413, "Checkpoint output exceeded its size limit.", { code: "checkpoint-output-limit" });
    throw new BridgeError(503, "Checkpoint preparation failed. Retry when the repository is idle.", { code: "checkpoint-failed" });
  }
}

async function handleCheckpointRoute(cwd: string, target: Target, action: string, data: Record<string, unknown>, readPane: () => Promise<Json>): Promise<unknown> {
  const generation = activityGeneration(target);
  let ctx: Context;
  try { ctx = await context(cwd, target); }
  catch (error) {
    if (action === "list" && error instanceof BridgeError && error.details?.code === "checkpoint-not-isolated") return { state: "not-isolated", checkpoints: [], limit: LIMIT };
    throw error;
  }
  return locked(ctx, async () => {
    if (action === "list") return { state: "ready", repository: ctx.root, checkpoints: (await rows(ctx)).reverse(), limit: LIMIT };
    if (!["preview", "restore"].includes(action)) throw new BridgeError(404, "Unknown checkpoint route.");
    const row = await selected(ctx, data.checkpointId);
    const current = await tree(ctx), destination = (await ctx.run("rev-parse", `${ctx.prefix}${row.id}^{tree}`)).trim();
    const files = await changes(ctx, current, destination);
    if (action === "preview") return { state: "ready", checkpointId: row.id, repository: ctx.root, files, token: token(ctx, row.id, current) };
    await idle(target, readPane);
    if (typeof data.token !== "string" || data.token !== token(ctx, row.id, current)) conflict("checkpoint-stale", "Files changed since the preview. Preview the restore again.");
    const recovery = await save(ctx, current, { boundary: "recovery", turn: row.turn, prompt: "Before restore", at: new Date().toISOString() }, true);
    // Materialize all destination blobs before changing anything; no filters, hooks or user index.
    const entries = (await ctx.run("ls-tree", "-r", "-z", destination)).split("\0").filter(Boolean);
    const blobs = new Map<string, { mode: string; bytes: Buffer }>();
    let blobBytes = 0;
    for (const entry of entries) {
      const tab = entry.indexOf("\t"), file = entry.slice(tab + 1); safePath(file);
      if (!files.some(change => change.path === file && change.status !== "D")) continue;
      const [mode, , oid] = entry.slice(0, tab).split(" ");
      // cat-file's base64-free Buffer path preserves binary file contents.
      const bytes = await ctx.bytes(oid);
      blobBytes += bytes.length;
      if (blobBytes > 64 * 1024 * 1024) throw new BridgeError(413, "Restore exceeds the 64 MiB preparation limit.", { code: "checkpoint-output-limit" });
      blobs.set(file, { mode, bytes });
    }
    const ignored = (await ctx.run("ls-files", "--others", "--ignored", "--exclude-standard", "-z")).split("\0").filter(Boolean);
    for (const change of files) {
      safePath(change.path);
      // Check ignores even for paths tracked at the destination, using --no-index.
      validateParents(ctx.root, change.path, files);
      const excluded = nonDirectoryParent(ctx.root, change.path) ? "" : await ctx.run("check-ignore", "--no-index", "--", change.path).catch(error => {
        if ((error as { code?: number }).code === 1) return "";
        throw error;
      });
      if (excluded || ignored.some(file => file === change.path || file.startsWith(change.path + "/") || change.path.startsWith(file + "/"))) {
        conflict("checkpoint-obstructed", "An ignored file obstructs this restore.");
      }
    }
    // Catch edits during recovery/blob reads and activity arriving during preparation.
    if (await tree(ctx) !== current) conflict("checkpoint-stale", "Files changed since the preview. Preview the restore again.");
    await idle(target, readPane);
    // No await after this comparison: resumed work or an input request wins even if the final read saw an old Stop.
    if (activityGeneration(target) !== generation) conflict("checkpoint-working", "Agent activity arrived. Wait for the agent to stop before restoring files.");
    try { applyFiles(ctx.root, files, blobs); }
    catch { throw new BridgeError(503, "Restore could not finish. Use the recovery checkpoint to recover files.", { code: "checkpoint-restore-failed", recoveryId: recovery.id }); }
    return { ok: true, checkpointId: row.id, recoveryId: recovery.id, files };
  });
}

function nonDirectoryParent(root: string, file: string): boolean {
  const parts = file.split("/");
  for (let i = 1; i < parts.length; i++) {
    const info = stat(path.join(root, ...parts.slice(0, i)));
    if (info && !info.isDirectory()) return true;
  }
  return false;
}
function validateParents(root: string, file: string, changes: FileChange[]): void {
  const parts = file.split("/");
  for (let i = 1; i < parts.length; i++) {
    const parent = parts.slice(0, i).join("/");
    const info = stat(path.join(root, parent));
    if (info && !info.isDirectory()) {
      if (changes.some(change => change.path === parent && change.status === "D")) return;
      conflict("checkpoint-obstructed", "A file or symlink obstructs this restore.");
    }
  }
}
function stat(file: string) { try { return lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return undefined; throw error; } }
function applyFiles(root: string, files: FileChange[], blobs: Map<string, { mode: string; bytes: Buffer }>): void {
  // No await between final guard and these writes: local lifecycle callbacks cannot interleave.
  for (const change of [...files].sort((a, b) => b.path.length - a.path.length)) {
    // An added descendant of a file/symlink being deleted does not yet exist inside the repository.
    if (nonDirectoryParent(root, change.path)) continue;
    const abs = path.join(root, change.path), info = stat(abs);
    if (info && !info.isDirectory()) unlinkSync(abs);
    if (info?.isDirectory()) rmdirSync(abs); // Never recursively delete ignored/unrepresented contents.
    let parent = path.dirname(abs);
    while (parent !== root) { try { rmdirSync(parent); } catch { break; } parent = path.dirname(parent); }
  }
  for (const [file, { mode, bytes }] of blobs) {
    const abs = path.join(root, file); mkdirSync(path.dirname(abs), { recursive: true });
    if (mode === "120000") symlinkSync(bytes.toString("utf8"), abs);
    else { writeFileSync(abs, bytes); chmodSync(abs, mode === "100755" ? 0o755 : 0o644); }
  }
}

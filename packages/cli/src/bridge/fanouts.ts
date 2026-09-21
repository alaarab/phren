import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { ChangedFile } from "./changes.js";
import { type Json, object, type Provider, sessionId } from "./protocol.js";

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_EVENT_LOG_BYTES = 64 * 1024 * 1024;
const MAX_BLOCKED_BYTES = 16 * 1024;
const MAX_JOBS = 128;
/** A finished job is archived once its finish stamp is older than this. */
const ARCHIVE_AGE_MS = 24 * 60 * 60 * 1000;
/** How many folders the archive keeps; the oldest beyond that are deleted. */
export const ARCHIVE_MAX_FOLDERS = 500;
const ARCHIVED_STATUSES = new Set(["completed", "failed", "cancelled"]);
const WORKTREE_CACHE_MS = 15_000;
const exec = promisify(execFile);
const jobID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const timestamp = z.string().datetime({ offset: true });

const opencodeSession = z.string().regex(/^ses_[0-9A-Za-z]{1,64}$/);

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: jobID,
  parent: z.object({
    provider: z.enum(["codex", "claude", "copilot", "phren", "opencode"]),
    session: sessionId,
    computer: z.string().uuid().optional(),
  }).strict().optional(),
  provider: z.enum(["opencode", "codex", "claude"]),
  session: sessionId.optional(),
  taskLabel: z.string().min(1).max(200),
  cwd: z.string().min(1).max(4096).refine(path.isAbsolute),
  worktree: z.string().min(1).max(4096).refine(path.isAbsolute),
  model: z.string().min(1).max(200).optional(),
  eventLog: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.jsonl$/),
  createdAt: timestamp,
  startedAt: timestamp,
  updatedAt: timestamp,
  finishedAt: timestamp.optional(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  exitCode: z.number().int().min(0).max(255).optional(),
  schedule: z.object({ id: z.string().regex(/^[a-f0-9]{8}$/), project: z.string().min(1).max(200) }).optional(),
}).strict().superRefine((manifest, ctx) => {
  // OpenCode sessions are `ses_…`; Codex and Claude sessions are UUIDs.
  // A provider cannot claim another provider's identity shape.
  if (manifest.session === undefined) return;
  const valid = manifest.provider === "opencode" ? opencodeSession.safeParse(manifest.session).success
    : z.string().uuid().safeParse(manifest.session).success;
  if (!valid) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["session"],
    message: `A ${manifest.provider} manifest needs a matching session identity.` });
});

export type FanoutManifest = z.infer<typeof manifestSchema>;

/** What the opencode plugin writes when it refuses a fan-out worker's
 * permission: the ask that was denied, so the Hook can report a worker that
 * exited 0 as blocked rather than finished. */
const blockedSchema = z.object({
  type: z.string().min(1).max(200),
  pattern: z.string().max(2000).optional(),
  message: z.string().max(4000).optional(),
  at: z.string().max(100).optional(),
}).passthrough();
type Blocked = z.infer<typeof blockedSchema>;

export interface FanoutChild {
  /** Parent-scoped opaque ID. Filesystem paths never cross the bridge. */
  id: string;
  provider: "opencode" | "codex" | "claude";
  session?: string;
  /** The model that manifest named, so the phone can label the worker. */
  model?: string;
  worktreeName?: string;
  branch?: string;
  /** The worker's own checkout, kept off the wire. */
  cwd: string;
  path: string;
  callId: string;
  state: "running" | "completed" | "failed";
  /** `blocked: <type> <pattern>` when the plugin refused a permission. */
  reason?: string;
  transcript: string;
  children: FanoutChild[];
}

type WorktreeDetails = Pick<FanoutChild, "worktreeName" | "branch">;
const worktreeCache = new Map<string, { expiresAt: number; details: WorktreeDetails }>();

async function worktreeDetails(worktree: string): Promise<WorktreeDetails> {
  const now = Date.now(), cached = worktreeCache.get(worktree);
  if (cached && cached.expiresAt > now) return cached.details;
  let details: WorktreeDetails = {};
  const metadata = await stat(worktree).catch(() => undefined);
  if (metadata?.isDirectory()) {
    const worktreeName = path.basename(worktree).slice(0, 200);
    details = worktreeName ? { worktreeName } : {};
    try {
      const { stdout } = await exec("git", ["-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"],
        { timeout: 2_000, maxBuffer: 4_096 });
      const branch = stdout.trim();
      if (branch && branch !== "HEAD") details.branch = branch.slice(0, 200);
    } catch { /* Missing repositories, detached heads, and git errors have no public branch. */ }
  }
  worktreeCache.set(worktree, { expiresAt: Date.now() + WORKTREE_CACHE_MS, details });
  while (worktreeCache.size > MAX_JOBS) worktreeCache.delete(worktreeCache.keys().next().value!);
  return details;
}

function storeRoot(env: NodeJS.ProcessEnv): string {
  const configured = env.PHREN_PATH?.trim();
  return !configured ? path.join(homedir(), ".phren")
    : configured === "~" ? homedir() : configured.startsWith("~/") ? path.join(homedir(), configured.slice(2)) : path.resolve(configured);
}

export function fanoutRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(storeRoot(env), ".runtime", "agent-fanouts");
}

/** Where the archive sweep moves finished job folders, same id, one directory over. */
export function fanoutArchiveRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(storeRoot(env), ".runtime", "agent-fanouts-archive");
}

async function regularContainedFile(root: string, candidate: string, maxBytes: number): Promise<string | undefined> {
  try {
    const link = await lstat(candidate);
    if (!link.isFile() || link.isSymbolicLink() || link.size > maxBytes) return;
    const resolved = await realpath(candidate);
    if (!resolved.startsWith(root + path.sep)) return;
    const metadata = await stat(resolved);
    return metadata.isFile() && metadata.size <= maxBytes ? resolved : undefined;
  } catch { return; }
}

async function readBlocked(jobRoot: string): Promise<Blocked | undefined> {
  const file = await regularContainedFile(jobRoot, path.join(jobRoot, "blocked.json"), MAX_BLOCKED_BYTES);
  if (!file) return undefined;
  try { return blockedSchema.parse(JSON.parse(await readFile(file, "utf8"))); } catch { return undefined; }
}

export function blockedReason(value: Blocked): string {
  const pattern = typeof value.pattern === "string" ? value.pattern.trim() : "";
  return (pattern ? `blocked: ${value.type} ${pattern}` : `blocked: ${value.type}`).slice(0, 500);
}

/** Read only manifests explicitly bound to the already validated parent. */
export async function fanoutChildren(parentProvider: Provider, parentSession: string, env: NodeJS.ProcessEnv = process.env,
  parentComputer?: string): Promise<FanoutChild[]> {
  if (!sessionId.safeParse(parentSession).success) return [];
  const configured = fanoutRoot(env);
  let root: string;
  try { root = await realpath(configured); } catch { return []; }
  // Newest first, so a directory that outgrew MAX_JOBS drops old finished
  // jobs rather than the workers running right now.
  const entries = (await readdir(root).catch(() => [])).filter(name => jobID.safeParse(name).success);
  const stamped = await Promise.all(entries.map(async name => ({ name, at: (await stat(path.join(root, name)).catch(() => undefined))?.mtimeMs ?? 0 })));
  const names = stamped.sort((a, b) => b.at - a.at).slice(0, MAX_JOBS).map(entry => entry.name);
  const children: FanoutChild[] = [];
  for (const name of names) {
    const directory = path.join(root, name);
    const manifestFile = await regularContainedFile(root, path.join(directory, "manifest.json"), MAX_MANIFEST_BYTES);
    if (!manifestFile) continue;
    try {
      const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestFile, "utf8")));
      if (manifest.id !== name || manifest.parent?.provider !== parentProvider || manifest.parent.session !== parentSession
          || (manifest.parent.computer !== undefined && parentComputer !== undefined && manifest.parent.computer !== parentComputer)) continue;
      const jobRoot = await realpath(directory);
      if (!jobRoot.startsWith(root + path.sep)) continue;
      const transcript = await regularContainedFile(jobRoot, path.join(jobRoot, manifest.eventLog), MAX_EVENT_LOG_BYTES);
      if (!transcript) continue;
      const worktree = await worktreeDetails(manifest.worktree);
      const id = createHash("sha256").update(`${parentProvider}\0${parentSession}\0${manifest.id}`).digest("hex").slice(0, 32);
      // A denied permission aborts the turn while the launcher still records a
      // zero exit; blocked.json is the only evidence the worker did not finish.
      const blocked = await readBlocked(jobRoot);
      children.push({ id, provider: manifest.provider, session: manifest.session, model: manifest.model, ...worktree, cwd: manifest.worktree,
        path: manifest.taskLabel, callId: `fanout:${id}`,
        state: blocked ? "failed" : ["queued", "running"].includes(manifest.status) ? "running" : "completed",
        ...(blocked ? { reason: blockedReason(blocked) } : {}), transcript, children: [] });
    } catch { /* Torn, old, or untrusted manifests do not become child agents. */ }
  }
  return children.sort((a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id));
}

/** A blocked fan-out job, with the parent it belongs to, for a push. */
export interface BlockedFanout {
  id: string;
  provider: FanoutChild["provider"];
  label: string;
  parent?: { provider: Provider; session: string; computer?: string };
  reason: string;
  at?: string;
}

/** Every fan-out job that left a blocked.json, for the Hook's push watcher. */
export async function blockedFanouts(env: NodeJS.ProcessEnv = process.env): Promise<BlockedFanout[]> {
  const configured = fanoutRoot(env);
  let root: string;
  try { root = await realpath(configured); } catch { return []; }
  const names = (await readdir(root).catch(() => [])).filter(name => jobID.safeParse(name).success).slice(0, MAX_JOBS);
  const blocked: BlockedFanout[] = [];
  for (const name of names) {
    const jobRoot = await realpath(path.join(root, name)).catch(() => undefined);
    if (!jobRoot || !jobRoot.startsWith(root + path.sep)) continue;
    const manifestFile = await regularContainedFile(root, path.join(jobRoot, "manifest.json"), MAX_MANIFEST_BYTES);
    if (!manifestFile) continue;
    try {
      const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestFile, "utf8")));
      if (manifest.id !== name) continue;
      const value = await readBlocked(jobRoot);
      if (!value) continue;
      blocked.push({ id: manifest.id, provider: manifest.provider, label: manifest.taskLabel,
        ...(manifest.parent ? { parent: manifest.parent } : {}), reason: blockedReason(value), ...(value.at ? { at: value.at } : {}) });
    } catch { /* Torn or untrusted jobs are not pushed. */ }
  }
  return blocked;
}

export interface FanoutArchiveResult {
  /** Job folders moved (or, on a dry run, that would be moved), by id. */
  moved: string[];
  /** Archive folders deleted past the cap (or that would be deleted). */
  deleted: number;
}

/** The job's own manifest when it parses, absent when the folder has none. */
async function jobManifest(root: string, directory: string): Promise<FanoutManifest | undefined> {
  const manifestFile = await regularContainedFile(root, path.join(directory, "manifest.json"), MAX_MANIFEST_BYTES);
  if (!manifestFile) return undefined;
  try { return manifestSchema.parse(JSON.parse(await readFile(manifestFile, "utf8"))); } catch { return undefined; }
}

/** The launcher's exit stamp: its presence is what says the job is finished. */
async function exitStamp(directory: string): Promise<number | undefined> {
  const exit = await lstat(path.join(directory, "exit.txt")).catch(() => undefined);
  return exit?.isFile() && !exit.isSymbolicLink() ? exit.mtimeMs : undefined;
}

/** When an archived folder counts as finished for the cap: its manifest's
 * finishedAt, else exit.txt's mtime, else the folder's own mtime. */
async function archivedFinishedAt(directory: string): Promise<number> {
  const manifestFile = await lstat(path.join(directory, "manifest.json")).catch(() => undefined);
  if (manifestFile?.isFile() && !manifestFile.isSymbolicLink() && manifestFile.size <= MAX_MANIFEST_BYTES) {
    try {
      const value = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as { finishedAt?: unknown };
      const finished = typeof value.finishedAt === "string" ? Date.parse(value.finishedAt) : NaN;
      if (Number.isFinite(finished)) return finished;
    } catch { /* Missing, torn, or synthesized manifests fall back to the exit stamp. */ }
  }
  const exit = await exitStamp(directory);
  if (exit !== undefined) return exit;
  return (await stat(directory).catch(() => undefined))?.mtimeMs ?? 0;
}

/** Move finished fan-out job folders into the archive.
 *
 * A folder moves when it has exit.txt (without it the job is still running and
 * is never touched), its manifest status is completed, failed or cancelled,
 * and its finishedAt (or exit.txt's mtime when there is none) is over
 * ARCHIVE_AGE_MS old. A folder with no manifest goes too once its exit.txt is
 * that old, gaining a synthesized {status: failed, reason: "no manifest"}
 * manifest in the archive. The archive keeps ARCHIVE_MAX_FOLDERS folders,
 * deleting the oldest beyond that. `dryRun` reports the same work without
 * touching anything. */
export async function archiveFinishedFanouts(env: NodeJS.ProcessEnv = process.env,
  options: { dryRun?: boolean; now?: number } = {}): Promise<FanoutArchiveResult> {
  const now = options.now ?? Date.now(), dryRun = options.dryRun ?? false;
  const moves: Array<{ name: string; basis: number }> = [];
  const configured = fanoutRoot(env);
  const root = await realpath(configured).catch(() => undefined);
  const archive = path.join(path.dirname(root ?? configured), "agent-fanouts-archive");
  if (root) {
    const names = (await readdir(root).catch(() => [])).filter(name => jobID.safeParse(name).success).sort();
    for (const name of names) {
      const directory = path.join(root, name);
      const metadata = await lstat(directory).catch(() => undefined);
      if (!metadata?.isDirectory() || metadata.isSymbolicLink()) continue;
      const exit = await exitStamp(directory);
      if (exit === undefined) continue;
      const manifest = await jobManifest(root, directory);
      let basis: number;
      if (manifest && ARCHIVED_STATUSES.has(manifest.status)) {
        const finished = manifest.finishedAt ? Date.parse(manifest.finishedAt) : NaN;
        basis = Number.isFinite(finished) ? finished : exit;
      } else if (!manifest) {
        basis = exit;
      } else continue;
      if (now - basis <= ARCHIVE_AGE_MS) continue;
      moves.push({ name, basis });
      if (dryRun) continue;
      await mkdir(archive, { recursive: true, mode: 0o700 });
      const destination = path.join(archive, name);
      await rm(destination, { recursive: true, force: true });
      await rename(directory, destination);
      if (!manifest) await writeFile(path.join(destination, "manifest.json"),
        JSON.stringify({ status: "failed", reason: "no manifest" }), { mode: 0o600 });
    }
  }
  // Cap the archive: after the moves it may hold ARCHIVE_MAX_FOLDERS + n folders.
  const archived = (await readdir(archive).catch(() => [])).filter(name => jobID.safeParse(name).success);
  const entries: Array<{ name: string; age: number }> = [];
  for (const name of archived) entries.push({ name, age: await archivedFinishedAt(path.join(archive, name)) });
  // On a dry run the moves never landed, so weigh them at their finish stamp.
  if (dryRun) for (const move of moves) entries.push({ name: move.name, age: move.basis });
  let deleted = 0;
  if (entries.length > ARCHIVE_MAX_FOLDERS) {
    const excess = entries.sort((a, b) => a.age - b.age || a.name.localeCompare(b.name)).slice(0, entries.length - ARCHIVE_MAX_FOLDERS);
    for (const entry of excess) if (!dryRun) await rm(path.join(archive, entry.name), { recursive: true, force: true });
    deleted = excess.length;
  }
  return { moved: moves.map(move => move.name), deleted };
}

/** Project raw `opencode run --format json` rows into the small public chat
 * contract. Reasoning, snapshots, costs, and metadata are omitted. Like the
 * Codex mapping, the command, URL or path a tool was given and a bounded
 * output tail cross the wire so the owner can see what a worker is doing.
 * An MCP tool keeps its own arguments and an edit, write or patch carries the
 * changed-file diff the phone draws under the card; both are bounded. */
export function visibleOpenCodeRunEvent(raw: Json, cwd?: string): Json | undefined {
  const part = object(raw.part), time = typeof raw.timestamp === "number" && Number.isFinite(raw.timestamp)
    ? new Date(raw.timestamp).toISOString() : undefined;
  if (raw.type === "text" && part.type === "text" && typeof part.text === "string") {
    return { type: "assistant/message", ...(time ? { time } : {}), data: { message: {
      role: "assistant", content: [{ type: "text", text: part.text.slice(0, 262_144) }],
    } } };
  }
  if (raw.type === "tool_use" && part.type === "tool" && typeof part.tool === "string") {
    const state = object(part.state), status = ["pending", "running", "completed", "error"].includes(String(state.status))
      ? String(state.status) : "completed";
    const id = String(part.callID ?? "").slice(0, 200);
    const content: Json[] = [{ type: "tool_use", id, name: part.tool.slice(0, 200), input: opencodeToolInput(part.tool, object(state.input)), phrenStatus: status }];
    if (status === "completed" || status === "error") {
      content.push({ type: "tool_result", tool_use_id: id, content: opencodeToolOutput(part.tool, state), ...(status === "error" ? { is_error: true } : {}) });
    }
    const files = status === "completed" ? opencodeChanges(part.tool, state, cwd) : undefined;
    return { type: "assistant/message", ...(time ? { time } : {}),
      ...(files?.length ? { phren_changes: { [id]: files } } : {}), data: { message: { role: "assistant", content } } };
  }
  if (raw.type === "step_finish") {
    return { type: "system", ...(time ? { time } : {}), data: { message: {
      role: "assistant", content: [{ type: "text", text: `Step finished${typeof part.reason === "string" ? `: ${part.reason.slice(0, 200)}` : "."}` }],
    } } };
  }
}

/** Project raw `codex exec --json` rows into the shape Codex's own rollout
 * files use, so the existing Codex transcript reader renders them unchanged.
 * Command text, a bounded output tail, and changed paths cross the wire so the
 * owner can see what a worker is doing; diffs, usage, and costs do not. */
export function visibleCodexExecEvent(raw: Json): Json | undefined {
  const item = object(raw.item), callId = () => String(item.id ?? "").slice(0, 200);
  if (raw.type === "item.completed" && item.type === "agent_message") {
    if (typeof item.text !== "string") return undefined;
    return { type: "response_item", payload: { type: "message", role: "assistant",
      content: [{ type: "output_text", text: item.text.slice(0, 262_144) }] } };
  }
  if (raw.type === "item.started" && item.type === "command_execution") {
    return { type: "response_item", payload: { type: "function_call", name: "shell",
      call_id: callId(), arguments: JSON.stringify({ command: codexCommand(item) }) } };
  }
  if (raw.type === "item.completed" && item.type === "command_execution") {
    return { type: "response_item", payload: { type: "function_call_output", call_id: callId(),
      output: codexCommandOutput(item) } };
  }
  if (raw.type === "item.started" && item.type === "file_change") {
    return { type: "response_item", payload: { type: "function_call", name: "apply_patch",
      call_id: callId(), arguments: JSON.stringify({ files: codexFiles(item) }) } };
  }
  if (raw.type === "item.completed" && item.type === "file_change") {
    const files = codexFiles(item), header = `${files.length} file(s) changed`;
    return { type: "response_item", payload: { type: "function_call_output", call_id: callId(),
      output: files.length ? `${header}\n${files.map(file => file.path).join("\n")}` : header } };
  }
  if (raw.type === "turn.completed") return { type: "event_msg", payload: { type: "task_complete" } };
  if (raw.type === "error" && typeof raw.message === "string") {
    return { type: "event_msg", payload: { type: "error", message: raw.message.slice(0, 2000) } };
  }
  return undefined;
}

const OPENCODE_BUILTINS = new Set(["bash", "read", "edit", "write", "patch", "grep", "glob", "list", "webfetch", "todowrite", "todoread", "task", "skill"]);

/** The one argument that says what a tool did: a command, a URL, a path or a
 * pattern. MCP tools (anything outside OpenCode's own set) keep their whole
 * argument object, and an edit, write or patch keeps the text it touched. */
function opencodeToolInput(tool: string, input: Json): Json {
  const text = (key: string, max = 2000) => typeof input[key] === "string" ? collapseHomeText(String(input[key])).slice(0, max) : undefined;
  switch (tool) {
    case "bash": return { command: text("command") ?? "" };
    case "webfetch": return { url: text("url") ?? "" };
    case "read": return { path: text("filePath") ?? text("path") ?? "" };
    case "edit": return { path: text("filePath") ?? text("path") ?? "", oldString: text("oldString", 4000) ?? "", newString: text("newString", 4000) ?? "" };
    case "write": return { path: text("filePath") ?? text("path") ?? "", content: text("content", 4000) ?? "" };
    case "patch": return { path: text("filePath") ?? text("path") ?? "", patch: text("patch", 4000) ?? text("content", 4000) ?? "" };
    case "grep": case "glob": case "list": return { pattern: text("pattern", 500) ?? "", path: text("path") ?? "" };
    default: return OPENCODE_BUILTINS.has(tool) ? {} : mcpToolInput(input);
  }
}

const MCP_INPUT_BYTES = 8 * 1024;
const MCP_STRING_CHARS = 4000;
const MCP_INPUT_DEPTH = 4;

/** An MCP tool's arguments as the phone shows them: home paths collapsed,
 * long strings cut, nesting bounded, and the whole object kept under 8 KB by
 * shortening the strings further rather than dropping the call. */
function mcpToolInput(input: Json): Json {
  for (const cap of [MCP_STRING_CHARS, 2000, 1000, 500, 250, 120, 60, 0]) {
    const value = boundedValue(input, 0, cap);
    if (Buffer.byteLength(JSON.stringify(value)) <= MCP_INPUT_BYTES) return object(value);
  }
  return {};
}

function boundedValue(value: unknown, depth: number, cap: number): unknown {
  if (depth > MCP_INPUT_DEPTH) return undefined;
  if (typeof value === "string") {
    const text = collapseHomeText(value);
    return text.length > cap ? `${text.slice(0, cap)}…` : text;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 64).map(item => boundedValue(item, depth + 1, cap)).filter(item => item !== undefined);
  if (value && typeof value === "object") {
    const out: Json = Object.create(null);
    for (const [key, item] of Object.entries(value).slice(0, 64)) {
      const bounded = boundedValue(item, depth + 1, cap);
      if (bounded !== undefined) out[key] = bounded;
    }
    return out;
  }
  return undefined;
}

const MAX_CHANGE_PATCH = 64 * 1024;

/** The files an OpenCode edit, write or patch touched, in the ChangedFile
 * shape `phren_changes` already carries. `cwd` is the worker's checkout when
 * the caller knows it, so the path is shown relative to it. */
function opencodeChanges(tool: string, state: Json, cwd?: string): ChangedFile[] | undefined {
  if (!["edit", "write", "patch"].includes(tool)) return undefined;
  const input = object(state.input), metadata = object(state.metadata), filediff = object(metadata.filediff);
  let patch = [metadata.diff, filediff.patch, input.patch, input.diff].find(value => typeof value === "string" && value) as string | undefined;
  let status = patch ? changeStatus(patch) : "M";
  if (tool === "write" && !patch && metadata.exists === false) {
    patch = addedFilePatch(typeof input.content === "string" ? input.content : "");
    status = "A";
  }
  if (!patch) return undefined;
  patch = collapseHomeText(patch);
  const chunks = patch.split(/(?=^diff --git )/m).filter(Boolean);
  const patches = chunks.length > 1 ? chunks : patch.split(/(?=^--- [^\n]+\n\+\+\+ )/m).filter(Boolean);
  const multiple = patches.length > 1;
  return patches.slice(0, 50).flatMap(patch => {
    const given = multiple ? patchPath(patch) :
      [filediff.file, metadata.filepath, input.filePath, input.path].find(value => typeof value === "string" && value) as string | undefined
        ?? patchPath(patch);
    if (!given) return [];
    const counted = diffCounts(patch);
    const validCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    const added = !multiple && validCount(filediff.additions) ? filediff.additions : counted.added;
    const removed = !multiple && validCount(filediff.deletions) ? filediff.deletions : counted.removed;
    // The phone draws worker patches without needing their private checkout root.
    return [{ root: "", path: relativeChangePath(given, cwd), status: multiple ? changeStatus(patch) : status,
      patch: patch.slice(0, MAX_CHANGE_PATCH), added, removed }];
  });
}

/** A patch tool may carry only the diff; its `+++` (or `Index:`) header names
 * the file. */
function patchPath(patch: string): string | undefined {
  const next = /^\+\+\+ (?:b\/)?(.+)$/m.exec(patch)?.[1]?.trim();
  if (next && next !== "/dev/null") return next;
  return (/^--- (?:a\/)?(.+)$/m.exec(patch) ?? /^Index: (.+)$/m.exec(patch))?.[1]?.trim() || undefined;
}

function relativeChangePath(value: string, cwd?: string): string {
  if (cwd && path.isAbsolute(value)) {
    const relative = path.relative(cwd, value);
    if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`)) return relative;
  }
  return collapseHome(value);
}

/** Does a unified diff add, delete or change the file? */
function changeStatus(patch: string): string {
  if (/^new file mode\b/m.test(patch) || /^--- \/dev\/null$/m.test(patch) || /^@@ -0,0 /m.test(patch)) return "A";
  if (/^deleted file mode\b/m.test(patch) || /^\+\+\+ \/dev\/null$/m.test(patch)) return "D";
  return "M";
}

function diffCounts(patch: string): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/** The `@@` hunk the phone's diff card expects from a new file's content. */
function addedFilePatch(content: string): string {
  const text = content.endsWith("\n") ? content.slice(0, -1) : content;
  const lines = content ? text.split("\n") : [];
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map(line => `+${line}`)].join("\n");
}

function opencodeToolOutput(tool: string, state: Json): string {
  const metadata = object(state.metadata);
  const raw = typeof state.output === "string" ? state.output : typeof state.error === "string" ? state.error : "";
  const text = collapseHomeText(raw).slice(-4000);
  if (tool === "bash") return `${text}${text && !text.endsWith("\n") ? "\n" : ""}${typeof metadata.exit === "number" ? `[exit ${metadata.exit}]` : "[finished]"}`;
  return text;
}

/** Replace the real home directory wherever it appears in free text (a
 * command line, an output tail) with `~`, so the account name stays home. */
function collapseHomeText(value: string): string {
  const home = homedir();
  const base = home.endsWith(path.sep) ? home.slice(0, -path.sep.length) : home;
  return base.length > 1 ? value.split(base).join("~") : value;
}

/** Replace a leading real home directory with `~` for display. */
function collapseHome(value: string): string {
  const home = homedir();
  const trimmed = home.endsWith(path.sep) ? home.slice(0, -path.sep.length) : home;
  for (const base of [home, trimmed]) {
    if (value === base) return "~";
    const prefix = `${base}${path.sep}`;
    if (value.startsWith(prefix)) return `~${path.sep}${value.slice(prefix.length)}`;
  }
  return value;
}

function codexCommand(item: Json): string {
  const value = item.command;
  const text = Array.isArray(value) ? value.filter(part => typeof part === "string").join(" ")
    : typeof value === "string" ? value : "";
  return text.slice(0, 2000);
}

function codexCommandOutput(item: Json): string {
  const text = typeof item.aggregated_output === "string" ? item.aggregated_output.slice(-4000) : "";
  const status = typeof item.exit_code === "number" ? `[exit ${item.exit_code}]` : "[finished]";
  return `${text}\n${status}`;
}

function codexFiles(item: Json): Array<{ path: string; kind: string }> {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  return changes.slice(0, 50).map(change => {
    const entry = object(change);
    return { path: collapseHome(String(entry.path ?? "")).slice(0, 512), kind: String(entry.kind ?? "").slice(0, 512) };
  });
}

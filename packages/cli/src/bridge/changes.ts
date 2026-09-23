import { nonInteractiveGitEnv } from "../utils-helpers.js";
import { execFile } from "node:child_process";
import { appendFile, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, unlink, utimes } from "node:fs/promises";
import { homeDir } from "../home-paths.js";
import path from "node:path";
import { promisify } from "node:util";
import { bridgeRoot, object, type Json } from "./protocol.js";
import { z } from "zod";
import { ProcessPool } from "./limits.js";
import { phrenStoreRoot } from "./transcripts.js";
import { countGit, countTick } from "./metrics.js";

const exec = promisify(execFile);

/** One file a shell command changed, with the patch between the working
 * tree before the call and after it. `root` is the repository; `path` is
 * relative to it. */
export const changedFileSchema = z.object({ root: z.string(), path: z.string(), status: z.string(), patch: z.string(),
  added: z.number().int().nonnegative(), removed: z.number().int().nonnegative(), redacted: z.boolean().optional() });
export type ChangedFile = z.infer<typeof changedFileSchema>;
const changeRowSchema = z.object({ toolUseId: z.string(), files: z.array(changedFileSchema) });
export const secretName = (file: string): boolean => /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|keychain-db|tfstate)|id_rsa.*|id_ed25519.*|(?:.*\.)?credentials\.json|\.netrc|\.npmrc|\.pypirc)$/i.test(path.basename(file));
const gitPool = new ProcessPool(2);

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

async function git(cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}, signal?: AbortSignal): Promise<string> {
  return gitPool.run(signal, async () => (countGit("changes"), await exec("git", ["-C", cwd, "--no-pager", ...args], {
    signal, timeout: 10_000, maxBuffer: 8_388_608, env: nonInteractiveGitEnv({ ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", ...extra }),
  })).stdout);
}

/** The repository holding `target` (a file, a folder, or something not yet
 * created), confined to the user's home; undefined otherwise. */
async function repositoryOf(target: string, cwd: string, home = homeDir(), signal?: AbortSignal): Promise<string | undefined> {
  const absolute = target === "~" || target.startsWith("~/") ? path.join(home, target.slice(1)) : path.resolve(cwd, target);
  let existing = absolute;
  while (!(await stat(existing).catch(() => undefined))) {
    const parent = path.dirname(existing); if (parent === existing) return undefined;
    existing = parent;
  }
  const real = await realpath(existing);
  home = await realpath(home);
  if (real !== home && !real.startsWith(home + path.sep)) return undefined;
  const dir = (await stat(real)).isDirectory() ? real : path.dirname(real);
  try { return await realpath((await git(dir, ["rev-parse", "--show-toplevel"], {}, signal)).trim()); } catch { return undefined; }
}

interface Tree { hash: string; scratch: string; env: NodeJS.ProcessEnv }
async function scratchTree(root: string, signal: AbortSignal): Promise<Tree> {
  const dir = path.join(bridgeRoot(), "changes-scratch");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(path.join(dir, "repo-"));
  try {
    const objects = await realpath(path.resolve(root, (await git(root, ["rev-parse", "--git-path", "objects"], {}, signal)).trim()));
    await mkdir(path.join(scratch, "objects"), { mode: 0o700 });
    const env = { GIT_OBJECT_DIRECTORY: path.join(scratch, "objects"), GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(objects), GIT_INDEX_FILE: path.join(scratch, "index") };
    return { hash: await treeHash(root, env, signal), scratch, env };
  } catch (error) { await rm(scratch, { recursive: true, force: true }); throw error; }
}

/** Both the index and all new blobs/trees stay in scratch storage. The real
 * object store is a read-only alternate, including for linked worktrees. */
async function treeHash(root: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string> {
  const index = path.resolve(root, (await git(root, ["rev-parse", "--git-path", "index"], {}, signal)).trim());
  const temp = env.GIT_INDEX_FILE!;
  await unlink(temp).catch(() => undefined);
  await copyFile(index, temp).catch(() => undefined);
  // Force content checks for files rewritten to the same size in one instant.
  await utimes(temp, 1, 1).catch(() => undefined);
  await git(root, ["add", "-A", "--ignore-errors", "--", "."], env, signal);
  return (await git(root, ["write-tree"], env, signal)).trim();
}

const NO_DIFF = ["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
async function treeDiff(root: string, before: string, after: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<ChangedFile[]> {
  if (before === after) return [];
  const records = (await git(root, [...NO_DIFF, "--name-status", "-z", before, after], env, signal)).split("\0");
  const files: ChangedFile[] = [];
  for (let i = 0; i + 1 < records.length && files.length < 40; i += 2) {
    const status = records[i].slice(0, 1), original = records[i + 1]; let file = original;
    if (/[RC]/.test(status)) file = records[++i + 1]; // the new name follows the old
    if (!file) continue;
    const spec = `:(literal)${file}`;
    const counts = (await git(root, [...NO_DIFF, "--numstat", before, after, "--", spec], env, signal)).split("\t");
    const redacted = secretName(original) || secretName(file) || counts[0] === "-" || counts[1] === "-";
    let patch = redacted ? "" : await git(root, [...NO_DIFF, before, after, "--", spec], env, signal);
    if (patch.length > 200_000) patch = patch.slice(0, 200_000) + "\n… (truncated)\n";
    const added = Number(counts[0]) || 0, removed = Number(counts[1]) || 0;
    files.push({ root, path: file, status, patch, added, removed, ...(redacted ? { redacted: true } : {}) });
  }
  return files;
}

interface Snapshot { at: number; trees: Map<string, Tree>; result?: Promise<ChangedFile[]>; expiry?: NodeJS.Timeout }
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

  private file(conversation: string) { return path.join(bridgeRoot(), "changes", conversation.replace(/[^A-Za-z0-9._-]/g, "_") + ".jsonl"); }
  private async budget<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController(); this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), BUDGET);
    try { return await work(controller.signal); }
    finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
  private async discard(snapshot: Snapshot) {
    clearTimeout(snapshot.expiry);
    await Promise.all([...snapshot.trees.values()].map(tree => rm(tree.scratch, { recursive: true, force: true })));
  }
  async close() {
    for (const controller of this.controllers) controller.abort();
    for (const snapshot of this.snapshots.values()) { await snapshot.result?.catch(() => {}); await this.discard(snapshot); }
    this.snapshots.clear();
  }

  async before(conversation: string, toolUseId: string, cwd: string, command: string, input: Json = {}): Promise<void> {
    const key = `${conversation}\0${toolUseId}`;
    if (!toolUseId || this.snapshots.size >= 64 || this.snapshots.has(key)) return;
    const snapshot: Snapshot = { at: Date.now(), trees: new Map() };
    this.snapshots.set(key, snapshot);
    try {
      await this.budget(async signal => {
        const roots = new Set<string>();
        for (const target of [cwd, phrenStoreRoot(), ...namedPaths(command, input)]) {
          signal.throwIfAborted();
          if (roots.size >= 6) break;
          const root = await repositoryOf(target, cwd, homeDir(), signal); if (root) roots.add(root);
        }
        for (const root of roots) {
          try { snapshot.trees.set(root, await scratchTree(root, signal)); }
          catch { signal.throwIfAborted(); }
        }
        signal.throwIfAborted();
      });
      if (!snapshot.trees.size) { this.snapshots.delete(key); return; }
      // A missing PostToolUse/reader cannot retain untracked contents forever.
      snapshot.expiry = setTimeout(() => {
        if (!snapshot.result) { this.snapshots.delete(key); void this.discard(snapshot).catch(() => {}); }
      }, 30 * 60_000);
      snapshot.expiry.unref();
    } catch { this.snapshots.delete(key); await this.discard(snapshot); }
  }

  async after(conversation: string, toolUseId: string): Promise<void> {
    const key = `${conversation}\0${toolUseId}`, snapshot = this.snapshots.get(key);
    if (!snapshot) return;
    snapshot.result ??= this.compute(snapshot);
    const files = await snapshot.result;
    if (this.snapshots.get(key) === snapshot) {
      this.snapshots.delete(key); await this.record(conversation, toolUseId, files);
    }
  }
  private async compute(snapshot: Snapshot): Promise<ChangedFile[]> {
    try {
      return await this.budget(async signal => {
        const files: ChangedFile[] = [];
        for (const [root, before] of snapshot.trees) {
          try { files.push(...await treeDiff(root, before.hash, await treeHash(root, before.env, signal), before.env, signal)); }
          catch { signal.throwIfAborted(); }
        }
        return files;
      });
    } catch { return []; }
    finally { await this.discard(snapshot); }
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

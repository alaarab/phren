import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, realpath, stat, unlink, utimes } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { bridgeRoot, type Json } from "./protocol.js";
import { phrenStoreRoot } from "./transcripts.js";

const exec = promisify(execFile);

/** One file a shell command changed, with the patch between the working
 * tree before the call and after it. `root` is the repository; `path` is
 * relative to it. */
export interface ChangedFile { root: string; path: string; status: string; patch: string; added: number; removed: number }

/** Tools whose effect on files is invisible in their own call: everything
 * else — Write, Edit, apply_patch — already carries its patch. */
export const SHELL_TOOLS = new Set(["Bash", "bash", "shell", "Shell", "exec_command", "shell_command", "local_shell", "write_stdin"]);

/** The user's home: `HOME` when set (tests and POSIX), else the OS's answer —
 * `os.homedir()` ignores `HOME` on Windows. */
export function homeDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME && path.isAbsolute(env.HOME) ? env.HOME : homedir();
}

const NAMED = /(?<![\w@:/])(?:~\/|\.\/|\/)[\w.@+~-]+(?:\/[\w.@+~-]+)*/g;
/** The places a command names — the same rule the phone applies. */
export function namedPaths(command: string): string[] {
  const found = new Set<string>();
  for (const match of command.slice(0, 65_536).matchAll(NAMED)) { if (match[0].length > 2) found.add(match[0]); if (found.size === 24) break; }
  return [...found];
}

async function git(cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<string> {
  return (await exec("git", ["-C", cwd, "--no-pager", ...args], {
    timeout: 10_000, maxBuffer: 8_388_608, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", ...extra },
  })).stdout;
}

/** The repository holding `target` (a file, a folder, or something not yet
 * created), confined to the user's home; undefined otherwise. */
export async function repositoryOf(target: string, cwd: string, home = homeDirectory()): Promise<string | undefined> {
  const absolute = target === "~" || target.startsWith("~/") ? path.join(home, target.slice(1)) : path.resolve(cwd, target);
  let existing = absolute;
  while (!(await stat(existing).catch(() => undefined))) {
    const parent = path.dirname(existing); if (parent === existing) return undefined;
    existing = parent;
  }
  const real = await realpath(existing);
  if (real !== home && !real.startsWith(home + path.sep)) return undefined;
  const dir = (await stat(real)).isDirectory() ? real : path.dirname(real);
  try { return await realpath((await git(dir, ["rev-parse", "--show-toplevel"])).trim()); } catch { return undefined; }
}

/** The working tree as a tree object: the real index copied to a temporary
 * one (its stat cache means unchanged files are not re-hashed), `add -A`
 * over that, `write-tree`. Untracked files count; ignored ones do not. */
async function treeHash(root: string): Promise<string> {
  const index = path.resolve(root, (await git(root, ["rev-parse", "--git-path", "index"])).trim());
  const temp = path.join(tmpdir(), `phren-tree-${randomUUID()}`);
  await copyFile(index, temp).catch(() => undefined); // an unborn repository has no index yet
  // The copy is newer than every file, which would let git trust cached stat
  // data for a file rewritten to the same size within the same instant.
  // Dating the copy back makes every entry "racy", so contents are checked
  // (a zero timestamp would switch that check off instead).
  await utimes(temp, 1, 1).catch(() => undefined);
  try {
    await git(root, ["add", "-A", "--ignore-errors", "--", "."], { GIT_INDEX_FILE: temp });
    return (await git(root, ["write-tree"], { GIT_INDEX_FILE: temp })).trim();
  } finally { await unlink(temp).catch(() => undefined); }
}

const NO_DIFF = ["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
async function treeDiff(root: string, before: string, after: string): Promise<ChangedFile[]> {
  if (before === after) return [];
  const records = (await git(root, [...NO_DIFF, "--name-status", "-z", before, after])).split("\0");
  const files: ChangedFile[] = [];
  for (let i = 0; i + 1 < records.length && files.length < 40; i += 2) {
    const status = records[i].slice(0, 1); let file = records[i + 1];
    if (/[RC]/.test(status)) file = records[++i + 1]; // the new name follows the old
    if (!file) continue;
    let patch = await git(root, [...NO_DIFF, before, after, "--", file]);
    if (patch.length > 200_000) patch = patch.slice(0, 200_000) + "\n… (truncated)\n";
    let added = 0, removed = 0;
    for (const line of patch.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) added++;
      else if (line.startsWith("-") && !line.startsWith("---")) removed++;
    }
    files.push({ root, path: file, status, patch, added, removed });
  }
  return files;
}

interface Snapshot { at: number; trees: Map<string, string>; result?: Promise<ChangedFile[]> }
const PENDING_FOR = 6_000; // a tool whose PostToolUse never fires (it failed) shows its output after this
const BUDGET = 2_500;      // the agent waits on the hook; past this the call is simply not diffed

/** What each shell call changed on disk, keyed by conversation and tool
 * call. `before` runs from PreToolUse, `after` from PostToolUse; the
 * transcript reader attaches the result to the call's output row, and holds
 * that row back briefly while the diff is still being computed. Results are
 * appended to a per-conversation file so history keeps them after a restart. */
export class ToolChanges {
  private snapshots = new Map<string, Snapshot>();
  private results = new Map<string, Map<string, ChangedFile[]>>();
  private loaded = new Set<string>();

  private file(conversation: string) { return path.join(bridgeRoot(), "changes", conversation.replace(/[^A-Za-z0-9._-]/g, "_") + ".jsonl"); }

  async before(conversation: string, toolUseId: string, cwd: string, command: string): Promise<void> {
    if (!toolUseId || this.snapshots.size >= 64) return;
    const started = Date.now();
    const work = (async () => {
      const roots = new Set<string>();
      for (const target of [cwd, phrenStoreRoot(), ...namedPaths(command)]) {
        if (roots.size >= 6) break;
        const root = await repositoryOf(target, cwd); if (root) roots.add(root);
      }
      const trees = new Map<string, string>();
      for (const root of roots) { try { trees.set(root, await treeHash(root)); } catch { /* not a repository we can read; skip it */ } }
      return trees;
    })();
    const trees = await Promise.race([work, new Promise<undefined>(resolve => setTimeout(resolve, BUDGET))]);
    if (trees?.size) this.snapshots.set(`${conversation}\0${toolUseId}`, { at: started, trees });
  }

  async after(conversation: string, toolUseId: string): Promise<void> {
    const key = `${conversation}\0${toolUseId}`, snapshot = this.snapshots.get(key);
    if (!snapshot) return;
    if (!snapshot.result) snapshot.result = this.compute(snapshot);
    const files = await Promise.race([snapshot.result, new Promise<undefined>(resolve => setTimeout(resolve, BUDGET))]);
    if (files) { this.snapshots.delete(key); await this.record(conversation, toolUseId, files); }
  }

  private async compute(snapshot: Snapshot): Promise<ChangedFile[]> {
    const files: ChangedFile[] = [];
    for (const [root, before] of snapshot.trees) {
      try { files.push(...await treeDiff(root, before, await treeHash(root))); } catch { /* the repository went away mid-call */ }
    }
    return files;
  }

  private async record(conversation: string, toolUseId: string, files: ChangedFile[]) {
    const map = this.results.get(conversation) ?? new Map<string, ChangedFile[]>();
    map.set(toolUseId, files); this.results.set(conversation, map);
    if (!files.length) return;
    const file = this.file(conversation);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const size = (await stat(file).catch(() => undefined))?.size ?? 0;
    if (size < 16_777_216) await appendFile(file, JSON.stringify({ toolUseId, files }) + "\n", { mode: 0o600 });
  }

  private async load(conversation: string) {
    if (this.loaded.has(conversation)) return;
    this.loaded.add(conversation);
    const map = this.results.get(conversation) ?? new Map<string, ChangedFile[]>();
    const text = await readFile(this.file(conversation), "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      if (!line) continue;
      try { const row = JSON.parse(line) as { toolUseId: string; files: ChangedFile[] }; if (!map.has(row.toolUseId)) map.set(row.toolUseId, row.files); } catch { /* a torn last line */ }
    }
    this.results.set(conversation, map);
  }

  /** The reader's view of one conversation. */
  view(conversation: string): ChangeLookup {
    return {
      pending: (toolUseId) => {
        const snapshot = this.snapshots.get(`${conversation}\0${toolUseId}`);
        return !!snapshot && !snapshot.result && Date.now() - snapshot.at < PENDING_FOR;
      },
      changes: async (toolUseId) => {
        await this.load(conversation);
        const known = this.results.get(conversation)?.get(toolUseId);
        if (known) return known.length ? known : undefined;
        // The output row arrived without PostToolUse (the call failed, or
        // the hook was slow): diff now against the snapshot, once.
        const key = `${conversation}\0${toolUseId}`, snapshot = this.snapshots.get(key);
        if (!snapshot) return undefined;
        snapshot.result ??= this.compute(snapshot);
        const files = await snapshot.result; this.snapshots.delete(key);
        await this.record(conversation, toolUseId, files);
        return files.length ? files : undefined;
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
  const message = (source === "phren" ? ((raw.data ?? {}) as Json).message : raw.message) as Json | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap(block => block && typeof block === "object" && (block as Json).type === "tool_result" ? ids((block as Json).tool_use_id) : []);
}

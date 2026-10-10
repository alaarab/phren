// A read/write mirror of any computer's Phren store for the Memory section and
// the graph. "This computer" reads the real store; a remote computer keeps a
// sha-addressed mirror under the cache dir, laid out exactly as the store's
// paths, so the daemon can use the CLI's own parsers and mutators on it and
// upload back only the files a mutation changed.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  FINDINGS_FILENAME,
  approveQueueItem,
  editQueueItem,
  parseFindingsContent,
  readReviewQueue,
  readReviewQueueAcrossProjects,
  rejectQueueItem,
  type ProjectQueueItem,
  type QueueItem,
} from "@phren/cli/data/access";
import { listNotes } from "@phren/cli/data/notes";
import { readTasks } from "@phren/cli/data/tasks";
import { readProjectTopics } from "@phren/cli/client/project-topics";
import { buildGraph } from "@phren/cli/client/graph-data";
import { findPhrenPath, getProjectDirs } from "@phren/cli/paths";
import type { Computer, HookRequest } from "./contract.js";

const DEFAULT_SYNC_MS = 10_000;
const STORE_FILE_ROUTE = "/v1/store/file";

/** An HTTP-shaped failure the server maps to `{error}` with this status. */
export class MemoryHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "MemoryHttpError";
  }
}

/** The store paths the Memory section mirrors. */
const MEMORY_PATTERNS = [
  /^[^/]+\/(?:FINDINGS|tasks|review|summary|truths)\.md$/,
  /^[^/]+\/(?:notes|reference|journal)\//,
  /^[^/]+\/phren\.project\.yaml$/,
  /^phren\.root\.yaml$/,
  /^stores\.yaml$/,
  /^global\//,
];

/** The sha git gives these bytes as a blob; the Hook reports the same one. */
export function blobSha(content: Buffer): string {
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

/** Normalize a store-relative path, refusing absolute paths and `..`. */
export function safeStorePath(rel: string): string {
  if (!rel || rel.startsWith("/") || path.posix.isAbsolute(rel)) throw new MemoryHttpError(400, "Invalid store path.");
  const normalized = path.posix.normalize(rel);
  if (normalized === ".." || normalized.startsWith("../") || normalized.split("/").includes("..") || normalized.includes("\0")) {
    throw new MemoryHttpError(400, "Invalid store path.");
  }
  return normalized;
}

function isMemoryPath(rel: string): boolean {
  return MEMORY_PATTERNS.some((pattern) => pattern.test(rel));
}

/** A filesystem-safe folder name for a computer's mirror. */
export function safeFolderName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 100);
  return cleaned || "computer";
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  return value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
}

/** Every regular file under a directory, never following symlinks. */
async function walkFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...await walkFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

/** Delete mirror files no longer in the tree, then prune the empty folders. */
async function removeMissing(dir: string, keep: Map<string, string>): Promise<void> {
  for (const file of await walkFiles(dir)) {
    const rel = toPosix(path.relative(dir, file));
    if (!keep.has(rel)) await rm(file, { force: true });
  }
  await pruneEmptyDirs(dir);
}

async function pruneEmptyDirs(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (await pruneEmptyDirs(full)) await rm(full, { recursive: true, force: true });
  }
  const remaining = await readdir(dir).catch(() => []);
  return remaining.length === 0;
}

export interface MemoryOptions {
  hookRequest: HookRequest;
  computers: Computer[];
  /** `~/.cache/phren/desktop-store` by default. */
  cacheDir?: string;
  /** Home directory for defaults and `~`; `os.homedir()` by default. */
  home?: string;
  /** Minimum gap between remote syncs; 10 s by default. */
  syncMs?: number;
  now?: () => number;
}

interface RemoteState {
  sha: string | null;
  syncedAt: number;
  /** mirror-relative path -> blob sha, the previous sha writes must present. */
  blobShas: Map<string, string>;
}

export interface MemoryService {
  projects(computer: Computer): Promise<{ projects: Array<{ name: string; findings: number; tasks: number; review: number; notes: number }> }>;
  findings(computer: Computer, project: string | null): Promise<{ items: unknown[] }>;
  review(computer: Computer, project: string | null): Promise<{ items: Array<QueueItem | ProjectQueueItem> }>;
  notes(computer: Computer, project: string | null): Promise<{ items: unknown[] }>;
  topics(computer: Computer, project: string | null): Promise<{ topics: unknown[] }>;
  truths(computer: Computer, project: string | null): Promise<{ items: string[] }>;
  reviewAction(computer: Computer, body: ReviewActionBody): Promise<{ ok: true; message: string; uploaded?: string[] }>;
  graph(computer: Computer, project: string | null): Promise<unknown>;
}

export interface ReviewActionBody {
  project?: unknown;
  action?: unknown;
  line?: unknown;
  text?: unknown;
}

export function createMemoryService(opts: MemoryOptions): MemoryService {
  const home = opts.home ?? homedir();
  const cacheDir = opts.cacheDir ?? path.join(home, ".cache", "phren", "desktop-store");
  const blobsDir = path.join(cacheDir, "blobs");
  const syncMs = opts.syncMs ?? DEFAULT_SYNC_MS;
  const now = opts.now ?? Date.now;
  const states = new Map<string, RemoteState>();
  const syncing = new Map<string, Promise<void>>();

  function stateFor(name: string): RemoteState {
    let state = states.get(name);
    if (!state) { state = { sha: null, syncedAt: 0, blobShas: new Map() }; states.set(name, state); }
    return state;
  }

  function mirrorDir(name: string): string {
    return path.join(cacheDir, safeFolderName(name));
  }

  function localStore(): string | null {
    const env = process.env.PHREN_PATH?.trim();
    if (env) {
      const resolved = path.resolve(expandHome(env, home));
      return existsSync(resolved) ? resolved : null;
    }
    const found = findPhrenPath();
    if (found) return found;
    const fallback = path.join(home, ".phren");
    return existsSync(fallback) ? fallback : null;
  }

  async function hookJson(computer: Computer, requestPath: string): Promise<Record<string, unknown>> {
    const res = await opts.hookRequest(computer, "GET", requestPath);
    if (res.status !== 200) throw new MemoryHttpError(res.status === 404 ? 404 : 502, `This computer's Hook returned ${res.status}.`);
    try {
      return JSON.parse(res.body.toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new MemoryHttpError(502, "This computer's Hook returned invalid JSON.");
    }
  }

  async function doSync(computer: Computer): Promise<void> {
    const state = stateFor(computer.name);
    const dir = mirrorDir(computer.name);
    const head = await hookJson(computer, "/v1/store/head");
    const sha = typeof head.sha === "string" ? head.sha : "";
    if (!sha) throw new MemoryHttpError(502, "This computer's Hook reported no store head.");
    if (sha === state.sha && existsSync(dir)) { state.syncedAt = now(); return; }

    const treeAnswer = await hookJson(computer, `/v1/store/tree?sha=${encodeURIComponent(sha)}`);
    const entries = Array.isArray(treeAnswer.tree) ? treeAnswer.tree : [];
    const next = new Map<string, string>();
    for (const raw of entries) {
      const entry = raw as { path?: unknown; sha?: unknown; type?: unknown };
      if (typeof entry.path !== "string" || typeof entry.sha !== "string" || entry.type !== "blob") continue;
      let rel: string;
      try { rel = safeStorePath(entry.path); } catch { continue; }
      if (!isMemoryPath(rel)) continue;
      next.set(rel, entry.sha);

      const blobFile = path.join(blobsDir, entry.sha);
      if (!existsSync(blobFile)) {
        const blob = await hookJson(computer, `/v1/store/blob?sha=${entry.sha}`);
        const content = Buffer.from(typeof blob.content === "string" ? blob.content : "", "base64");
        await mkdir(blobsDir, { recursive: true });
        await writeFile(blobFile, content);
      }
      const dest = path.join(dir, rel);
      if (state.blobShas.get(rel) !== entry.sha || !existsSync(dest)) {
        await mkdir(path.dirname(dest), { recursive: true });
        await copyFile(blobFile, dest);
      }
    }
    await removeMissing(dir, next);
    state.sha = sha;
    state.blobShas = next;
    state.syncedAt = now();
  }

  /** Sync a remote computer's mirror, throttled to one pass per `syncMs`. */
  async function ensureRemote(computer: Computer, force = false): Promise<string> {
    const state = stateFor(computer.name);
    const dir = mirrorDir(computer.name);
    if (!force && state.sha !== null && now() - state.syncedAt < syncMs) return dir;
    const inFlight = syncing.get(computer.name);
    if (inFlight) { await inFlight; return dir; }
    const pass = doSync(computer).finally(() => syncing.delete(computer.name));
    syncing.set(computer.name, pass);
    await pass;
    return dir;
  }

  async function storeDir(computer: Computer): Promise<string> {
    if (computer.local) {
      const dir = localStore();
      if (!dir) throw new MemoryHttpError(409, "No Phren store on this computer. Run phren init.");
      return dir;
    }
    return ensureRemote(computer);
  }

  function requiredProject(project: string | null): string {
    const value = (project ?? "").trim();
    if (!value) throw new MemoryHttpError(400, "project is required.");
    return value;
  }

  function projectNames(dir: string): string[] {
    return getProjectDirs(dir)
      .map((projectDir) => path.basename(projectDir))
      .filter((name) => name !== "global")
      .sort();
  }

  function countTasks(dir: string, project: string): number {
    const result = readTasks(dir, project);
    if (!result.ok) return 0;
    const items = result.data.items;
    return (items.Active?.length ?? 0) + (items.Queue?.length ?? 0) + (items.Done?.length ?? 0);
  }

  async function changedMirrorFiles(dir: string, prev: Map<string, string>): Promise<string[]> {
    const changed: string[] = [];
    for (const file of await walkFiles(dir)) {
      const rel = toPosix(path.relative(dir, file));
      if (!isMemoryPath(rel)) continue; // lock and temp files are never store files
      if (prev.get(rel) !== blobSha(await readFile(file))) changed.push(rel);
    }
    return changed;
  }

  /** Upload every mirror file a mutation changed, compare-and-swapping on the
   * sha the last sync reported. A 409 means someone else moved first. */
  async function uploadChanges(computer: Computer, dir: string): Promise<string[]> {
    const state = stateFor(computer.name);
    const uploaded: string[] = [];
    for (const rel of await changedMirrorFiles(dir, state.blobShas)) {
      const content = await readFile(path.join(dir, rel));
      const res = await opts.hookRequest(computer, "POST", STORE_FILE_ROUTE, {
        path: rel,
        content: content.toString("base64"),
        sha: state.blobShas.get(rel) ?? null,
      });
      if (res.status === 409) {
        state.sha = null;
        await ensureRemote(computer, true).catch(() => undefined);
        throw new MemoryHttpError(409, "changed");
      }
      if (res.status !== 200) throw new MemoryHttpError(502, `Uploading ${rel} failed with ${res.status}.`);
      let answer: { content?: { sha?: unknown } } = {};
      try { answer = JSON.parse(res.body.toString("utf8")) as typeof answer; } catch { /* keep the local sha */ }
      const sha = answer.content && typeof answer.content.sha === "string" ? answer.content.sha : blobSha(content);
      state.blobShas.set(rel, sha);
      uploaded.push(rel);
    }
    // The store head moved: force the next read to pick it up.
    if (uploaded.length > 0) state.sha = null;
    return uploaded;
  }

  return {
    async projects(computer) {
      const dir = await storeDir(computer);
      const projects = projectNames(dir).map((name) => {
        const file = path.join(dir, name, FINDINGS_FILENAME);
        let findings = 0;
        if (existsSync(file)) {
          try { findings = parseFindingsContent(readFileSync(file, "utf8")).length; } catch { findings = 0; }
        }
        const review = readReviewQueue(dir, name);
        const notes = listNotes(dir, name);
        return {
          name,
          findings,
          tasks: countTasks(dir, name),
          review: review.ok ? review.data.length : 0,
          notes: notes.ok ? notes.data.length : 0,
        };
      });
      return { projects };
    },

    async findings(computer, project) {
      const name = requiredProject(project);
      const dir = await storeDir(computer);
      const file = path.join(dir, name, FINDINGS_FILENAME);
      const text = existsSync(file) ? readFileSync(file, "utf8") : "";
      return { items: text ? parseFindingsContent(text) : [] };
    },

    async review(computer, project) {
      const dir = await storeDir(computer);
      const single = (project ?? "").trim();
      if (single) {
        const result = readReviewQueue(dir, single);
        if (!result.ok) throw new MemoryHttpError(400, result.error);
        return { items: result.data };
      }
      const result = readReviewQueueAcrossProjects(dir);
      if (!result.ok) throw new MemoryHttpError(400, result.error);
      return { items: result.data };
    },

    async notes(computer, project) {
      const name = requiredProject(project);
      const dir = await storeDir(computer);
      const result = listNotes(dir, name);
      if (!result.ok) throw new MemoryHttpError(400, result.error);
      return { items: result.data };
    },

    async topics(computer, project) {
      const name = requiredProject(project);
      const dir = await storeDir(computer);
      return { topics: readProjectTopics(dir, name).topics };
    },

    async truths(computer, project) {
      const name = requiredProject(project);
      const dir = await storeDir(computer);
      const file = path.join(dir, name, "truths.md");
      const text = existsSync(file) ? readFileSync(file, "utf8") : "";
      const items = text.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2).trim()).filter(Boolean);
      return { items };
    },

    async reviewAction(computer, body) {
      const project = typeof body.project === "string" ? body.project.trim() : "";
      if (!project) throw new MemoryHttpError(400, "project is required.");
      const action = body.action;
      if (action !== "approve" && action !== "reject" && action !== "edit") {
        throw new MemoryHttpError(400, "action must be approve, reject or edit.");
      }
      const line = typeof body.line === "string" ? body.line : "";
      if (!line.trim()) throw new MemoryHttpError(400, "line is required.");
      const text = typeof body.text === "string" ? body.text : "";
      if (action === "edit" && !text.trim()) throw new MemoryHttpError(400, "text is required to edit.");

      const dir = await storeDir(computer);
      const result = action === "approve"
        ? approveQueueItem(dir, project, line)
        : action === "reject"
          ? rejectQueueItem(dir, project, line)
          : editQueueItem(dir, project, line, text);
      if (!result.ok) throw new MemoryHttpError(400, result.error);

      if (computer.local) return { ok: true, message: result.data };
      return { ok: true, message: result.data, uploaded: await uploadChanges(computer, dir) };
    },

    async graph(computer, project) {
      const dir = await storeDir(computer);
      const focus = (project ?? "").trim() || undefined;
      return buildGraph(dir, undefined, focus);
    },
  };
}

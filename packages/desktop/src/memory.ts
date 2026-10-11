// A read/write mirror of any computer's Phren store for the Memory section and
// the graph. "This computer" reads the real store; a remote computer keeps a
// sha-addressed mirror under the cache dir, laid out exactly as the store's
// paths, so the daemon can use the CLI's own parsers and mutators on it and
// upload back only the files a mutation changed.
import { createHash } from "node:crypto";
import { parseSchedule, readScheduleDocument, writeScheduleDocument, type Schedule } from "@phren/cli/client/schedule-format";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  FINDINGS_FILENAME,
  addFinding,
  approveQueueItem,
  editQueueItem,
  parseFindingsContent,
  readReviewQueue,
  readReviewQueueAcrossProjects,
  rejectQueueItem,
  type ProjectQueueItem,
  type QueueItem,
} from "@phren/cli/data/access";
import { listNotes, removeNote } from "@phren/cli/data/notes";
import { readTasks } from "@phren/cli/data/tasks";
import { readProjectTopics } from "@phren/cli/client/project-topics";
import { buildGraph } from "@phren/cli/client/graph-data";
import { findPhrenPath, getProjectDirs } from "@phren/cli/paths";
import type { Computer, HookRequest } from "./contract.js";

const DEFAULT_SYNC_MS = 10_000;
const STORE_FILE_ROUTE = "/v1/store/file";
const STORE_DELETE_ROUTE = "/v1/store/delete";

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
  /^[^/]+\/schedules\.yaml$/,
  /^phren\.root\.yaml$/,
  /^stores\.yaml$/,
  /^global\//,
];

/** The sha git gives these bytes as a blob; the Hook reports the same one. */
/** A git blob id: 40 (sha1) or 64 (sha256) lowercase hex characters. */
const BLOB_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

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

/** A memory row's store-relative path and current blob sha, for deletion. */
async function storeFileInfo(dir: string, file: string): Promise<{ file: string; sha: string | null }> {
  const rel = toPosix(path.relative(dir, file));
  try { return { file: rel, sha: blobSha(await readFile(file)) }; }
  catch { return { file: rel, sha: null }; }
}

/** The sha a delete must present to remove this file, or null when absent. */
async function fileSha(file: string): Promise<string | null> {
  try { return blobSha(await readFile(file)); } catch { return null; }
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
  /** false once the Hook answered 404 to the batch route (an older Hook). */
  batch?: boolean;
}

export interface MemoryService {
  projects(computer: Computer): Promise<{ projects: Array<{ name: string; findings: number; tasks: number; review: number; notes: number }> }>;
  findings(computer: Computer, project: string | null): Promise<{ items: unknown[] }>;
  review(computer: Computer, project: string | null): Promise<{ items: Array<QueueItem | ProjectQueueItem> }>;
  addFinding(computer: Computer, body: { project?: unknown; text?: unknown }): Promise<{ ok: true; uploaded?: unknown }>;
  saveSchedule(computer: Computer, body: { project?: unknown; id?: unknown; schedule?: unknown; original?: unknown }): Promise<{ ok: true; uploaded?: unknown }>;
  notes(computer: Computer, project: string | null): Promise<{ items: unknown[] }>;
  topics(computer: Computer, project: string | null): Promise<{ topics: unknown[] }>;
  truths(computer: Computer, project: string | null): Promise<{ items: string[] }>;
  reviewAction(computer: Computer, body: ReviewActionBody): Promise<{ ok: true; message: string; uploaded?: string[] }>;
  deleteStoreFile(computer: Computer, path: string, expectedSha: string): Promise<{ ok: true }>;
  removeNote(computer: Computer, body: { project?: unknown; id?: unknown }): Promise<{ ok: true; uploaded?: string[] }>;
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
      // A blob id names a cache file: only a canonical git sha (hex) may.
      if (!BLOB_SHA.test(entry.sha)) continue;
      let rel: string;
      try { rel = safeStorePath(entry.path); } catch { continue; }
      if (!isMemoryPath(rel)) continue;
      next.set(rel, entry.sha);
    }
    // Fetch missing blobs eight at a time: each is one SSH channel, and the
    // per-computer pool carries far more than that.
    await mkdir(blobsDir, { recursive: true });
    const missing = [...new Set(next.values())].filter((blobSha) => !existsSync(path.join(blobsDir, blobSha)));
    /** Keep a downloaded blob only when its content hashes to the id asked for. */
    const storeBlobFile = async (id: string, content: Buffer) => {
      if (!BLOB_SHA.test(id) || (id.length === 40 && blobSha(content) !== id)) return;
      await writeFile(path.join(blobsDir, id), content);
    };
    // A Hook with memoryStoreBatch answers up to 256 blobs per request; older
    // Hooks get one request per blob.
    const single: string[] = [];
    let batch = state.batch !== false;
    let queue = missing;
    while (batch && queue.length) {
      const chunk = queue.slice(0, 200);
      const res = await opts.hookRequest(computer, "POST", "/v1/store/blobs", { shas: chunk });
      if (res.status === 404 || res.status === 405) { batch = false; state.batch = false; break; }
      // A batch the Hook refuses as too large goes one by one instead.
      if (res.status === 413) { single.push(...chunk); queue = queue.slice(chunk.length); continue; }
      if (res.status !== 200) throw new MemoryHttpError(502, `This computer's Hook returned ${res.status}.`);
      const answer = JSON.parse(res.body.toString("utf8")) as { blobs?: Array<{ sha?: string; content?: string; error?: string }> };
      const later: string[] = [];
      for (const blob of answer.blobs ?? []) {
        if (typeof blob.sha !== "string" || !chunk.includes(blob.sha)) continue;
        if (typeof blob.content === "string") await storeBlobFile(blob.sha, Buffer.from(blob.content, "base64"));
        else if (blob.error === "later") later.push(blob.sha);
      }
      queue = [...later, ...queue.slice(chunk.length)];
      if (later.length === chunk.length) { single.push(...later); queue = queue.slice(later.length); }
    }
    if (!batch) single.push(...queue);
    let cursor = 0;
    const worker = async () => {
      while (cursor < single.length) {
        const blobSha = single[cursor++];
        const res = await opts.hookRequest(computer, "GET", `/v1/store/blob?sha=${blobSha}`);
        // Over the 4 MiB limit (413) or gone (404): leave that file out of the mirror.
        if (res.status === 413 || res.status === 404) continue;
        if (res.status !== 200) throw new MemoryHttpError(502, `This computer's Hook returned ${res.status}.`);
        const blob = JSON.parse(res.body.toString("utf8")) as { content?: unknown };
        await storeBlobFile(blobSha, Buffer.from(typeof blob.content === "string" ? blob.content : "", "base64"));
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, single.length) }, worker));
    for (const [rel, blobSha] of next) {
      // Unknown or oversized blobs stay out of the mirror.
      if (!existsSync(path.join(blobsDir, blobSha))) { next.delete(rel); continue; }
      const dest = path.join(dir, rel);
      if (state.blobShas.get(rel) !== blobSha || !existsSync(dest)) {
        await mkdir(path.dirname(dest), { recursive: true });
        await copyFile(path.join(blobsDir, blobSha), dest);
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
      const topics = readProjectTopics(dir, name).topics;
      const items = await Promise.all(topics.map(async (topic: { slug: string }) => {
        const rel = path.posix.join(name, "reference", "topics", `${topic.slug}.md`);
        return { ...topic, ...await storeFileInfo(dir, path.join(dir, rel)) };
      }));
      return { topics: items };
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

    async addFinding(computer, body) {
      const project = typeof body.project === "string" ? body.project.trim() : "";
      const text = typeof body.text === "string" ? body.text.replace(/\s+/g, " ").trim() : "";
      if (!project || !text) throw new MemoryHttpError(400, "project and text are required.");
      if (text.length > 4000) throw new MemoryHttpError(413, "That is too long for one finding.");
      const dir = await storeDir(computer);
      // The CLI's own writer: stable id, duplicate check, the file's conventions.
      const result = addFinding(dir, project, text);
      if (!result.ok) throw new MemoryHttpError(400, result.error);
      if (computer.local) return { ok: true };
      return { ok: true, uploaded: await uploadChanges(computer, dir) };
    },

    /** Remove one note from its daily file with the CLI's own writer (never the
     * whole day's file), then upload the changed file with the usual sha check. */
    async removeNote(computer, body) {
      const project = typeof body.project === "string" ? body.project.trim() : "";
      const id = typeof body.id === "string" ? body.id.trim() : "";
      if (!project || !id) throw new MemoryHttpError(400, "project and id are required.");
      const dir = await storeDir(computer);
      const result = removeNote(dir, project, id);
      if (!result.ok) throw new MemoryHttpError(404, result.error);
      if (computer.local) return { ok: true };
      return { ok: true, uploaded: await uploadChanges(computer, dir) };
    },

    /**
     * Delete one store file, compare-and-swapping on the sha the UI last saw.
     * A 409 means the file changed on the computer since it was listed; the
     * mirror is refreshed so the next read shows the newer content.
     */
    async deleteStoreFile(computer, storePath: string, expectedSha: string) {
      const rel = safeStorePath(storePath);
      const dir = await storeDir(computer);
      if (computer.local) {
        // No mirror to write through: apply the delete to the real store.
        if (await fileSha(path.join(dir, rel)) !== expectedSha) throw new MemoryHttpError(409, "changed");
        await rm(path.join(dir, rel), { force: true });
        return { ok: true as const };
      }
      const res = await opts.hookRequest(computer, "POST", STORE_DELETE_ROUTE, { path: rel, sha: expectedSha });
      if (res.status === 409) {
        stateFor(computer.name).sha = null;
        await ensureRemote(computer, true).catch(() => undefined);
        throw new MemoryHttpError(409, "changed");
      }
      if (res.status !== 200) throw new MemoryHttpError(502, `Deleting ${rel} failed with ${res.status}.`);
      // The store head moved: pick up the new tree before the next read.
      stateFor(computer.name).sha = null;
      await ensureRemote(computer, true);
      return { ok: true as const };
    },

    /**
     * Add, replace or remove one schedule in <project>/schedules.yaml with the CLI's
     * own reader and writer. `original` is the entry as the editor opened it: when
     * the file's entry no longer matches, someone changed it meanwhile (409).
     */
    async saveSchedule(computer, body) {
      const project = typeof body.project === "string" ? body.project.trim() : "";
      const id = typeof body.id === "string" ? body.id.trim() : "";
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(project) || !id) throw new MemoryHttpError(400, "project and id are required.");
      const dir = await storeDir(computer);
      const projectDir = path.join(dir, project);
      const { document, schedules } = await readScheduleDocument(projectDir);
      const index = schedules.findIndex((item) => item.id === id);
      // The Hook's listing adds runtime fields (ScheduleStatus) that are not part of the file.
      const fileFields = (value: unknown): Record<string, unknown> => {
        const { project: _p, nextRun: _n, lastRun: _l, lastRuns: _r, running: _u, owned: _o, ...rest } = (value ?? {}) as Record<string, unknown>;
        return rest;
      };
      const normal = (value: unknown) => JSON.stringify(parseSchedule(fileFields(value)));
      if (body.original != null) {
        if (index < 0 || normal(schedules[index]) !== normal(body.original)) throw new MemoryHttpError(409, "This schedule changed on another computer. Reopen it to edit.");
      } else if (index >= 0 && body.schedule != null) {
        throw new MemoryHttpError(409, "A schedule with this id already exists.");
      }
      const next: Schedule[] = schedules.slice();
      if (body.schedule == null) { if (index >= 0) next.splice(index, 1); }
      else if (index >= 0) next[index] = parseSchedule(fileFields(body.schedule));
      else next.push(parseSchedule(fileFields(body.schedule)));
      await writeScheduleDocument(projectDir, next, document);
      if (computer.local) return { ok: true };
      return { ok: true, uploaded: await uploadChanges(computer, dir) };
    },

    async graph(computer, project) {
      const dir = await storeDir(computer);
      const focus = (project ?? "").trim() || undefined;
      return buildGraph(dir, undefined, focus);
    },
  };
}

import { createHash } from "node:crypto";
import { appendFile, mkdir, open, opendir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { claudeHomes } from "./claude-accounts.js";
import { codexHome, copilotHome } from "../home-paths.js";
import { redactSecretsForLog } from "../content/secrets.js";
import { codexThreadSessions, codexTurnSettled, materializeCodexThread, materializedPath, materializedRoot } from "./codex-threads.js";
import { paneIdentity, snapshot, recentServers } from "./herdr.js";
import { BridgeError, bridgeRoot, object, objects, sessionId, type Json, type Provider } from "./protocol.js";
import { phrenStoreRoot, selectTranscriptMatch, visibleEvent } from "./transcripts.js";

// `GET /v1/conversations/search`: search the settled user and assistant text of
// the conversations this Hook can read, newest conversations first. The index
// is a private SQLite file advanced from transcript size/mtime, a bounded
// number of files and bytes per request. Contract:
// docs/api-reference.md#conversation-search.

export type ConversationSource = "claude" | "codex" | "copilot" | "opencode";

export interface ConversationSearchHit {
  conversation: string;
  source: ConversationSource;
  title: string;
  cwd: string | null;
  pane: string | null;
  entry: string;
  at: string;
  role: "user" | "assistant";
  snippet: string;
}

export interface ConversationSearchPage {
  results: ConversationSearchHit[];
  cursor: string | null;
  partial?: true;
}

interface DbStatement {
  all(...args: unknown[]): unknown[];
  get(...args: unknown[]): unknown;
  run(...args: unknown[]): { lastInsertRowid: number | bigint; changes: number | bigint };
}
interface Db {
  exec(sql: string): void;
  prepare(sql: string): DbStatement;
  close(): void;
}
interface RootSpec { key: string; root: string; source: ConversationSource; maxDepth: number }
interface FileRow {
  path: string; source: ConversationSource; session: string;
  size: number | null; mtime_ms: number | null; dev: string | null; ino: string | null;
  offset: number; scan_offset: number | null; scanning_row: number; lines: number;
  title: string | null; cwd: string | null; last_at: string | null;
  publication_seq: number; canonical: number; ready_until: number; refresh: number; copilot_final: number; checked_at: number | null;
}
interface PendingRow { seq: number; entry: number; at: string; role: "user" | "assistant"; text: string; message_id: number | null; token_offset: number; turn_id: string | null; queue_key: string | null; queued: number; settle_after: number }
interface ScanState { title: string | null; cwd: string | null; lastAt: string | null; copilotFinal: boolean }
interface PaneCandidate { server: string; pane: string; terminal: string; source: string; session: string; at: string }

const INDEX_FILE = () => path.join(bridgeRoot(), "conversation-search.sqlite");
const SIDECAR_DIR = () => path.join(bridgeRoot(), "conversation-search-rows");
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const QUERY_MIN = 2;
const QUERY_MAX = 200;
const MAX_REQUEST_MS = 1_500;
const MAX_DIRS_PER_REQUEST = 16;
const MAX_STAT_FILES = 64;
const MAX_SCAN_FILES = 24;
const MAX_BYTES_PER_REQUEST = 8 * 1024 * 1024;
const MAX_MATERIALIZE_PER_REQUEST = 8;
const READ_BLOCK = 65_536;
const MAX_ROW_BYTES = 64 * 1024 * 1024;
const DISCOVERY_RESCAN_MS = 5_000;
const MAX_DB_BYTES = 512 * 1024 * 1024;
const SNIPPET_CHARS = 200;
const SNIPPET_LEAD = 80;
const MAX_TITLE_CHARS = 200;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY, root TEXT NOT NULL, source TEXT NOT NULL, session TEXT NOT NULL,
  size INTEGER, mtime_ms REAL, dev TEXT, ino TEXT,
  offset INTEGER NOT NULL DEFAULT 0, scan_offset INTEGER, scanning_row INTEGER NOT NULL DEFAULT 0, ready_until INTEGER NOT NULL DEFAULT -1, publishing INTEGER NOT NULL DEFAULT 0, publication_seq INTEGER NOT NULL DEFAULT -1, unresolved INTEGER NOT NULL DEFAULT 0,
  canonical INTEGER NOT NULL DEFAULT 0, projected INTEGER NOT NULL DEFAULT 0,
  lines INTEGER NOT NULL DEFAULT 0, title TEXT, cwd TEXT, last_at TEXT,
  refresh INTEGER NOT NULL DEFAULT 0, copilot_final INTEGER NOT NULL DEFAULT 0, checked_at REAL, materialized_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS files_identity ON files(source, session, projected, canonical);
CREATE INDEX IF NOT EXISTS files_fair ON files(COALESCE(checked_at, 0), path);
CREATE INDEX IF NOT EXISTS files_materialize ON files(refresh, canonical, materialized_at, path);
CREATE INDEX IF NOT EXISTS files_incomplete ON files(canonical, (size IS NULL OR offset < size OR scanning_row != 0));
CREATE INDEX IF NOT EXISTS files_publishing ON files(canonical, publishing);
CREATE INDEX IF NOT EXISTS files_unresolved ON files(canonical, unresolved);
CREATE TABLE IF NOT EXISTS pending (
  file TEXT NOT NULL, seq INTEGER NOT NULL, entry INTEGER NOT NULL, at TEXT NOT NULL,
  role TEXT NOT NULL, text TEXT NOT NULL, message_id INTEGER, token_offset INTEGER NOT NULL DEFAULT 0, turn_id TEXT, queue_key TEXT, queued INTEGER NOT NULL DEFAULT 0, settle_after INTEGER NOT NULL, PRIMARY KEY(file, seq)
);
CREATE INDEX IF NOT EXISTS pending_queue ON pending(file, queue_key);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, file TEXT NOT NULL, conversation TEXT NOT NULL,
  source TEXT NOT NULL, entry INTEGER NOT NULL, at TEXT NOT NULL, role TEXT NOT NULL,
  text TEXT NOT NULL, published INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_snapshot ON messages(published, at, id);
CREATE INDEX IF NOT EXISTS messages_file ON messages(file, at DESC, id DESC);
CREATE INDEX IF NOT EXISTS messages_at ON messages(at, id);
CREATE TABLE IF NOT EXISTS tokens (
  message_id INTEGER NOT NULL, token TEXT NOT NULL, PRIMARY KEY(message_id, token)
);
CREATE INDEX IF NOT EXISTS tokens_token ON tokens(token);
CREATE TABLE IF NOT EXISTS activity (
  revision INTEGER PRIMARY KEY, file TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_order ON activity(at DESC, revision DESC);
CREATE INDEX IF NOT EXISTS activity_file ON activity(file, revision DESC);
CREATE TABLE IF NOT EXISTS dirs (
  root TEXT NOT NULL, path TEXT NOT NULL, source TEXT NOT NULL, depth INTEGER NOT NULL,
  PRIMARY KEY(root, path)
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const safe = (text: string): string => redactSecretsForLog(text);
const sidecarPath = (file: string) => path.join(SIDECAR_DIR(), createHash("sha256").update(file).digest("hex") + ".part");
const textTokens = (text: string): string[] => [...new Set((text.match(/[\p{L}\p{N}_]+/gu) ?? []).map(token => token.toLowerCase()))];

function absolutePath(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 && path.isAbsolute(value) ? value : undefined;
}

function textBlock(block: Json): string | undefined {
  if (!["text", "input_text", "output_text"].includes(String(block.type))) return undefined;
  return typeof block.text === "string" ? block.text : undefined;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  return objects(content).map(textBlock).filter((text): text is string => text !== undefined).join("\n");
}

/** The user or assistant text of one projected transcript row. Tool results,
 * reasoning, deltas and system rows carry no message text. */
function messageOf(raw: Json, source: ConversationSource): { role: "user" | "assistant"; text: string } | undefined {
  let role: unknown, content: unknown;
  if (source === "claude") {
    if (raw.isCompactSummary === true) return undefined;
    const message = object(raw.message);
    role = message.role;
    content = message.content;
  } else if (source === "codex") {
    const payload = object(raw.payload);
    if (payload.type !== "message") return undefined;
    role = payload.role;
    content = payload.content;
  } else if (source === "copilot") {
    if (raw.type === "user.message") role = "user";
    else if (raw.type === "assistant.message") role = "assistant";
    else return undefined;
    content = object(raw.data).content;
  } else {
    if (raw.type === "user/message") role = "user";
    else if (raw.type === "assistant/message") role = "assistant";
    else return undefined;
    const message = object(object(raw.data).message);
    role = message.role ?? role;
    content = message.content;
  }
  if (role !== "user" && role !== "assistant") return undefined;
  const text = messageText(content).trim();
  return text ? { role, text } : undefined;
}

function timestampOf(raw: Json, source: ConversationSource): string | undefined {
  const value = source === "opencode" ? raw.time : raw.timestamp;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function cwdOf(raw: Json, source: ConversationSource): string | undefined {
  const direct = absolutePath(raw.cwd);
  if (direct) return direct;
  const payload = object(raw.payload), data = object(raw.data);
  if (source === "copilot") return absolutePath(object(data.context).cwd);
  return absolutePath(payload.cwd) ?? absolutePath(data.cwd) ?? absolutePath(object(data.context).cwd);
}

/** A turn's end as the harness writes it; the same markers the returned
 * conversation's final reply is read from (schedule-watch.ts). */
function turnEnded(raw: Json, source: ConversationSource, copilotFinal: boolean): boolean {
  const payload = object(raw.payload), message = object(raw.message), data = object(raw.data);
  if (source === "claude") return (raw.type === "assistant" && message.stop_reason === "end_turn")
    || (raw.type === "system" && raw.subtype === "turn_duration");
  if (source === "codex") return raw.type === "event_msg"
    && ["task_complete", "task_completed", "turn_aborted", "task_aborted"].includes(String(payload.type));
  if (source === "copilot") return ["session.error", "session.idle", "abort"].includes(String(raw.type))
    || (raw.type === "assistant.turn_end" && !raw.agentId && copilotFinal);
  return data.stop_reason === "end_turn";
}

function queuedMessage(projected: Json, source: ConversationSource, raw: Json): boolean {
  if (projected.phrenQueued === true) return true;
  return source === "copilot" && object(raw.data).delivery === "queued";
}

function materializedFile(file: string): boolean {
  return file.startsWith(materializedRoot() + path.sep);
}

async function openIndex(): Promise<Db> {
  await mkdir(bridgeRoot(), { recursive: true, mode: 0o700 });
  const sqlite = await import("node:sqlite");
  let db = new sqlite.DatabaseSync(INDEX_FILE()) as unknown as Db;
  const version = Number(object(db.prepare("PRAGMA user_version").get()).user_version ?? 0);
  if (version !== 2 && db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'files'").get()) {
    // This is a derived cache. Rebuild older layouts rather than retaining
    // completed scan offsets with incompatible token/publication state.
    db.close();
    await rm(INDEX_FILE(), { force: true });
    await rm(INDEX_FILE() + "-wal", { force: true });
    await rm(INDEX_FILE() + "-shm", { force: true });
    db = new sqlite.DatabaseSync(INDEX_FILE()) as unknown as Db;
  }
  db.exec("PRAGMA busy_timeout = 50");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(SCHEMA);
  db.exec("PRAGMA user_version = 2");
  return db;
}

function metaValue(db: Db, key: string): string | undefined {
  const row = object(db.prepare("SELECT value FROM meta WHERE key = ?").get(key));
  return typeof row.value === "string" ? row.value : undefined;
}

function setMeta(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

function rowFor(db: Db, file: string): FileRow | undefined {
  const row = db.prepare("SELECT * FROM files WHERE path = ?").get(file);
  return row ? row as unknown as FileRow : undefined;
}

async function clearFile(db: Db, file: string, deadline: number): Promise<boolean> {
  if (db.prepare("SELECT 1 FROM messages WHERE file = ? AND published > 0 LIMIT 1").get(file)) {
    setMeta(db, "generation", String(Number(metaValue(db, "generation") ?? "0") + 1));
  }
  db.prepare("UPDATE files SET size = NULL, ready_until = -1, last_at = NULL, publishing = 0, publication_seq = -1, unresolved = 0 WHERE path = ?").run(file);
  db.exec("BEGIN");
  try {
    while (Date.now() < deadline) {
      const message = object(db.prepare("SELECT id FROM messages WHERE file = ? LIMIT 1").get(file));
      if (message.id !== undefined) {
        const token = object(db.prepare("SELECT token FROM tokens WHERE message_id = ? LIMIT 1").get(message.id));
        if (token.token !== undefined) db.prepare("DELETE FROM tokens WHERE message_id = ? AND token = ?").run(message.id, token.token);
        else db.prepare("DELETE FROM messages WHERE id = ?").run(message.id);
        continue;
      }
      const pending = object(db.prepare("SELECT seq FROM pending WHERE file = ? LIMIT 1").get(file));
      if (pending.seq !== undefined) { db.prepare("DELETE FROM pending WHERE file = ? AND seq = ?").run(file, pending.seq); continue; }
      const activity = object(db.prepare("SELECT revision FROM activity WHERE file = ? LIMIT 1").get(file));
      if (activity.revision !== undefined) { db.prepare("DELETE FROM activity WHERE revision = ?").run(activity.revision); continue; }
      await rm(sidecarPath(file), { force: true });
      return true;
    }
    return false;
  } finally { db.exec("COMMIT"); }
}

function selectCanonical(db: Db, source: ConversationSource, session: string): void {
  const copies = (db.prepare("SELECT path FROM files WHERE source = ? AND session = ? AND projected = 0 LIMIT 2").all(source, session) as { path: string }[])
    .map(row => ({ id: undefined, path: row.path }));
  const unique = selectTranscriptMatch(source, copies);
  const projected = source === "codex" && !unique
    ? object(db.prepare("SELECT path FROM files WHERE source = ? AND session = ? AND projected = 1 LIMIT 1").get(source, session)).path : undefined;
  const selected = unique?.path ?? (typeof projected === "string" ? projected : undefined);
  const previous = object(db.prepare("SELECT path FROM files WHERE source = ? AND session = ? AND canonical = 1 LIMIT 1").get(source, session)).path;
  if (previous === selected) return;
  if (typeof previous === "string" && db.prepare("SELECT 1 FROM messages WHERE file = ? AND published > 0 LIMIT 1").get(previous)) {
    setMeta(db, "generation", String(Number(metaValue(db, "generation") ?? "0") + 1));
  }
  db.prepare("UPDATE files SET canonical = 0 WHERE source = ? AND session = ? AND canonical = 1").run(source, session);
  if (selected) db.prepare("UPDATE files SET canonical = 1 WHERE path = ?").run(selected);
}

async function deleteFile(db: Db, file: string, deadline: number): Promise<void> {
  const row = rowFor(db, file);
  if (await clearFile(db, file, deadline)) {
    db.prepare("DELETE FROM files WHERE path = ?").run(file);
    if (row) selectCanonical(db, row.source, row.session);
  }
}

/** Publication is a durable job: neither a large turn nor a large vocabulary
 * must finish in the request that discovers its end marker. */
async function commitPending(db: Db, row: FileRow, state: ScanState, deadline: number): Promise<void> {
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE files SET publishing = 1 WHERE path = ?").run(row.path);
    let after = rowFor(db, row.path)?.publication_seq ?? -1;
    if (after === -1) db.prepare("UPDATE files SET unresolved = 0 WHERE path = ?").run(row.path);
    while (Date.now() < deadline) {
      const item = db.prepare("SELECT * FROM pending WHERE file = ? AND seq > ? ORDER BY seq LIMIT 1").get(row.path, after) as PendingRow | undefined;
      if (!item) {
        db.prepare("UPDATE files SET publishing = 0, publication_seq = -1 WHERE path = ?").run(row.path);
        return;
      }
      const settled = materializedFile(row.path) && !item.queued ? await codexTurnSettled(row.session, item.turn_id) : false;
      if (item.queued || (materializedFile(row.path) ? settled !== true : item.settle_after > (rowFor(db, row.path)?.ready_until ?? -1))) {
        if (materializedFile(row.path) && !item.queued && settled === undefined) db.prepare("UPDATE files SET unresolved = 1 WHERE path = ?").run(row.path);
        after = item.seq;
        db.prepare("UPDATE files SET publication_seq = ? WHERE path = ?").run(after, row.path);
        continue;
      }
      let id = item.message_id;
      if (id === null) {
        id = Number(db.prepare(`INSERT INTO messages(file, conversation, source, entry, at, role, text, published)
          VALUES(?, ?, ?, ?, ?, ?, ?, 0)`).run(row.path, row.session, row.source, item.entry, item.at, item.role, item.text).lastInsertRowid);
        db.prepare("UPDATE pending SET message_id = ? WHERE file = ? AND seq = ?").run(id, row.path, item.seq);
      }
      const words = /[\p{L}\p{N}_]+/gu;
      words.lastIndex = item.token_offset;
      const insert = db.prepare("INSERT OR IGNORE INTO tokens(message_id, token) VALUES(?, ?)");
      let match: RegExpExecArray | null, offset = item.token_offset;
      while (Date.now() < deadline && (match = words.exec(item.text)) !== null) {
        insert.run(id, match[0].toLowerCase());
        offset = words.lastIndex;
      }
      db.prepare("UPDATE pending SET token_offset = ? WHERE file = ? AND seq = ?").run(offset, row.path, item.seq);
      if (Date.now() >= deadline) return;
      const published = Number(metaValue(db, "published") ?? "0") + 1;
      const newest = state.lastAt && state.lastAt > item.at ? state.lastAt : item.at;
      db.prepare("UPDATE messages SET published = ? WHERE id = ?").run(published, id);
      db.prepare("DELETE FROM pending WHERE file = ? AND seq = ?").run(row.path, item.seq);
      db.prepare("UPDATE files SET last_at = ? WHERE path = ?").run(newest, row.path);
      db.prepare("INSERT INTO activity(revision, file, at) VALUES(?, ?, ?)").run(published, row.path, newest);
      setMeta(db, "published", String(published));
      state.lastAt = newest;
      after = item.seq;
      db.prepare("UPDATE files SET publication_seq = ? WHERE path = ?").run(after, row.path);
    }
  } finally { db.exec("COMMIT"); }
}

function addPending(db: Db, row: FileRow, message: { role: "user" | "assistant"; text: string }, entry: number, at: string, state: ScanState, turn: unknown, queued: boolean, key: unknown): void {
  if (message.role === "user" && !state.title) state.title = message.text;
  db.prepare("INSERT OR IGNORE INTO pending(file, seq, entry, at, role, text, turn_id, queued, queue_key, settle_after) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(row.path, entry, entry, at, message.role, message.text, typeof turn === "string" ? turn : null, queued ? 1 : 0, typeof key === "string" ? key : null, entry);
}

/** Eviction first invalidates coverage, then deletes one message at a time.
 * Reset offsets ensure readable history is revisited; partial stays true until
 * that happens. Never leave a completed offset pointing at discarded rows. */
async function pruneIndex(db: Db, deadline: number): Promise<boolean> {
  let victim = metaValue(db, "evicting");
  if (!victim) {
    const pages = Number(object(db.prepare("PRAGMA page_count").get()).page_count);
    const free = Number(object(db.prepare("PRAGMA freelist_count").get()).freelist_count ?? 0);
    const size = Number(object(db.prepare("PRAGMA page_size").get()).page_size);
    if ((pages - free) * size <= MAX_DB_BYTES) return false;
    victim = String(object(db.prepare("SELECT file AS path FROM messages ORDER BY at, id LIMIT 1").get()).path ?? "");
    if (!victim) return false;
    setMeta(db, "evicting", victim);
    db.prepare("UPDATE files SET size = NULL, offset = 0, scan_offset = 0, lines = 0, scanning_row = 0, ready_until = -1, last_at = NULL, publishing = 0 WHERE path = ?").run(victim);
    await rm(sidecarPath(victim), { force: true });
  }
  if (await clearFile(db, victim, deadline)) db.prepare("DELETE FROM meta WHERE key = 'evicting'").run();
  return true;
}

function transcriptRoots(): RootSpec[] {
  const roots: RootSpec[] = [];
  for (const home of claudeHomes()) roots.push({ key: `claude:${home.id}`, root: path.join(home.dir, "projects"), source: "claude", maxDepth: 1 });
  roots.push({ key: "codex", root: path.join(codexHome(), "sessions"), source: "codex", maxDepth: 3 });
  roots.push({ key: "copilot", root: path.join(copilotHome(), "session-state"), source: "copilot", maxDepth: 1 });
  roots.push({ key: "opencode", root: path.join(phrenStoreRoot(), ".runtime", "sessions"), source: "opencode", maxDepth: 0 });
  roots.push({ key: "codex-materialized", root: materializedRoot(), source: "codex", maxDepth: 0 });
  return roots;
}

function fileIdentity(source: ConversationSource, file: string): { session: string } | undefined {
  const name = path.basename(file);
  if (source === "claude") {
    const session = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : "";
    return sessionId.safeParse(session).success ? { session } : undefined;
  }
  if (source === "copilot") {
    if (name !== "events.jsonl") return undefined;
    const session = path.basename(path.dirname(file));
    return sessionId.safeParse(session).success ? { session } : undefined;
  }
  if (source === "opencode") {
    const match = /^opencode-(.+)\.events\.jsonl$/.exec(name);
    return match && sessionId.safeParse(match[1]).success ? { session: match[1] } : undefined;
  }
  const materialized = /^([0-9a-f-]{36}|ses_[0-9A-Za-z]{1,64})\.jsonl$/i.exec(name);
  if (materialized && materializedFile(file) && sessionId.safeParse(materialized[1]).success) return { session: materialized[1] };
  if (path.relative(path.join(codexHome(), "sessions"), file).split(path.sep).length !== 4) return undefined;
  const rollout = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(name);
  return rollout && sessionId.safeParse(rollout[1]).success ? { session: rollout[1] } : undefined;
}

function insertFile(db: Db, root: string, source: ConversationSource, file: string, refresh = 0): void {
  const identity = fileIdentity(source, file);
  if (!identity) return;
  db.prepare(`INSERT INTO files(path, root, source, session, refresh, projected) VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET root = excluded.root, source = excluded.source, session = excluded.session,
      refresh = MAX(files.refresh, excluded.refresh)`).run(file, root, source, identity.session, refresh, materializedFile(file) ? 1 : 0);
  selectCanonical(db, source, identity.session);
}

// Open directory handles are resumable within the Hook. After a restart the
// durable directory queue restarts the unfinished directory (idempotently).
const directoryScans = new Map<string, Awaited<ReturnType<typeof opendir>>>();
async function discoverDirectories(db: Db, deadline: number): Promise<boolean> {
  const roots = transcriptRoots(), specs = new Map(roots.map(spec => [spec.key, spec]));
  const pending = db.prepare("SELECT 1 FROM dirs LIMIT 1").get();
  if (!pending && Date.now() - Number(metaValue(db, "discovery_cycle") ?? "0") >= DISCOVERY_RESCAN_MS) {
    for (const spec of roots) {
      if (Date.now() >= deadline) return true;
      db.prepare("INSERT OR IGNORE INTO dirs(root, path, source, depth) VALUES(?, ?, ?, 0)").run(spec.key, spec.root, spec.source);
    }
    setMeta(db, "discovery_cycle", String(Date.now()));
  }
  let processed = 0, entries = 0;
  while (processed < MAX_DIRS_PER_REQUEST && entries < 512 && Date.now() < deadline) {
    const row = object(db.prepare("SELECT root, path, source, depth FROM dirs ORDER BY rowid LIMIT 1").get());
    if (typeof row.path !== "string" || typeof row.root !== "string") break;
    const key = INDEX_FILE() + "\0" + row.path;
    let directory = directoryScans.get(key);
    if (!directory) {
      directory = await opendir(row.path).catch(() => undefined);
      if (directory) directoryScans.set(key, directory);
    }
    const entry = directory ? await directory.read().catch(() => null) : null;
    if (!entry) {
      await directory?.close().catch(() => undefined);
      directoryScans.delete(key);
      db.prepare("DELETE FROM dirs WHERE root = ? AND path = ?").run(row.root, row.path);
      processed++;
      continue;
    }
    entries++;
    if (entry.isSymbolicLink()) continue;
    const spec = specs.get(row.root), child = path.join(row.path, entry.name);
    if (entry.isDirectory() && Number(row.depth) < (spec?.maxDepth ?? 0)) {
      db.prepare("INSERT OR IGNORE INTO dirs(root, path, source, depth) VALUES(?, ?, ?, ?)").run(row.root, child, row.source, Number(row.depth) + 1);
    } else if (entry.isFile()) insertFile(db, row.path, row.source as ConversationSource, child);
  }
  return !!db.prepare("SELECT 1 FROM dirs LIMIT 1").get();
}

async function discoverSqliteThreads(db: Db, deadline: number): Promise<boolean> {
  let after = metaValue(db, "sqlite_after") ?? "";
  if (!after && Date.now() - Number(metaValue(db, "sqlite_cycle") ?? "0") < DISCOVERY_RESCAN_MS) return false;
  const threads = await codexThreadSessions(128, after).catch(() => [] as string[]);
  for (const thread of threads) {
    if (Date.now() >= deadline) return true;
    if (sessionId.safeParse(thread).success) insertFile(db, materializedRoot(), "codex", materializedPath(thread), 1);
    after = thread;
    setMeta(db, "sqlite_after", after);
  }
  if (threads.length === 128) return true;
  setMeta(db, "sqlite_after", "");
  setMeta(db, "sqlite_cycle", String(Date.now()));
  return false;
}

function updateChecked(db: Db, file: string): void {
  const tick = Number(metaValue(db, "check_clock") ?? "0") + 1;
  setMeta(db, "check_clock", String(tick));
  db.prepare("UPDATE files SET checked_at = ? WHERE path = ?").run(tick, file);
}

async function processRow(db: Db, row: FileRow, line: string, lineNumber: number, state: ScanState, fallbackAt: string, deadline: number): Promise<void> {
  if (!line.trim()) return;
  let raw: Json;
  try { raw = object(JSON.parse(line)); } catch { return; }
  state.cwd ??= cwdOf(raw, row.source) ?? null;
  if (row.source === "copilot" && raw.type === "assistant.message" && !raw.agentId) {
    state.copilotFinal = object(raw.data).phase === "final_answer";
  }
  const projected = visibleEvent(raw, row.source as Provider);
  const message = projected ? messageOf(projected, row.source) : undefined;
  if (projected?.type === "phren_queue_consumed" && typeof projected.key === "string") {
    db.prepare("UPDATE pending SET queued = 0, turn_id = COALESCE(?, turn_id), settle_after = ? WHERE file = ? AND queue_key = ?")
      .run(typeof raw.phrenTurnId === "string" ? raw.phrenTurnId : null, lineNumber, row.path, projected.key);
  }
  if (message && projected) {
    const at = timestampOf(projected, row.source) ?? fallbackAt;
    addPending(db, row, message, lineNumber, at, state, raw.phrenTurnId, queuedMessage(projected, row.source, raw), projected.phrenQueueKey);
  }
  if (turnEnded(raw, row.source, state.copilotFinal)) {
    db.prepare("UPDATE files SET ready_until = ? WHERE path = ?").run(lineNumber, row.path);
    await commitPending(db, row, state, deadline);
    state.copilotFinal = false;
  }
}

async function scanFile(db: Db, row: FileRow, info: { size: number; mtimeMs: number; dev: number; ino: number }, budget: number, deadline: number): Promise<{ bytes: number; complete: boolean }> {
  const sidecar = sidecarPath(row.path), sidecarInfo = await stat(sidecar).catch(() => undefined);
  let replacement = row.size === null || row.dev !== String(info.dev) || row.ino !== String(info.ino)
    || info.size < Math.max(row.offset, row.scan_offset ?? 0)
    || (info.size === row.size && row.mtime_ms !== info.mtimeMs);
  if (row.scanning_row === 1 && !sidecarInfo?.isFile()) replacement = true;

  let offset = replacement ? 0 : row.offset;
  let lines = replacement ? 0 : row.lines;
  let scanningRow = replacement ? 0 : row.scanning_row;
  let sidecarBytes = replacement ? 0 : sidecarInfo?.size ?? 0;
  let start = replacement ? 0 : (scanningRow ? row.scan_offset ?? row.offset : row.offset);
  let title = replacement ? null : row.title;
  let cwd = replacement ? null : row.cwd;
  let lastAt = replacement ? null : row.last_at;
  let copilotFinal = replacement ? false : row.copilot_final === 1;
  if (replacement && !await clearFile(db, row.path, deadline)) return { bytes: 0, complete: false };
  const state: ScanState = { title, cwd, lastAt, copilotFinal };
  const fallbackAt = new Date(info.mtimeMs).toISOString();
  let bytesRead = 0, position = start, chunkStart = start, pending = Buffer.alloc(0);

  const handle = await open(row.path, "r");
  try {
    while (bytesRead < budget && position < info.size && Date.now() < deadline) {
      const length = Math.min(READ_BLOCK, info.size - position, budget - bytesRead);
      if (length <= 0) break;
      const buffer = Buffer.alloc(length);
      const { bytesRead: read } = await handle.read(buffer, 0, length, position);
      if (!read) break;
      bytesRead += read;
      const chunk = pending.length ? Buffer.concat([pending, buffer.subarray(0, read)]) : buffer.subarray(0, read);
      let begin = 0;
      if (scanningRow === 2) {
        const newline = chunk.indexOf(10, begin);
        if (newline < 0) { position += read; pending = Buffer.alloc(0); continue; }
        lines++;
        chunkStart = position + newline + 1;
        offset = chunkStart;
        begin = newline + 1;
        scanningRow = 0;
      } else if (scanningRow === 1) {
        const newline = chunk.indexOf(10, begin);
        if (newline < 0) {
          if (sidecarBytes + chunk.length > MAX_ROW_BYTES) {
            await rm(sidecar, { force: true });
            sidecarBytes = 0;
            scanningRow = 2;
          } else {
            await appendFile(sidecar, chunk, { mode: 0o600 });
            sidecarBytes += chunk.length;
          }
          position += read;
          continue;
        }
        const rowBytes = chunk.subarray(0, newline);
        if (sidecarBytes + rowBytes.length <= MAX_ROW_BYTES) {
          if (rowBytes.length) await appendFile(sidecar, rowBytes, { mode: 0o600 });
          const line = await readFile(sidecar, "utf8").catch(() => "");
          if (Date.now() >= deadline) { position += newline; break; }
          await processRow(db, row, line, lines, state, fallbackAt, deadline);
        }
        lines++;
        chunkStart = position + newline + 1;
        offset = chunkStart;
        begin = newline + 1;
        scanningRow = 0;
        sidecarBytes = 0;
        await rm(sidecar, { force: true });
      }
      let newline: number;
      while (Date.now() < deadline && (newline = chunk.indexOf(10, begin)) >= 0) {
        await processRow(db, row, chunk.subarray(begin, newline).toString("utf8"), lines, state, fallbackAt, deadline);
        lines++;
        chunkStart += newline + 1 - begin;
        offset = chunkStart;
        begin = newline + 1;
      }
      if (Date.now() >= deadline) { position = offset; pending = Buffer.alloc(0); break; }
      pending = Buffer.from(chunk.subarray(begin));
      if (pending.length > MAX_ROW_BYTES) {
        pending = Buffer.alloc(0);
        chunkStart = position + read;
        scanningRow = 2;
      }
      position += read;
    }
  } finally { await handle.close(); }

  if (position < info.size && scanningRow === 0 && pending.length > 0) {
    await mkdir(SIDECAR_DIR(), { recursive: true, mode: 0o700 });
    await writeFile(sidecar, pending, { mode: 0o600 });
    sidecarBytes = pending.length;
    scanningRow = 1;
  }
  await commitPending(db, row, state, deadline);
  const complete = offset >= info.size && scanningRow === 0;
  db.prepare(`UPDATE files SET size = ?, mtime_ms = ?, dev = ?, ino = ?, offset = ?, scan_offset = ?,
    scanning_row = ?, lines = ?, title = ?, cwd = ?, last_at = ?, copilot_final = ? WHERE path = ?`)
    .run(info.size, info.mtimeMs, String(info.dev), String(info.ino), offset, scanningRow ? position : offset,
      scanningRow, lines, state.title ?? title, state.cwd ?? cwd, state.lastAt ?? lastAt, state.copilotFinal ? 1 : 0,
      row.path);
  return { bytes: bytesRead, complete };
}

interface RefreshBudget { partial: boolean; checked: number; scanned: number; bytes: number }

async function refreshFile(db: Db, row: FileRow, budget: RefreshBudget, deadline: number): Promise<void> {
  if (Date.now() >= deadline || budget.checked >= MAX_STAT_FILES || budget.scanned >= MAX_SCAN_FILES || budget.bytes >= MAX_BYTES_PER_REQUEST) {
    budget.partial = true;
    return;
  }
  budget.checked++;
  updateChecked(db, row.path);
  if (row.path === metaValue(db, "evicting")) { budget.partial = true; return; }
  const info = await stat(row.path).catch(() => undefined);
  if (!info?.isFile()) {
    if (materializedFile(row.path)) { db.prepare("UPDATE files SET refresh = 1 WHERE path = ?").run(row.path); if (row.canonical) budget.partial = true; }
    else await deleteFile(db, row.path, deadline);
    return;
  }
  if (!row.canonical) return;
  if (materializedFile(row.path)) db.prepare("UPDATE files SET refresh = 1 WHERE path = ?").run(row.path);
  const unchanged = row.size === info.size && row.mtime_ms === info.mtimeMs && row.dev === String(info.dev)
    && row.ino === String(info.ino) && row.offset >= info.size && row.scanning_row === 0;
  try {
    if (!unchanged) {
      const result = await scanFile(db, row, info, MAX_BYTES_PER_REQUEST - budget.bytes, deadline);
      budget.bytes += result.bytes; budget.scanned++;
      if (!result.complete) budget.partial = true;
    } else await commitPending(db, row, { title: row.title, cwd: row.cwd, lastAt: row.last_at, copilotFinal: false }, deadline);
  } catch { budget.partial = true; }
}

async function refreshFiles(db: Db, deadline: number): Promise<boolean> {
  const budget: RefreshBudget = { partial: false, checked: 0, scanned: 0, bytes: 0 };
  const first = metaValue(db, "refresh_first") ?? "materialize";
  setMeta(db, "refresh_first", first === "materialize" ? "files" : "materialize");
  // Alternate the first queue too: even an unusually expensive work unit in
  // one queue cannot consume the other queue's budget on every request.
  for (const phase of first === "materialize" ? ["materialize", "files"] : ["files", "materialize"]) {
    if (Date.now() >= deadline) { budget.partial = true; break; }
    if (phase === "materialize") {
      const rows = db.prepare("SELECT * FROM files WHERE refresh = 1 AND canonical = 1 ORDER BY materialized_at, path LIMIT ?")
        .all(MAX_MATERIALIZE_PER_REQUEST) as unknown as FileRow[];
      for (const row of rows) {
        if (Date.now() >= deadline) { budget.partial = true; break; }
        const file = await materializeCodexThread(row.session, deadline, 128).catch(() => undefined);
        const tick = Number(metaValue(db, "materialize_clock") ?? "0") + 1;
        setMeta(db, "materialize_clock", String(tick));
        db.prepare("UPDATE files SET materialized_at = ? WHERE path = ?").run(tick, row.path);
        if (!file) { budget.partial = true; continue; }
        const state = await readFile(file + ".state.json", "utf8").then(value => object(JSON.parse(value))).catch(() => ({} as Json));
        if (state.forwardDone !== true || state.updateTarget !== undefined || state.upgrading === true) budget.partial = true;
        // If materialization ran second, index its new tail in this request
        // too, using the same total file/byte allowance as ordinary refresh.
        await refreshFile(db, rowFor(db, row.path) ?? row, budget, deadline);
      }
    } else {
      // Leave room for all eight materialized tails when that queue runs
      // second; otherwise a newly discovered thread waits a full stat rotation.
      const rows = db.prepare("SELECT * FROM files ORDER BY COALESCE(checked_at, 0), path LIMIT ?")
        .all(Math.max(0, MAX_STAT_FILES - budget.checked - (first === "files" ? MAX_MATERIALIZE_PER_REQUEST : 0))) as unknown as FileRow[];
      for (const row of rows) {
        if (Date.now() >= deadline || budget.scanned >= MAX_SCAN_FILES || budget.bytes >= MAX_BYTES_PER_REQUEST) { budget.partial = true; break; }
        await refreshFile(db, row, budget, deadline);
      }
    }
  }
  return budget.partial || !!db.prepare("SELECT 1 FROM files WHERE canonical = 1 AND (size IS NULL OR offset < size OR scanning_row != 0) = 1 LIMIT 1").get()
    || !!db.prepare("SELECT 1 FROM files WHERE canonical = 1 AND publishing = 1 LIMIT 1").get()
    || !!db.prepare("SELECT 1 FROM files WHERE canonical = 1 AND unresolved = 1 LIMIT 1").get();
}

interface Cursor { q: string; w: number; g: number; ca: string; revision: number; file: string; at: string; id: number }
const encodeCursor = (cursor: Cursor): string => Buffer.from(JSON.stringify(cursor)).toString("base64url");
function decodeCursor(cursor: string | null | undefined): Cursor | undefined {
  if (!cursor) return undefined;
  try {
    const value = object(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    if (typeof value.q !== "string" || !Number.isSafeInteger(value.w as number) || !Number.isSafeInteger(value.g as number) || typeof value.ca !== "string"
      || typeof value.at !== "string" || !Number.isSafeInteger(value.id as number)
      || typeof value.file !== "string" || !Number.isSafeInteger(value.revision as number)) throw new Error();
    return { q: value.q, w: value.w as number, g: value.g as number, ca: value.ca, at: value.at, id: value.id as number, file: value.file, revision: value.revision as number };
  } catch { throw new BridgeError(400, "Invalid cursor."); }
}

function snippetFor(text: string, tokens: readonly string[], deadline: number): string | undefined {
  const lower = text.toLowerCase();
  let first = -1;
  for (const token of tokens) {
    if (Date.now() >= deadline) return undefined;
    const at = lower.indexOf(token);
    if (at >= 0 && (first < 0 || at < first)) first = at;
  }
  if (first < 0) first = 0;
  const start = Math.max(0, Math.min(first - SNIPPET_LEAD, text.length - SNIPPET_CHARS));
  const snippet = text.slice(start, start + SNIPPET_CHARS);
  const redacted = safe(text);
  return redacted === text ? snippet : redacted.slice(0, SNIPPET_CHARS);
}

function titleFor(title: string | null, session: string): string {
  const text = title ?? session;
  const redacted = safe(text);
  return redacted.slice(0, MAX_TITLE_CHARS);
}

async function resolvePanes(keys: Set<string>, deadline: number): Promise<Map<string, string>> {
  const panes = new Map<string, string>();
  // Live snapshots are primary evidence, including OpenCode, whose lifecycle
  // lives in per-PID status files rather than the persisted turn directory.
  const serverNames = new Set(["default"]);
  const candidates = new Map<string, PaneCandidate>();
  for (const server of serverNames) {
    if (Date.now() >= deadline) break;
    const view = await withinDeadline(snapshot(server).catch(() => undefined), deadline, undefined);
    for (const pane of objects(view?.panes)) {
      if (Date.now() >= deadline) break;
      const source = String(pane.agent);
      if (!["claude", "codex", "copilot", "opencode"].includes(source)) continue;
      const identity = await withinDeadline(paneIdentity(server, pane, true).catch(() => undefined), deadline, undefined);
      const key = `${source}\0${identity}`;
      if (!identity || !keys.has(key)) continue;
      const name = String(pane.pane_id), terminal = String(pane.terminal_id);
      const record = await readFile(path.join(bridgeRoot(), "turns", encodeURIComponent(server), encodeURIComponent(name) + ".json"), "utf8")
        .then(value => object(JSON.parse(value))).catch(() => undefined);
      if (record && record.session === identity && record.terminal !== terminal) continue;
      const at = record?.session === identity && typeof record.at === "string" ? record.at : "";
      const previous = candidates.get(key);
      if (!previous || at > previous.at) {
        candidates.set(key, { server, pane: name, terminal, source, session: identity, at });
        panes.set(key, name);
      }
    }
    if (server === "default" && candidates.size < keys.size && Date.now() < deadline) {
      const listed = await withinDeadline(recentServers().catch(() => []), deadline, []);
      for (const item of listed) {
        if (Date.now() >= deadline) break;
        serverNames.add(String(item.session));
      }
    }
  }
  return panes;
}

/** Bound external terminal probes too; the underlying read-only probe may
 * finish later, but cannot delay the response beyond this request's budget. */
async function withinDeadline<T>(work: Promise<T>, deadline: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), Math.max(0, deadline - Date.now())); })]);
  } finally { clearTimeout(timer); }
}

async function search(q: string | null | undefined, limit: string | null | undefined, cursor: string | null | undefined): Promise<ConversationSearchPage> {
  const query = (q ?? "").trim();
  if (query.length < QUERY_MIN || query.length > QUERY_MAX) throw new BridgeError(400, `q must be ${QUERY_MIN} to ${QUERY_MAX} characters.`);
  let count = DEFAULT_LIMIT;
  if (limit !== null && limit !== undefined && String(limit).trim() !== "") {
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) throw new BridgeError(400, `limit must be 1 to ${MAX_LIMIT}.`);
    count = parsed;
  }
  const decoded = decodeCursor(cursor);
  if (decoded && decoded.q !== query) throw new BridgeError(400, "The cursor belongs to another query.");
  const tokens = textTokens(query);
  const deadline = Date.now() + MAX_REQUEST_MS;
  const db = await openIndex();
  try {
    const discoveryPartial = await discoverDirectories(db, deadline);
    const sqlitePartial = Date.now() < deadline ? await discoverSqliteThreads(db, deadline) : true;
    const pruningPartial = Date.now() < deadline ? await pruneIndex(db, deadline) : true;
    const indexingPartial = Date.now() < deadline ? await refreshFiles(db, deadline) : true;
    let partial = discoveryPartial || sqlitePartial || indexingPartial || pruningPartial;
    if (!tokens.length) return { results: [], cursor: null, ...(partial ? { partial: true as const } : {}) };

    const generation = Number(metaValue(db, "generation") ?? "0");
    if (decoded && decoded.g !== generation) throw new BridgeError(400, "Indexed history changed. Start a new search.");
    const watermark = decoded?.w ?? Number(metaValue(db, "published") ?? "0");
    // Activity is versioned at publication. Indexed keyset reads walk the
    // newest conversation versions in the cursor's watermark, independently
    // of matching text. No window or sort over the set of matching messages.
    const position: Cursor = decoded ?? { q: query, w: watermark, g: generation, ca: "\uffff", revision: Number.MAX_SAFE_INTEGER, file: "", at: "\uffff", id: Number.MAX_SAFE_INTEGER };
    const page: Json[] = [];
    const titles = new Map<string, string>();
    let exhausted = false;
    while (page.length < count && Date.now() < deadline) {
      if (!position.file) {
        const activity = object(db.prepare(`SELECT * FROM activity WHERE
          (at, revision) < (?, ?) ORDER BY at DESC, revision DESC LIMIT 1`)
          .get(position.ca, position.revision));
        if (typeof activity.file !== "string") { exhausted = true; break; }
        position.ca = String(activity.at); position.revision = Number(activity.revision);
        if (position.revision > watermark) continue;
        const latest = object(db.prepare("SELECT revision FROM activity WHERE file = ? AND revision <= ? ORDER BY revision DESC LIMIT 1").get(activity.file, watermark));
        if (latest.revision !== activity.revision) continue;
        const file = rowFor(db, activity.file);
        if (!file?.canonical) continue;
        position.file = activity.file; position.at = "\uffff"; position.id = Number.MAX_SAFE_INTEGER;
      }
      // Rediscovery can reveal another account copy or a preferred rollout.
      // Pause with this file and message position intact until it completes;
      // advancing past it would silently discard entries from the snapshot.
      if (discoveryPartial) {
        const source = rowFor(db, position.file)?.source;
        if (source === "claude" || source === "codex") break;
      }
      const row = object(db.prepare(`SELECT m.*, f.title, f.cwd FROM messages m JOIN files f ON f.path = m.file
        WHERE f.canonical = 1 AND m.file = ? AND (m.at, m.id) < (?, ?)
        ORDER BY m.at DESC, m.id DESC LIMIT 1`).get(position.file, position.at, position.id));
      if (row.id === undefined) { position.file = ""; continue; }
      let matches = Number(row.published) > 0 && Number(row.published) <= watermark;
      for (const token of tokens) {
        if (!matches) break;
        if (Date.now() >= deadline) break;
        if (!db.prepare("SELECT 1 FROM tokens WHERE message_id = ? AND token = ?").get(row.id, token)) { matches = false; break; }
      }
      // Keep the message position unchanged if a word check was interrupted.
      if (Date.now() >= deadline) break;
      if (matches) {
        if (!titles.has(position.file)) titles.set(position.file, titleFor(typeof row.title === "string" ? row.title : null, String(row.conversation)));
        const snippet = snippetFor(String(row.text), tokens, deadline);
        if (snippet === undefined) break;
        page.push({ ...row, text: undefined, title: titles.get(position.file), snippet });
      }
      position.at = String(row.at); position.id = Number(row.id);
    }
    if (!exhausted && page.length < count) partial = true;
    const next = exhausted ? null : encodeCursor(position);
    const wanted = new Set(page.map(row => `${String(row.source)}\0${String(row.conversation)}`));
    const panes = wanted.size && Date.now() < deadline ? await resolvePanes(wanted, deadline) : new Map<string, string>();
    if (Date.now() >= deadline) partial = true;
    return {
      results: page.map(row => ({
        conversation: String(row.conversation), source: String(row.source) as ConversationSource,
        title: String(row.title),
        cwd: typeof row.cwd === "string" ? row.cwd : null,
        pane: panes.get(`${String(row.source)}\0${String(row.conversation)}`) ?? null,
        entry: String(row.entry), at: String(row.at), role: String(row.role) as "user" | "assistant",
        snippet: String(row.snippet),
      })),
      cursor: next,
      ...(partial ? { partial: true as const } : {}),
    };
  } finally { db.close(); }
}

let tail: Promise<unknown> = Promise.resolve();

/** Serialize index updates in this Hook process; reads stay consistent with the
 * last write and two searches cannot rebuild the same file twice at once. */
export function conversationSearch(q: string | null | undefined, limit?: string | null, cursor?: string | null): Promise<ConversationSearchPage> {
  const run = tail.then(() => search(q, limit, cursor));
  tail = run.catch(() => undefined);
  return run;
}

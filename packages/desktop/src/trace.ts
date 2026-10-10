// Record every Hook exchange once, so a bug seen on any client can be replayed
// forever as a test. One JSON line per exchange under ~/.cache/phren/desktop-traces.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WebSocket } from "ws";
import type { Computer, HookResponse } from "./contract.js";

const MAX_BODY = 256 * 1024;
const MAX_TRACE = 50 * 1024 * 1024;
const MAX_MS = 30 * 60 * 1000;
const SENSITIVE = /token|secret|password|passphrase|authorization|cookie|apikey|api_key|privatekey/i;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
// Well-known token shapes that can sit inside ordinary text (a pasted command,
// an error message): GitHub, OpenAI/Anthropic-style, Slack, AWS access keys.
const TOKENS = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g;
// Routes whose request body is a secret as a whole (a typed password, a
// secret answer), whatever its keys are called.
const SECRET_ROUTES = /^\/v1\/(?:secret|sudo)(?:\/|$)/;

export interface TraceStatus {
  recording: boolean;
  file: string | null;
  startedAt: string | null;
  computers: string[];
  bytes: number;
  elapsedMs: number;
}

export interface TraceRecord {
  file: string;
  name: string;
  size: number;
  modifiedAt: string;
}

interface Recording {
  file: string;
  startedAtMs: number;
  computers: Set<string>;
  /** When the caller named no computers, record every computer seen. */
  all: boolean;
  bytes: number;
  timer: NodeJS.Timeout;
  wsId: number;
}

function records(rec: Recording, computer: string): boolean {
  return rec.all || rec.computers.has(computer);
}

let current: Recording | null = null;

function traceDir(): string {
  if (process.env.PHREN_DESKTOP_TRACE_DIR) return process.env.PHREN_DESKTOP_TRACE_DIR;
  const cache = process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache");
  return path.join(cache, "phren", "desktop-traces");
}

let desktopVersionCache: string | undefined;
function desktopVersion(): string {
  if (desktopVersionCache !== undefined) return desktopVersionCache;
  try {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../package.json");
    desktopVersionCache = (JSON.parse(readFileSync(file, "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    desktopVersionCache = "unknown";
  }
  return desktopVersionCache;
}

// ---------------------------------------------------------------- redaction
/** Replace a private-key block or a bare bearer token with "[redacted]". */
export function redactString(value: string): string {
  return value.replace(PRIVATE_KEY, "[redacted]").replace(BEARER, "Bearer [redacted]").replace(TOKENS, "[redacted]");
}

/** A query string with sensitive parameters' values replaced. */
export function redactQuery(query: string): string {
  if (!query) return query;
  const params = new URLSearchParams(query);
  for (const key of [...params.keys()]) if (SENSITIVE.test(key)) params.set(key, "[redacted]");
  return redactString(params.toString());
}

/** Walk a JSON value: sensitive keys lose their value, strings are redacted. */
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = SENSITIVE.test(key) ? "[redacted]" : redactValue(child);
    return out;
  }
  return value;
}

/** A redacted JSON value, or the truncation marker when it serializes too big. */
function prepareJson(value: unknown): unknown {
  const redacted = redactValue(value);
  const json = JSON.stringify(redacted);
  if (json === undefined) return redacted;
  const size = Buffer.byteLength(json, "utf8");
  return size > MAX_BODY ? `[truncated ${size} bytes]` : redacted;
}

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8_000);
  return sample.includes(0) || sample.toString("utf8").includes("\uFFFD");
}

/** A response body: JSON redacted, text capped, binary as { base64 } capped. */
export function prepareBody(buf: Buffer, contentType?: string): unknown {
  const text = buf.toString("utf8");
  if (!contentType || contentType.includes("json")) {
    try { return prepareJson(JSON.parse(text)); } catch { /* not JSON */ }
  }
  if (contentType && !contentType.startsWith("text/")) {
    if (looksBinary(buf)) return base64Capped(buf);
    return capText(redactString(text));
  }
  if (looksBinary(buf)) return base64Capped(buf);
  return capText(redactString(text));
}

function capText(text: string): string {
  const size = Buffer.byteLength(text, "utf8");
  return size > MAX_BODY ? `[truncated ${size} bytes]` : text;
}

function base64Capped(buf: Buffer): unknown {
  const encoded = buf.toString("base64");
  return Buffer.byteLength(encoded, "utf8") > MAX_BODY ? `[truncated ${buf.length} bytes]` : { base64: encoded };
}

// ---------------------------------------------------------------- writing
function append(entry: Record<string, unknown>): void {
  const rec = current;
  if (!rec) return;
  const line = `${JSON.stringify(entry)}\n`;
  try {
    appendFileSync(rec.file, line, { mode: 0o600 });
  } catch {
    return;
  }
  rec.bytes += Buffer.byteLength(line, "utf8");
  if (rec.bytes > MAX_TRACE) stopTrace();
}

function keyPath(requestPath: string): { path: string; query: string } {
  const index = requestPath.indexOf("?");
  return index < 0 ? { path: requestPath, query: "" } : { path: requestPath.slice(0, index), query: requestPath.slice(index + 1) };
}

/** Record one HTTP exchange. Exported for hook-client; a no-op when off. */
export function recordHttp(c: Computer, method: string, requestPath: string, request: unknown, response: HookResponse | null, error?: string): void {
  const rec = current;
  if (!rec || !records(rec, c.name)) return;
  const { path: route, query: rawQuery } = keyPath(requestPath);
  const query = redactQuery(rawQuery);
  const contentType = response ? response.headers["content-type"] : undefined;
  append({
    t: Date.now() - rec.startedAtMs,
    kind: "http",
    computer: c.name,
    method,
    path: route,
    query,
    request: request === undefined ? undefined : SECRET_ROUTES.test(route) ? "[redacted]" : prepareJson(request),
    status: response ? response.status : 0,
    response: response ? prepareBody(response.body, contentType) : { error: error ?? "request failed" },
  });
}

/** A WebSocket frame: JSON redacted like a body, text redacted, everything capped. */
function frameData(data: unknown, isBinary: boolean): unknown {
  const buf = typeof data === "string" ? Buffer.from(data) : Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
  if (isBinary || looksBinary(buf)) return base64Capped(buf);
  const text = buf.toString("utf8");
  try { return prepareJson(JSON.parse(text)); } catch { return capText(redactString(text)); }
}

/** Record a live Hook WebSocket: open, both frame directions, close. */
export function recordWebSocket(socket: WebSocket, computer: string, requestPath: string): void {
  const rec = current;
  if (!rec || !records(rec, computer)) return;
  const id = ++rec.wsId;
  socket.once("open", () => append({ t: Date.now() - rec.startedAtMs, kind: "ws-open", id, computer, path: requestPath }));
  socket.on("message", (data, isBinary) => append({ t: Date.now() - rec.startedAtMs, kind: "ws-in", id, data: frameData(data, isBinary) }));
  socket.once("close", () => append({ t: Date.now() - rec.startedAtMs, kind: "ws-close", id }));
  const original = socket.send;
  (socket as unknown as { send: (...args: unknown[]) => unknown }).send = (...args: unknown[]) => {
    append({ t: Date.now() - rec.startedAtMs, kind: "ws-out", id, data: frameData(args[0], typeof args[1] === "object" && args[1] !== null && (args[1] as { binary?: boolean }).binary === true) });
    return (original as (...a: unknown[]) => unknown).apply(socket, args);
  };
}

// ---------------------------------------------------------------- API
export interface StartTraceOptions { computers?: string[] }

/** Begin recording. `computers` limits it (default: every computer). */
export function startTrace(options: StartTraceOptions = {}): { file: string; startedAt: string } {
  if (current) stopTrace();
  const dir = traceDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const startedAt = new Date().toISOString();
  const file = path.join(dir, `${startedAt.replace(/:/g, "-")}.jsonl`);
  const startedAtMs = Date.now();
  const computers = new Set(options.computers ?? []);
  const all = options.computers === undefined;
  current = { file, startedAtMs, computers, all, bytes: 0, timer: setTimeout(() => stopTrace(), MAX_MS), wsId: 0 };
  current.timer.unref?.();
  const meta = { kind: "meta", version: 1, startedAt, computers: [...computers], desktopVersion: desktopVersion() };
  append(meta);
  return { file, startedAt };
}

/** Stop recording; returns the file, or null when nothing was recording. */
export function stopTrace(): { file: string } | null {
  const rec = current;
  if (!rec) return null;
  clearTimeout(rec.timer);
  current = null;
  return { file: rec.file };
}

export function traceStatus(): TraceStatus {
  const rec = current;
  return {
    recording: !!rec,
    file: rec ? rec.file : null,
    startedAt: rec ? new Date(rec.startedAtMs).toISOString() : null,
    computers: rec ? [...rec.computers] : [],
    bytes: rec ? rec.bytes : 0,
    elapsedMs: rec ? Date.now() - rec.startedAtMs : 0,
  };
}

/** Every trace on disk, newest first, with its size and time. */
export function listTraces(): TraceRecord[] {
  let names: string[];
  try {
    names = readdirSync(traceDir()).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const records: TraceRecord[] = [];
  for (const name of names) {
    const file = path.join(traceDir(), name);
    try {
      const info = statSync(file);
      records.push({ file, name, size: info.size, modifiedAt: info.mtime.toISOString() });
    } catch {
      // A file that vanished between listing and stat is simply skipped.
    }
  }
  return records.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

import { connect } from "node:net";
import type { Readable, Writable } from "node:stream";
import type { ZodType } from "zod";
import { BridgeError } from "./protocol.js";
import {
  findingWriteSchema, isBranchName, isRepoPath, isSearchText, MAX_FILE_PATHS, MAX_FINDING_BODY, PROJECT_NAME,
} from "./gitboy-contract.js";

// A scoped SSH key reaches the Hook through this gateway instead of the full
// byte pipe. The key's forced command names the scope
// (`sh ~/.local/share/phren/bridge/dispatch-scoped gitboy-read`); the gateway
// reads one HTTP request from the SSH channel, admits it only if the scope
// allows that exact method, path, query and body, and then sends the Hook a
// request it builds itself from the validated values. The client's bytes never
// reach the socket, so extra headers, query keys, JSON fields, pipelined
// requests and upgrades cannot widen the scope.

export const GATEWAY_SCOPES = ["gitboy-read", "gitboy-write"] as const;
export type GatewayScope = typeof GATEWAY_SCOPES[number];
/** The authorized_keys comment each scope's key carries. */
export const SCOPE_KEY_COMMENT: Record<GatewayScope, string> = { "gitboy-read": "phren-gitboy", "gitboy-write": "phren-gitboy-write" };
/** The only SSH command a scoped key may send, the same one the phone's pipe uses. */
export const SCOPED_COMMAND = "phren-hook v1 pipe";

/** Room for 500 repository paths in one query string; the Hook allows the same. */
const MAX_HEAD = 256 * 1024;
const MAX_HEADER_LINE = 8192;
const MAX_HEADERS = 32;
const READ_TIMEOUT_MS = 10_000;
const PROJECT = PROJECT_NAME.source.slice(1, -1);

type Query = Map<string, string[]>;
interface Rule {
  method: "GET" | "POST";
  path: RegExp;
  /** Allowed query keys; a key missing here refuses the request. Returns the canonical pairs or a refusal reason. */
  query?: (query: Query) => [string, string][] | string;
  body?: { max: number; schema: ZodType };
}

const one = (query: Query, key: string): string | undefined => query.get(key)?.length === 1 ? query.get(key)![0] : undefined;
const only = (query: Query, keys: string[]) => [...query.keys()].every(key => keys.includes(key));

const RULES: Record<GatewayScope, Rule[]> = {
  "gitboy-read": [
    { method: "GET", path: new RegExp(`^/v1/projects/${PROJECT}/memory$`) },
    { method: "GET", path: new RegExp(`^/v1/projects/${PROJECT}/memory/files$`), query: query => {
      const paths = query.get("path") ?? [];
      if (!only(query, ["path"]) || paths.length < 1 || paths.length > MAX_FILE_PATHS) return `Send 1 to ${MAX_FILE_PATHS} path parameters and nothing else.`;
      if (!paths.every(isRepoPath)) return "Each path must be repository-relative.";
      return paths.map(value => ["path", value]);
    } },
    { method: "GET", path: new RegExp(`^/v1/projects/${PROJECT}/memory/search$`), query: query => {
      const q = one(query, "q"), limit = query.has("limit") ? one(query, "limit") : "5";
      if (!only(query, ["q", "limit"]) || q === undefined || limit === undefined) return "Send one q and at most one limit.";
      if (!isSearchText(q)) return "q must be 1 to 1000 characters of text.";
      if (!/^(?:[1-9]|1\d|20)$/.test(limit)) return "limit must be 1 to 20.";
      return [["q", q], ["limit", limit]];
    } },
    { method: "GET", path: new RegExp(`^/v1/projects/${PROJECT}/tasks$`), query: query => {
      const branch = one(query, "branch");
      if (!only(query, ["branch"]) || branch === undefined || !isBranchName(branch)) return "Send one valid branch.";
      return [["branch", branch]];
    } },
  ],
  "gitboy-write": [
    { method: "POST", path: new RegExp(`^/v1/projects/${PROJECT}/findings$`), body: { max: MAX_FINDING_BODY, schema: findingWriteSchema } },
  ],
};

const DESCRIBE: Record<GatewayScope, string> = {
  "gitboy-read": "GET /v1/projects/<project>/memory, /memory/files, /memory/search and /tasks",
  "gitboy-write": "POST /v1/projects/<project>/findings",
};

export function isGatewayScope(value: string): value is GatewayScope {
  return (GATEWAY_SCOPES as readonly string[]).includes(value);
}

export type Admission = { ok: true; request: string } | { ok: false; status: number; error: string };
const refuse = (status: number, error: string) => ({ ok: false as const, status, error });

interface Head { method: string; path: string; query: string | null; contentLength: number; json: boolean }

function parseHead(head: string): Head | ReturnType<typeof refuse> {
  const lines = head.split("\r\n");
  if (lines.length < 3 || lines.at(-1) !== "" || lines.at(-2) !== "") return refuse(400, "Malformed request.");
  const request = /^([A-Z]+) (\/[^\s?#]*)(?:\?([^\s#]*))? HTTP\/1\.[01]$/.exec(lines[0]);
  if (!request) return refuse(400, "Malformed request.");
  const headers = lines.slice(1, -2);
  if (headers.length > MAX_HEADERS) return refuse(400, "Too many headers.");
  let contentLength: number | undefined, json = false;
  for (const header of headers) {
    if (header.length > MAX_HEADER_LINE) return refuse(400, "Header too large.");
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*?)[ \t]*$/.exec(header);
    if (!match) return refuse(400, "Malformed request.");
    const name = match[1].toLowerCase();
    if (name === "transfer-encoding" || name === "upgrade" || name === "expect") return refuse(400, "Send a plain request with a Content-Length body, if any.");
    if (name === "content-length") {
      if (contentLength !== undefined || !/^\d{1,7}$/.test(match[2])) return refuse(400, "Invalid Content-Length.");
      contentLength = Number(match[2]);
    }
    if (name === "content-type") json = /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(match[2]);
  }
  return { method: request[1], path: request[2], query: request[3] ?? null, contentLength: contentLength ?? 0, json };
}

function parseQuery(raw: string): Query | undefined {
  const query: Query = new Map();
  for (const pair of raw.split("&")) {
    const match = /^([a-z]{1,10})=([A-Za-z0-9._~%+!$'()*,;:@\/-]*)$/.exec(pair);
    if (!match) return undefined;
    let value: string;
    try { value = decodeURIComponent(match[2].replace(/\+/g, " ")); } catch { return undefined; }
    query.set(match[1], [...(query.get(match[1]) ?? []), value]);
  }
  return query;
}

function findRule(scope: GatewayScope, head: Head): Rule | undefined {
  return RULES[scope].find(rule => rule.method === head.method && rule.path.test(head.path));
}

/** Decide one request: its head (through the blank line) and the bytes after it. */
export function admitScopedRequest(scope: GatewayScope, rawHead: string, rest: Buffer = Buffer.alloc(0)): Admission {
  const head = parseHead(rawHead);
  if ("ok" in head) return head;
  const rule = findRule(scope, head);
  if (!rule) return refuse(403, `This key only permits ${DESCRIBE[scope]}.`);
  let target = head.path;
  if (rule.query) {
    if (head.query === null) return refuse(400, "This route needs its query parameters.");
    const query = parseQuery(head.query);
    if (!query) return refuse(400, "Malformed query.");
    const pairs = rule.query(query);
    if (typeof pairs === "string") return refuse(400, pairs);
    target += `?${new URLSearchParams(pairs).toString()}`;
  } else if (head.query !== null) return refuse(400, "This route takes no query.");
  if (!rule.body) {
    if (head.contentLength !== 0 || rest.length > 0) return refuse(400, "Send one request with no body.");
    return { ok: true, request: `${rule.method} ${target} HTTP/1.1\r\nHost: phren.local\r\nConnection: close\r\n\r\n` };
  }
  if (!head.json) return refuse(415, "Send Content-Type: application/json.");
  if (head.contentLength < 1 || head.contentLength > rule.body.max) return refuse(413, `The body must be 1 to ${rule.body.max} bytes.`);
  if (rest.length !== head.contentLength) return refuse(400, "The body must match Content-Length, with nothing after it.");
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rest)); } catch { return refuse(400, "The body is not JSON."); }
  const checked = rule.body.schema.safeParse(parsed);
  if (!checked.success) return refuse(400, `Invalid body: ${checked.error.issues.map(issue => `${issue.path.join(".") || "body"} ${issue.message}`).join("; ").slice(0, 300)}`);
  const body = JSON.stringify(checked.data);
  return { ok: true, request: `${rule.method} ${target} HTTP/1.1\r\nHost: phren.local\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}` };
}

const REASONS: Record<number, string> = { 400: "Bad Request", 403: "Forbidden", 408: "Request Timeout", 413: "Content Too Large", 415: "Unsupported Media Type", 503: "Service Unavailable" };
function httpResponse(status: number, error: string): string {
  const body = JSON.stringify({ error, code: status === 503 ? "hook-unavailable" : "scope-refused" });
  return `HTTP/1.1 ${status} ${REASONS[status] ?? "Bad Request"}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

type Read = { head: string; rest: Buffer } | { status: number; error: string };

/** Read the head, then, when the scope has a body route and the head declares
 *  a body within its cap, exactly that many bytes. Stops at a limit, the
 *  timeout or EOF; bytes beyond the request make it refused. */
function readRequest(scope: GatewayScope, input: Readable): Promise<Read> {
  const bodyCap = Math.max(0, ...RULES[scope].map(rule => rule.body?.max ?? 0));
  return new Promise(resolve => {
    let buffer = Buffer.alloc(0), headEnd = -1, wanted = 0;
    const finish = (value: Read) => {
      clearTimeout(timer); input.off("data", data); input.off("end", end); input.off("error", end); input.pause();
      resolve(value);
    };
    const complete = () => finish({ head: buffer.subarray(0, headEnd).toString("latin1"), rest: buffer.subarray(headEnd) });
    const data = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (headEnd === -1) {
        const at = buffer.indexOf("\r\n\r\n");
        if (at === -1 || at + 4 > MAX_HEAD) {
          if (buffer.length > MAX_HEAD) finish({ status: 400, error: "Request is too large." });
          return;
        }
        headEnd = at + 4;
        const declared = /\r\ncontent-length:[ \t]*(\d{1,7})[ \t]*\r\n/i.exec(buffer.subarray(0, headEnd).toString("latin1"));
        // Over the cap, admission refuses it without waiting for the bytes.
        wanted = declared && Number(declared[1]) <= bodyCap ? Number(declared[1]) : 0;
      }
      if (buffer.length - headEnd >= wanted) complete();
    };
    const end = () => headEnd === -1 ? finish({ status: 400, error: "Malformed request." }) : complete();
    const timer = setTimeout(() => finish({ status: 408, error: "The request did not arrive in time." }), READ_TIMEOUT_MS);
    input.on("data", data); input.once("end", end); input.once("error", end);
  });
}

export interface ScopedIO { input: Readable; output: Writable; socket: string }

/**
 * Serve one scoped SSH session. Commands other than the pipe are refused
 * outright; a refused request gets an HTTP error on the channel so the client
 * reads a normal response.
 */
export async function scopedDispatch(scope: string, command: string, io: ScopedIO): Promise<void> {
  if (!isGatewayScope(scope)) throw new BridgeError(403, "Unknown key scope.");
  if (command !== SCOPED_COMMAND) throw new BridgeError(403, `This SSH key only permits \`${SCOPED_COMMAND}\` with ${DESCRIBE[scope]}.`);
  const read = await readRequest(scope, io.input);
  const admission = "head" in read ? admitScopedRequest(scope, read.head, read.rest) : refuse(read.status, read.error);
  if (!admission.ok) {
    await new Promise<void>(done => io.output.write(httpResponse(admission.status, admission.error), () => done()));
    return;
  }
  await new Promise<void>(resolve => {
    const socket = connect(io.socket);
    let answered = false;
    socket.once("data", () => { answered = true; });
    socket.on("connect", () => {
      // Never half-close: the Hook answers and closes (Connection: close).
      socket.write(admission.request);
      socket.pipe(io.output, { end: false });
    });
    socket.on("error", () => {
      if (answered) return;
      answered = true;
      io.output.write(httpResponse(503, "Phren Hook is not running on this computer."));
    });
    socket.on("close", () => resolve());
  });
}

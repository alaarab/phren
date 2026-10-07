import { connect } from "node:net";
import type { Readable, Writable } from "node:stream";
import { BridgeError } from "./protocol.js";

// A scoped SSH key reaches the Hook through this gateway instead of the full
// byte pipe. The key's forced command names the scope
// (`sh ~/.local/share/phren/bridge/dispatch-scoped gitboy-read`); the gateway
// reads one HTTP request head from the SSH channel, admits it only if the
// scope allows that exact method and path, and then sends the Hook a request
// it builds itself. The client's bytes never reach the socket, so headers,
// bodies, pipelined requests and upgrades cannot widen the scope.

export const GATEWAY_SCOPES = ["gitboy-read"] as const;
export type GatewayScope = typeof GATEWAY_SCOPES[number];
/** The authorized_keys comment each scope's key carries. */
export const SCOPE_KEY_COMMENT: Record<GatewayScope, string> = { "gitboy-read": "phren-gitboy" };
/** The only SSH command a scoped key may send, the same one the phone's pipe uses. */
export const SCOPED_COMMAND = "phren-hook v1 pipe";

const MAX_HEAD = 8192;
const HEAD_TIMEOUT_MS = 10_000;
const ROUTES: Record<GatewayScope, RegExp> = {
  "gitboy-read": /^\/v1\/projects\/[a-z0-9][a-z0-9_-]{0,99}\/memory$/,
};

export function isGatewayScope(value: string): value is GatewayScope {
  return (GATEWAY_SCOPES as readonly string[]).includes(value);
}

export type Admission = { ok: true; path: string } | { ok: false; status: number; error: string };

const refuse = (status: number, error: string): Admission => ({ ok: false, status, error });

/** Decide one request head (everything up to and including the blank line). */
export function admitScopedRequest(scope: GatewayScope, head: string, trailing = 0): Admission {
  if (trailing > 0) return refuse(400, "Send one request with no body.");
  const lines = head.split("\r\n");
  if (lines.length < 3 || lines.at(-1) !== "" || lines.at(-2) !== "") return refuse(400, "Malformed request.");
  const request = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(lines[0]);
  if (!request) return refuse(400, "Malformed request.");
  const headers = lines.slice(1, -2);
  for (const header of headers) {
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*?)[ \t]*$/.exec(header);
    if (!match) return refuse(400, "Malformed request.");
    const name = match[1].toLowerCase();
    if (name === "transfer-encoding" || name === "upgrade" || name === "expect") return refuse(400, "Send one request with no body.");
    if (name === "content-length" && match[2] !== "0") return refuse(400, "Send one request with no body.");
  }
  if (request[1] !== "GET") return refuse(403, `This key only permits GET ${describeScope(scope)}.`);
  if (!ROUTES[scope].test(request[2])) return refuse(403, `This key only permits GET ${describeScope(scope)}.`);
  return { ok: true, path: request[2] };
}

function describeScope(scope: GatewayScope): string {
  return scope === "gitboy-read" ? "/v1/projects/<project>/memory" : scope;
}

function httpResponse(status: number, error: string): string {
  const body = JSON.stringify({ error, code: status === 503 ? "hook-unavailable" : "scope-refused" });
  const reason = ({ 403: "Forbidden", 408: "Request Timeout", 503: "Service Unavailable" } as Record<number, string>)[status] ?? "Bad Request";
  return `HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

/** Read bytes until the head's blank line, the size limit, the timeout or EOF. */
function readHead(input: Readable): Promise<{ head: string; trailing: number } | { status: number; error: string }> {
  return new Promise(resolve => {
    let buffer = Buffer.alloc(0);
    const finish = (value: { head: string; trailing: number } | { status: number; error: string }) => {
      clearTimeout(timer); input.off("data", data); input.off("end", end); input.off("error", end); input.pause();
      resolve(value);
    };
    const data = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const at = buffer.indexOf("\r\n\r\n");
      if (at !== -1 && at + 4 <= MAX_HEAD) finish({ head: buffer.subarray(0, at + 4).toString("latin1"), trailing: buffer.length - at - 4 });
      else if (buffer.length > MAX_HEAD) finish({ status: 400, error: "Request is too large." });
    };
    const end = () => finish({ status: 400, error: "Malformed request." });
    const timer = setTimeout(() => finish({ status: 408, error: "No request arrived." }), HEAD_TIMEOUT_MS);
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
  if (command !== SCOPED_COMMAND) throw new BridgeError(403, `This SSH key only permits \`${SCOPED_COMMAND}\` with GET ${describeScope(scope)}.`);
  const read = await readHead(io.input);
  const admission = "head" in read ? admitScopedRequest(scope, read.head, read.trailing) : refuse(read.status, read.error);
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
      socket.write(`GET ${admission.path} HTTP/1.1\r\nHost: phren.local\r\nConnection: close\r\n\r\n`);
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

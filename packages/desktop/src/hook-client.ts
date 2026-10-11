// A raw byte pipe to a computer's Hook. Local talks to the Unix socket;
// remote rides a fresh SSH process, so either can carry one HTTP request or
// one WebSocket.
import { spawn } from "node:child_process";
import { request, type IncomingHttpHeaders } from "node:http";
import { connect } from "node:net";
import path from "node:path";
import { Duplex } from "node:stream";
import { WebSocket } from "ws";
import type { Computer, HookRequest, HookResponse, HookWebSocket, OpenHookPipe } from "./contract.js";
import { channelPool } from "./channel-pool.js";
import { bridgeRoot, sshArgs } from "./hosts.js";
import { recordHttp, recordWebSocket } from "./trace.js";

const MAX_BODY = 16 * 1024 * 1024;
const REQUEST_TIMEOUT = 60_000;
const HANDSHAKE_TIMEOUT = 20_000;

export const openHookPipe: OpenHookPipe = c => c.local ? localPipe() : remotePipe(c);

function localPipe(): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const socket = connect(path.join(bridgeRoot(), "hook.sock"));
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function remotePipe(c: Computer): Promise<Duplex> {
  // One master slot per pipe: the pool spreads the desktop's concurrent
  // channels over up to 4 connections so sshd's per-connection MaxSessions
  // (10) is never exceeded.
  const channel = await channelPool.acquire(c.name);
  let released = false;
  const release = (): void => { if (released) return; released = true; channel.release(); };
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("ssh", sshArgs(c, "phren-hook v1 pipe", { slot: channel.slot }), { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      release();
      reject(error);
      return;
    }
    const stdout = child.stdout!;
    const stdin = child.stdin!;
    let diagnostic = "";
    let sawData = false;
    let settled = false;
    // Keep only stderr's tail: SSH explains connection failures on its last line.
    child.stderr!.on("data", (bytes: Buffer) => { diagnostic = (diagnostic + bytes.toString()).slice(-4096); });
    const pipe = new Duplex({
      read() { stdout.resume(); },
      write(chunk, encoding, callback) { stdin.write(chunk, encoding, callback); },
      final(callback) { stdin.end(callback); },
      destroy(error, callback) { child.kill(); release(); callback(error); },
    });
    stdout.on("data", chunk => { sawData = true; if (!pipe.push(chunk)) stdout.pause(); });
    stdout.on("end", () => pipe.push(null));
    stdout.on("error", error => pipe.destroy(error));
    stdin.on("error", error => pipe.destroy(error));
    child.on("error", error => { if (!settled) { settled = true; release(); reject(error); } else pipe.destroy(error); });
    child.on("spawn", () => { if (!settled) { settled = true; resolve(pipe); } });
    // SSH exiting before the first byte means the pipe never connected.
    child.on("exit", code => {
      release();
      if (code === 0 || sawData) return;
      const error = new Error(stderrLine(diagnostic) || `ssh exited with code ${code ?? "unknown"}.`);
      if (!settled) { settled = true; reject(error); } else pipe.destroy(error);
    });
  });
}

function stderrLine(diagnostic: string): string {
  return diagnostic.split(/\r?\n/).map(text => text.replace(/[\x00-\x1f\x7f]/g, " ").trim()).filter(Boolean).pop() ?? "";
}

export const hookRequest: HookRequest = async (c, method, requestPath, body) => {
  try {
    const response = await requestOnce(c, method, requestPath, body);
    recordHttp(c, method, requestPath, body, response);
    return response;
  } catch (error) {
    recordHttp(c, method, requestPath, body, null, error instanceof Error ? error.message : String(error));
    throw error;
  }
};

async function requestOnce(c: Computer, method: string, requestPath: string, body?: unknown): Promise<HookResponse> {
  const pipe = await openHookPipe(c);
  return new Promise<HookResponse>((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request({
      createConnection: () => pipe,
      method,
      path: requestPath,
      headers: {
        Host: "phren.local",
        Connection: "close",
        "X-Phren-Client": "desktop",
        ...(payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": payload.byteLength }),
      },
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) req.destroy(new Error("Hook response exceeds 16 MiB."));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: lowerHeaders(response.headers), body: Buffer.concat(chunks) }));
    });
    const timer = setTimeout(() => req.destroy(new Error("Hook request timed out after 60 s.")), REQUEST_TIMEOUT);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end(payload);
  });
}

function lowerHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers))
    if (value !== undefined) out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  return out;
}

export const hookWebSocket: HookWebSocket = async (c, requestPath) => {
  const pipe = await openHookPipe(c);
  const socket = new WebSocket(`ws://phren.local${requestPath}`, {
    createConnection: () => pipe,
    perMessageDeflate: false,
    headers: { Host: "phren.local", "X-Phren-Client": "desktop" },
  });
  recordWebSocket(socket, c.name, requestPath);
  return new Promise((resolve, reject) => {
    // A Hook that accepts the connection but never answers the upgrade must not
    // hold an SSH channel (and its pool slot) forever.
    const deadline = setTimeout(() => {
      socket.terminate();
      pipe.destroy();
      reject(new Error("The Hook did not answer the WebSocket handshake in 20 s."));
    }, HANDSHAKE_TIMEOUT);
    socket.once("open", () => clearTimeout(deadline));
    socket.once("error", () => clearTimeout(deadline));
    socket.once("close", () => clearTimeout(deadline));
    // The Hook can send its first frame in the same chunk as the handshake, before
    // the caller attaches a listener; hold frames until the caller's .then has run.
    socket.once("open", () => { socket.pause(); resolve(socket); setImmediate(() => socket.resume()); });
    socket.once("error", reject);
    socket.once("unexpected-response", (req, response) => {
      req.destroy();
      pipe.destroy();
      reject(new Error(`Hook WebSocket handshake failed with status ${response.statusCode ?? 0}.`));
    });
    socket.once("close", () => pipe.destroy());
  });
};

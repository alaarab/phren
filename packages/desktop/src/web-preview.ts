// A local TCP listener that relays bytes to a web server on a computer. The
// listener is the preview: the UI opens it in an iframe; for a remote computer
// each accepted connection rides `ssh … "phren-hook v1 web 127.0.0.1 <port>"`,
// for this computer it connects straight to the loopback port. Closing happens
// after 30 idle minutes so a forgotten tab does not hold an SSH channel open.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { connect, createServer, type Server, type Socket } from "node:net";
import { Duplex } from "node:stream";
import type { Computer } from "./contract.js";
import { sshArgs } from "./hosts.js";

const IDLE_MS = 30 * 60_000;
const MAX_HEAD = 16 * 1024;

/** Whether a request head names exactly `127.0.0.1:<port>` as its Host. Exported for tests. */
export function hostMatches(head: string, port: number): boolean {
  const hosts = head.split("\r\n").slice(1).filter((line) => /^host:/i.test(line));
  return hosts.length === 1 && hosts[0].slice(5).trim().toLowerCase() === `127.0.0.1:${port}`;
}
const SWEEP_MS = 60_000;

/** One open preview, the shape `/api/previews` answers with. */
export interface WebPreview {
  id: string;
  computer: string;
  port: number;
  localPort: number;
  url: string;
  openedAt: string;
  lastActiveAt: string;
}

class Relay {
  readonly id = randomUUID();
  readonly openedAt = Date.now();
  lastActiveAt = Date.now();
  private active = 0;
  private readonly sockets = new Set<Socket>();
  private readonly server: Server;
  private localPort = 0;

  constructor(readonly computer: Computer, readonly port: number) {
    this.server = createServer((socket) => this.handle(socket));
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        const address = this.server.address();
        this.localPort = typeof address === "object" && address ? address.port : 0;
        resolve(this.localPort);
      });
    });
  }

  private handle(socket: Socket): void {
    this.active += 1;
    this.lastActiveAt = Date.now();
    this.sockets.add(socket);
    // Check the first request's Host before connecting anything: reached as
    // localhost:<port>, the browser would send the app's localhost cookie, which
    // must never be relayed to the previewed server. Browsers pool connections
    // per host and port, so one connection never carries both names.
    let head = Buffer.alloc(0);
    const release = (): void => {
      if (!this.sockets.delete(socket)) return;
      this.active -= 1;
      this.lastActiveAt = Date.now();
    };
    const onEarlyClose = (): void => release();
    const onHead = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0 && head.length < MAX_HEAD) return;
      socket.off("data", onHead);
      socket.off("close", onEarlyClose);
      socket.pause();
      if (end < 0 || !hostMatches(head.subarray(0, end).toString("latin1"), this.localPort)) {
        socket.end("HTTP/1.1 421 Misdirected Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        socket.on("close", release);
        return;
      }
      this.relay(socket, head, release);
    };
    socket.on("error", () => socket.destroy());
    socket.on("close", onEarlyClose);
    socket.on("data", onHead);
  }

  private relay(socket: Socket, head: Buffer, release: () => void): void {
    let remote: Duplex;
    try {
      remote = this.connect();
    } catch {
      release();
      socket.destroy();
      return;
    }
    socket.on("error", () => remote.destroy());
    remote.on("error", () => socket.destroy());
    socket.on("close", () => {
      release();
      remote.destroy();
    });
    remote.write(head);
    socket.pipe(remote).pipe(socket);
    socket.resume();
  }

  private connect(): Duplex {
    if (this.computer.local) return connect({ host: "127.0.0.1", port: this.port });
    const child = spawn("ssh", sshArgs(this.computer, `phren-hook v1 web 127.0.0.1 ${this.port}`), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = child.stdout!;
    const stdin = child.stdin!;
    const pipe = new Duplex({
      read() { stdout.resume(); },
      write(chunk, encoding, callback) { stdin.write(chunk, encoding, callback); },
      final(callback) { stdin.end(callback); },
      destroy(error, callback) { child.kill(); callback(error); },
    });
    stdout.on("data", (chunk: Buffer) => { if (!pipe.push(chunk)) stdout.pause(); });
    stdout.on("end", () => pipe.push(null));
    stdout.on("error", (error) => pipe.destroy(error));
    stdin.on("error", (error) => pipe.destroy(error));
    child.on("error", (error) => pipe.destroy(error));
    return pipe;
  }

  idle(): boolean {
    return this.active === 0;
  }

  describe(localPort: number): WebPreview {
    return {
      id: this.id,
      computer: this.computer.name,
      port: this.port,
      localPort,
      // 127.0.0.1, never localhost: the daemon's cookie is host-only on localhost and
      // cookies are not port-scoped, so a preview must not share that host name.
      url: `http://127.0.0.1:${localPort}/`,
      openedAt: new Date(this.openedAt).toISOString(),
      lastActiveAt: new Date(this.lastActiveAt).toISOString(),
    };
  }

  close(): void {
    this.server.close();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.active = 0;
  }
}

const relays = new Map<string, Relay>();
const ports = new Map<string, number>();

/** Open a preview of `port` on `computer`; resolves once the listener is bound. */
export async function openPreview(computer: Computer, port: number): Promise<WebPreview> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port.");
  const relay = new Relay(computer, port);
  const localPort = await relay.listen();
  relays.set(relay.id, relay);
  ports.set(relay.id, localPort);
  return relay.describe(localPort);
}

/** Every open preview, most recent last. */
export function listPreviews(): WebPreview[] {
  return [...relays.values()].map((relay) => relay.describe(ports.get(relay.id) ?? 0));
}

/** One preview by id, or undefined. */
export function getPreview(id: string): WebPreview | undefined {
  const relay = relays.get(id);
  return relay ? relay.describe(ports.get(id) ?? 0) : undefined;
}

/** Close one preview; true when it existed. */
export function closePreview(id: string): boolean {
  const relay = relays.get(id);
  if (!relay) return false;
  relay.close();
  relays.delete(id);
  ports.delete(id);
  return true;
}

/** Close every preview (server shutdown). */
export function closeAllPreviews(): void {
  for (const relay of relays.values()) relay.close();
  relays.clear();
  ports.clear();
}

function sweep(): void {
  const now = Date.now();
  for (const [id, relay] of relays) {
    if (relay.idle() && now - relay.lastActiveAt > IDLE_MS) closePreview(id);
  }
}

setInterval(sweep, SWEEP_MS).unref();

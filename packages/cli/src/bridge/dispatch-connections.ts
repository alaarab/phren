import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Duplex } from "node:stream";
import WebSocket, { type RawData } from "ws";
import { dispatchKeyPath } from "./computers.js";
import { peerSSHArgs, type HookPeer } from "./peers.js";
import { BridgeError, bridgeRoot, MAX_FRAME, object, type Json } from "./protocol.js";

export interface DispatchStream {
  readonly closed: Promise<Error | undefined>;
  close(): void;
}

export type DispatchStreamFactory = (peer: HookPeer, route: string, onFrame: (frame: Json) => void) => Promise<DispatchStream>;

function transportError(diagnostic: string): BridgeError {
  if (/Permission denied/i.test(diagnostic)) return new BridgeError(403, "The remote computer has not enrolled this dispatch key.");
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(diagnostic)) {
    return new BridgeError(403, "The remote SSH host key does not match its pin.");
  }
  return new BridgeError(503, "The remote Hook report stream is unavailable.");
}

/** One pinned SSH byte pipe carries one WebSocket. OpenSSH multiplexing and
 * user SSH configuration stay disabled, matching placement transport. */
export async function openPeerStream(peer: HookPeer, route: string, onFrame: (frame: Json) => void): Promise<DispatchStream> {
  const root = bridgeRoot(), key = dispatchKeyPath(root);
  const keyInfo = await lstat(key).catch(() => undefined);
  if (!keyInfo?.isFile() || keyInfo.isSymbolicLink() || (keyInfo.mode & 0o077)) {
    throw new BridgeError(409, "Run phren bridge enroll-computer on this computer first (private key mode 0600).");
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(root, "report-peer-"));
  const knownHosts = path.join(temporary, "known_hosts");
  await writeFile(knownHosts, `phren-peer ${peer.hostKey}\n`, { mode: 0o600 });
  const child = spawn("ssh", peerSSHArgs(peer, knownHosts, key), { stdio: ["pipe", "pipe", "pipe"] });
  let diagnostic = "", settled = false, failureTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveClosed!: (error?: Error) => void;
  const closed = new Promise<Error | undefined>(resolve => { resolveClosed = resolve; });
  const pipe = new Duplex({
    read() { child.stdout.resume(); },
    write(chunk, encoding, callback) { child.stdin.write(chunk, encoding, callback); },
    final(callback) { child.stdin.end(callback); },
    destroy(error, callback) { child.kill(); callback(error); },
  });
  child.stdout.on("data", chunk => { if (!pipe.push(chunk)) child.stdout.pause(); });
  child.stdout.on("end", () => pipe.push(null));
  child.stdout.on("error", error => pipe.destroy(error));
  child.stdin.on("error", error => pipe.destroy(error));
  child.stderr.on("data", bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-4096); });

  const url = new URL(route, "ws://phren.local");
  if (url.origin !== "ws://phren.local") {
    pipe.destroy(); await rm(temporary, { recursive: true, force: true });
    throw new BridgeError(400, "Invalid remote report route.");
  }
  const socket = new WebSocket(url, { createConnection: () => pipe, handshakeTimeout: 15_000, perMessageDeflate: false, maxPayload: MAX_FRAME });
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true; clearTimeout(failureTimer); pipe.destroy(); child.kill();
    void rm(temporary, { recursive: true, force: true }).finally(() => resolveClosed(error));
  };
  const failAfterDiagnostic = () => {
    if (settled || failureTimer) return;
    failureTimer = setTimeout(() => finish(transportError(diagnostic)), 25);
  };
  pipe.on("error", failAfterDiagnostic);
  child.on("error", () => finish(transportError(diagnostic)));
  child.on("exit", code => finish(code === 0 ? undefined : transportError(diagnostic)));
  socket.on("message", (bytes: RawData) => {
    try {
      const data = Buffer.isBuffer(bytes) ? bytes : Array.isArray(bytes) ? Buffer.concat(bytes) : Buffer.from(bytes as ArrayBuffer);
      if (data.length > MAX_FRAME) throw new Error("Oversized report frame");
      onFrame(object(JSON.parse(data.toString())));
    } catch { finish(new BridgeError(502, "The remote Hook sent an invalid report frame.")); }
  });
  socket.on("close", () => finish());
  socket.on("error", failAfterDiagnostic);
  try {
    await new Promise<void>((resolve, reject) => {
      if (socket.readyState === WebSocket.OPEN) { resolve(); return; }
      const opened = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); void closed.then(error => reject(error ?? transportError(diagnostic))); };
      const cleanup = () => { socket.off("open", opened); socket.off("error", failed); socket.off("close", failed); };
      socket.once("open", opened); socket.once("error", failed); socket.once("close", failed);
    });
  } catch (error) {
    finish(error instanceof Error ? error : transportError(diagnostic));
    await closed; throw error;
  }
  return { closed, close: () => { if (socket.readyState !== WebSocket.CLOSED) socket.terminate(); finish(); } };
}

interface QueueEntry {
  peer: HookPeer;
  route: string;
  onFrame: (frame: Json) => void;
  resolve: (stream: DispatchStream) => void;
  reject: (error: unknown) => void;
}

/** FIFO-ish bounded stream admission. A peer at its eight-stream limit does
 * not head-of-line block another peer while total capacity remains. */
export class DispatchConnections {
  private total = 0;
  private readonly perPeer = new Map<string, number>();
  private readonly active = new Set<DispatchStream>();
  private readonly queue: QueueEntry[] = [];
  private readonly idlePeers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(private readonly factory: DispatchStreamFactory = openPeerStream,
    private readonly maxPerPeer = 8, private readonly maxTotal = 16, private readonly idleMs = 90_000) {}

  open(peer: HookPeer, route: string, onFrame: (frame: Json) => void): Promise<DispatchStream> {
    if (this.stopped) return Promise.reject(new BridgeError(503, "Dispatch report connections are closed."));
    return new Promise((resolve, reject) => { this.queue.push({ peer, route, onFrame, resolve, reject }); this.pump(); });
  }

  private pump(): void {
    if (this.stopped) return;
    while (this.total < this.maxTotal) {
      const index = this.queue.findIndex(entry => (this.perPeer.get(entry.peer.name) ?? 0) < this.maxPerPeer);
      if (index < 0) return;
      const [entry] = this.queue.splice(index, 1);
      this.total++; this.perPeer.set(entry.peer.name, (this.perPeer.get(entry.peer.name) ?? 0) + 1);
      const idle = this.idlePeers.get(entry.peer.name); if (idle) clearTimeout(idle); this.idlePeers.delete(entry.peer.name);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const touch = () => {
        clearTimeout(timer);
        timer = setTimeout(() => stream?.close(), this.idleMs); timer.unref?.();
      };
      let stream: DispatchStream | undefined;
      void this.factory(entry.peer, entry.route, frame => { touch(); entry.onFrame(frame); }).then(opened => {
        if (this.stopped) {
          opened.close(); this.release(entry.peer.name);
          entry.reject(new BridgeError(503, "Dispatch report connections are closed.")); return;
        }
        stream = opened; this.active.add(opened); touch(); entry.resolve(opened);
        void opened.closed.then(() => this.release(entry.peer.name, opened, timer));
      }, error => { clearTimeout(timer); this.release(entry.peer.name); entry.reject(error); });
    }
  }

  private release(peer: string, stream?: DispatchStream, timer?: ReturnType<typeof setTimeout>): void {
    clearTimeout(timer);
    if (stream && !this.active.delete(stream)) return;
    this.total = Math.max(0, this.total - 1);
    const count = Math.max(0, (this.perPeer.get(peer) ?? 1) - 1);
    if (count) this.perPeer.set(peer, count);
    else {
      this.perPeer.delete(peer);
      const timer = setTimeout(() => this.idlePeers.delete(peer), this.idleMs); timer.unref?.();
      this.idlePeers.set(peer, timer);
    }
    this.pump();
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const entry of this.queue.splice(0)) entry.reject(new BridgeError(503, "Dispatch report connections are closed."));
    for (const timer of this.idlePeers.values()) clearTimeout(timer);
    this.idlePeers.clear();
    for (const stream of [...this.active]) stream.close();
  }

  get counts(): { total: number; queued: number; peers: Record<string, number> } {
    return { total: this.total, queued: this.queue.length, peers: Object.fromEntries(this.perPeer) };
  }
}

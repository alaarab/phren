import { spawn as spawnChild } from "node:child_process";
import type { Readable } from "node:stream";
import { BridgeError, type Json } from "./protocol.js";
import { bootedSimulators, SIMULATOR_UDID, verifiedHelper } from "./simulators.js";

/**
 * `WS /v1/simulators/stream?udid=&fps=&size=&quality=`: one booted
 * simulator's screen, live. The native helper (native/simcast.swift) reads the
 * device's framebuffer through CoreSimulator, as `simctl io` does, and writes
 * each changed frame as a length-prefixed JPEG; this side forwards them.
 *
 * Why JPEG frames from the framebuffer, not the alternatives:
 * - `simctl io screenshot` took about 1.1 s a shot (Xcode 27.1, M1 Max),
 *   which is today's 1 fps poll and no more.
 * - `simctl io recordVideo` writes a QuickTime movie that is only readable
 *   once finalized, so it cannot feed a live socket.
 * - ScreenCaptureKit on the Simulator window needs a Screen Recording grant
 *   (which macOS re-asks for monthly), captures the window chrome, and stops
 *   when the window is minimized; the framebuffer needs no grant.
 * - H.264 halves the bytes but ties frames together: a dropped frame corrupts
 *   the picture until the next keyframe, so "always the latest frame" would
 *   need keyframe requests across the socket. Every JPEG stands alone, so a
 *   frame the phone can't take yet is simply replaced by the next one.
 * - The helper sends only frames whose framebuffer changed (its IOSurface
 *   seed moved): a still screen costs nothing on the wire.
 *
 * Frames: a text `{ type: "start", format: "jpeg", fps, size, quality, ack }`,
 * then one binary message per frame, each a whole JPEG. A phone that asks
 * with `ack=1` sends `{ type: "ack" }` for each frame it receives, and at
 * most two frames are unacknowledged: the SSH channel and TCP buffers between
 * here and the phone then never hold more than that, so what the phone shows
 * is at most two frames old however slow the link. Without it, a frame is
 * done once written to the gateway's socket. When the stream
 * ends, the socket closes with the reason (1008 for a bad request, 1011 when
 * capture failed); the phone then falls back to `/v1/simulators/screenshot`.
 * Closing the socket stops the helper. Taps and keys stay on
 * `/v1/simulators/action`.
 */

/** A JPEG larger than this is a broken helper, not a frame. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
/** The wire budget: about 24 Mbit/s, so animations at full rate on Wi-Fi, and
 * the phone asks for a smaller `size` on a slower link. */
export const STREAM_BYTES_PER_SECOND = 3 * 1024 * 1024;
/** Each stream runs its own helper; a few phones may watch at once. */
export const MAX_STREAMS = 4;
const OPEN = 1;

export interface StreamOptions { udid: string; fps: number; size: number; quality: number; ack: boolean }
/** Frames in flight when the phone acknowledges them: one decoding on the
 * phone while the next crosses the network. */
export const ACK_WINDOW = 2;

/** The query, validated before anything runs. */
export function streamOptions(query: URLSearchParams): StreamOptions {
  const udid = query.get("udid") ?? "";
  if (!SIMULATOR_UDID.test(udid)) throw new BridgeError(400, "Invalid simulator identifier.");
  const int = (name: string, fallback: number, min: number, max: number): number => {
    const raw = query.get(name);
    if (raw === null) return fallback;
    if (!/^\d{1,5}$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new BridgeError(400, `${name} must be a whole number from ${min} to ${max}.`);
    return Number(raw);
  };
  // size is the longest side in pixels; quality is the JPEG quality in percent.
  const ack = query.get("ack");
  if (ack !== null && ack !== "1" && ack !== "0") throw new BridgeError(400, "ack must be 1 or 0.");
  return { udid: udid.toUpperCase(), fps: int("fps", 24, 1, 30), size: int("size", 1280, 240, 1600), quality: int("quality", 60, 30, 90), ack: ack === "1" };
}

/** Splits the helper's stdout into frames: a 4-byte big-endian length, then
 * that many bytes. Pipes deliver arbitrary chunks, so a frame may span many. */
export class FrameReader {
  private buffered: Buffer[] = [];
  private bytes = 0;
  push(chunk: Buffer): Buffer[] {
    this.buffered.push(chunk); this.bytes += chunk.length;
    const frames: Buffer[] = [];
    while (this.bytes >= 4) {
      const head = this.buffered[0].length >= 4 ? this.buffered[0] : Buffer.concat(this.buffered);
      const length = head.readUInt32BE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) throw new Error(`frame of ${length} bytes`);
      if (this.bytes < 4 + length) break;
      const all = this.buffered.length === 1 ? this.buffered[0] : Buffer.concat(this.buffered);
      frames.push(all.subarray(4, 4 + length));
      const rest = all.subarray(4 + length);
      this.buffered = rest.length ? [rest] : []; this.bytes = rest.length;
    }
    return frames;
  }
}

/** Sends the newest frame only. At most `window` frames are in flight (until
 * written, or until acknowledged when `acked`); frames that arrive meanwhile
 * replace the one waiting, so a slow link sees fewer frames, never older
 * ones. A byte budget, refilled continuously with one second of burst, bounds
 * the bitrate the same way. */
export class LatestFrame {
  private waiting?: Buffer;
  private inFlight = 0;
  private tokens: number;
  private refilled: number;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  sent = 0;
  dropped = 0;
  constructor(private send: (frame: Buffer, done: (error?: Error) => void) => void,
    private options: { bytesPerSecond?: number; window?: number; acked?: boolean } = {}, private now: () => number = Date.now) {
    this.tokens = this.bytesPerSecond; this.refilled = now();
  }
  offer(frame: Buffer): void {
    if (this.closed) return;
    if (this.waiting) this.dropped++;
    this.waiting = frame;
    this.pump();
  }
  /** The phone has a frame; an acknowledgement it owes nothing for is ignored. */
  ack(): void {
    if (!this.options.acked || this.inFlight === 0) return;
    this.inFlight--; this.pump();
  }
  close(): void { this.closed = true; this.waiting = undefined; clearTimeout(this.timer); }
  private get bytesPerSecond(): number { return this.options.bytesPerSecond ?? STREAM_BYTES_PER_SECOND; }
  private pump(): void {
    if (this.closed || this.inFlight >= (this.options.window ?? 1) || !this.waiting || this.timer) return;
    const now = this.now();
    this.tokens = Math.min(this.bytesPerSecond, this.tokens + (now - this.refilled) * this.bytesPerSecond / 1000);
    this.refilled = now;
    if (this.tokens < 0) {
      // Over budget: the frame waits (and may be replaced) until it refills.
      this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, Math.ceil(-this.tokens * 1000 / this.bytesPerSecond));
      return;
    }
    const frame = this.waiting;
    this.waiting = undefined; this.inFlight++; this.tokens -= frame.length;
    this.send(frame, error => {
      if (error) { this.close(); return; }
      this.sent++;
      if (this.options.acked) return;
      this.inFlight--; this.pump();
    });
  }
}

/** The phone's socket, or a test double. */
export interface StreamClient {
  readonly readyState: number;
  send(data: string | Buffer, options: { binary: boolean }, done?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  once(event: "close" | "error", listener: () => void): unknown;
  on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): unknown;
}

/** The capture process, or a test double. */
export interface CaptureProcess {
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export interface StreamDeps {
  booted: () => Promise<Json[]>;
  helper: () => Promise<string>;
  spawn: (binary: string, args: string[]) => CaptureProcess;
  platform: () => NodeJS.Platform;
  bytesPerSecond?: number;
}

const defaultDeps: StreamDeps = {
  booted: bootedSimulators,
  helper: () => verifiedHelper("simcast"),
  spawn: (binary, args) => spawnChild(binary, args, { stdio: ["ignore", "pipe", "pipe"] }),
  platform: () => process.platform,
};

let active = 0;
/** Streams running now, for tests and health. */
export function activeSimulatorStreams(): number { return active; }

/** WebSocket close reasons are at most 123 bytes. */
function reason(text: string): string { return Buffer.from(text).subarray(0, 120).toString("utf8").replace(/�+$/, ""); }

export async function streamSimulator(client: StreamClient, query: URLSearchParams, deps: StreamDeps = defaultDeps): Promise<void> {
  let options: StreamOptions;
  try { options = streamOptions(query); } catch (error) { client.close(1008, reason((error as Error).message)); return; }
  if (deps.platform() !== "darwin") { client.close(1008, "Simulators run on macOS only."); return; }
  if (active >= MAX_STREAMS) { client.close(1013, "Too many simulator streams; try again."); return; }
  // The slot is held until the work it pays for is over: discovery and the
  // build still running after the socket closed, and a helper that takes up
  // to 2 s to exit. Releasing it on close would let connect-close cycles pile
  // up simctl and helper processes past MAX_STREAMS.
  active++;
  let released = false;
  const release = () => { if (!released) { released = true; active--; } };
  let ended = false, child: CaptureProcess | undefined, killer: ReturnType<typeof setTimeout> | undefined;
  const latest = new LatestFrame((frame, done) => {
    if (client.readyState !== OPEN) { done(new Error("closed")); return; }
    client.send(frame, { binary: true }, done);
  }, { bytesPerSecond: deps.bytesPerSecond, window: options.ack ? ACK_WINDOW : 1, acked: options.ack });
  client.on("message", (data, isBinary) => {
    if (isBinary || data.length > 64) return;
    try { if ((JSON.parse(data.toString("utf8")) as { type?: unknown }).type === "ack") latest.ack(); } catch { /* not ours */ }
  });
  const end = (code?: number, why?: string) => {
    if (ended) return;
    ended = true; latest.close();
    if (child) {
      const running = child;
      running.kill("SIGTERM");
      // A helper stuck in CoreSimulator still goes.
      killer = setTimeout(() => running.kill("SIGKILL"), 2_000); killer.unref?.();
      running.once("exit", () => clearTimeout(killer));
    }
    if (code !== undefined && client.readyState === OPEN) client.close(code, reason(why ?? "Simulator stream ended."));
  };
  client.once("close", () => end());
  client.once("error", () => end());
  try {
    if (!(await deps.booted()).some(device => device.udid === options.udid)) { end(1008, "That simulator is not booted."); return; }
    // A socket that closed during discovery doesn't go on to build the helper.
    if (ended || client.readyState !== OPEN) { end(); return; }
    const binary = await deps.helper();
    if (ended || client.readyState !== OPEN) { end(); return; }
    child = deps.spawn(binary, [options.udid, String(options.fps), String(options.size), (options.quality / 100).toFixed(2)]);
    child.once("exit", release); child.once("error", release);
  } catch (error) {
    end(1011, error instanceof BridgeError ? error.message : "Couldn't start the simulator stream.");
    return;
  } finally { if (!child) release(); }
  const reader = new FrameReader();
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-400); });
  child.stdout?.on("data", (chunk: Buffer) => {
    if (ended) return;
    let frames: Buffer[];
    try { frames = reader.push(chunk); } catch { end(1011, "The simulator stream sent a broken frame."); return; }
    for (const frame of frames) latest.offer(frame);
  });
  child.once("error", () => end(1011, "Couldn't start the simulator stream."));
  child.once("exit", () => {
    const last = stderr.trim().split("\n").at(-1);
    end(1011, last ? `Simulator stream ended: ${last}` : "Simulator stream ended.");
  });
  client.send(JSON.stringify({ type: "start", format: "jpeg", fps: options.fps, size: options.size, quality: options.quality, ack: options.ack }), { binary: false });
}

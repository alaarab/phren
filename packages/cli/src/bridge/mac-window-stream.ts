import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { FrameReader } from "./frame-reader.js";
import { beginMacWindowStream, logMacWindowStreamRefusal, type MacWindowStreamEnd, type MacWindowStreamLease } from "./mac-window-lease-stub.js";
import { verifiedHelper } from "./native-helpers.js";
import { BridgeError } from "./protocol.js";
import type { StreamClient } from "./simulator-stream.js";

/**
 * `WS /v1/mac/windows/stream?id=&codec=&tier=`: one Mac window, live, as
 * ScreenCaptureKit video encoded by `wincap stream`. The helper answers each
 * `PULL <tier> <reset>` with one tagged record on stdout; this side paces the
 * pulls, turns each encoded sample into one binary WS message with a contiguous
 * sequence number, and owns the one unacknowledged frame, the token bucket and
 * the close codes. The wire, tiers, deadlines and exit codes are
 * .scratch/CONTRACT-S2.md sections 1-3.
 *
 * Invariants: at most one PULL, one staged (encoded, waiting for tokens) sample
 * and one unacknowledged frame, and only one of those at a time. No PULL while
 * anything is staged or unacknowledged, and never more than once per tier frame
 * interval. A frame is only replaced by a new epoch's sync frame, never by a
 * dependent delta.
 */

export type MacWindowCodec = "h264" | "hevc";

export interface MacWindowTier { size: number; fps: number; bitsPerSecond: number }
/** Longest side in pixels, capture fps and encoder/wire target. */
export const MAC_WINDOW_TIERS: readonly MacWindowTier[] = [
  { size: 320, fps: 5, bitsPerSecond: 96_000 },
  { size: 480, fps: 8, bitsPerSecond: 160_000 },
  { size: 640, fps: 10, bitsPerSecond: 240_000 },
  { size: 960, fps: 12, bitsPerSecond: 384_000 },
];
export const MAC_WINDOW_MAX_TIER = MAC_WINDOW_TIERS.length - 1;
/** One Hook carries one live window at a time. */
export const MAX_MAC_WINDOW_STREAMS = 1;

/** One binary WS message: the 24-byte header, parameter sets and the access unit. */
export const MAX_MESSAGE_BYTES = 24_576;
/** One helper stdout record: its tag byte plus at most one wire message. */
export const MAX_RECORD_BYTES = MAX_MESSAGE_BYTES + 1;
export const HEADER_BYTES = 24;
/** Client controls are text and this short. */
export const MAX_CONTROL_BYTES = 256;

/** Video bursts may use the whole bucket, then refill at the tier's bytes/s. */
export const BUCKET_CAPACITY_BYTES = 24_576;
/** No tier may refill faster than this, which bounds 3 s of video to 168576 B. */
export const BUCKET_CEILING_BYTES_PER_SECOND = 48_000;

export const FIRST_SEND_DEADLINE_MS = 12_000;
export const PULL_DEADLINE_MS = 5_000;
export const ACK_DEADLINE_MS = 4_000;
export const STOP_GRACE_MS = 250;
export const SIGKILL_AFTER_MS = 2_000;

const OPEN = 1;

export interface MacWindowStreamOptions { id: number; codec: MacWindowCodec; tier: number }

const STREAM_FIELDS = new Set(["id", "codec", "tier"]);

/** The stream query, validated before owner state or the helper is touched. */
export function streamQuery(query: URLSearchParams): MacWindowStreamOptions {
  for (const field of query.keys()) {
    if (!STREAM_FIELDS.has(field)) throw new BridgeError(400, "Unknown mac window stream option.");
  }
  for (const field of STREAM_FIELDS) {
    if (query.getAll(field).length > 1) throw new BridgeError(400, `Duplicate ${field}.`);
  }
  const rawId = query.get("id");
  if (rawId === null || !/^[1-9]\d{0,9}$/.test(rawId) || Number(rawId) > 4_294_967_295) {
    throw new BridgeError(400, "id must be a window id from 1 to 4294967295.");
  }
  const rawCodec = query.get("codec");
  if (rawCodec !== null && rawCodec !== "h264" && rawCodec !== "hevc") throw new BridgeError(400, "codec must be h264 or hevc.");
  const rawTier = query.get("tier");
  if (rawTier !== null && !/^[0-3]$/.test(rawTier)) throw new BridgeError(400, "tier must be 0 to 3.");
  return { id: Number(rawId), codec: rawCodec ?? "h264", tier: rawTier === null ? 1 : Number(rawTier) };
}

/** The helper and the clock, replaced in tests. */
export interface MacWindowStreamDeps {
  helper(): Promise<string>;
  spawn(binary: string, args: string[]): ChildProcess;
  /** Monotonic milliseconds. */
  now(): number;
}

const defaultDeps: MacWindowStreamDeps = {
  helper: () => verifiedHelper("wincap"),
  spawn: (binary, args) => spawnChild(binary, args, { stdio: ["pipe", "pipe", "pipe"] }),
  now: () => performance.now(),
};

/** WebSocket close reasons are at most 123 bytes. */
function reason(text: string): string { return Buffer.from(text).subarray(0, 120).toString("utf8").replace(/�+$/, ""); }

function tierRate(tier: number): number {
  return Math.min(BUCKET_CEILING_BYTES_PER_SECOND, MAC_WINDOW_TIERS[tier].bitsPerSecond / 8);
}

interface ParsedSample { sync: boolean; width: number; height: number; ptsUs: bigint; body: Buffer }

/** The wire layout of one helper tag-1 record, before the Hook assigns its seq. */
function parseSample(body: Buffer, codec: MacWindowCodec): ParsedSample {
  if (body.length < HEADER_BYTES + 4) throw new Error("short sample");
  if (body.length > MAX_MESSAGE_BYTES) throw new Error("sample over the wire cap");
  if (body.toString("latin1", 0, 4) !== "MWV1") throw new Error("bad magic");
  const flags = body[4];
  if ((flags & 0xfe) !== 0) throw new Error("unknown flags");
  const sync = (flags & 1) === 1;
  const params = body[5];
  const width = body.readUInt16BE(6), height = body.readUInt16BE(8);
  if (width < 2 || width > 960 || height < 2 || height > 960) throw new Error("bad dimensions");
  if ((width & 1) !== 0 || (height & 1) !== 0) throw new Error("odd dimensions");
  if (body.readUInt16BE(10) !== 0) throw new Error("reserved field set");
  if (body.readUInt32BE(12) !== 0) throw new Error("helper set the sequence");
  const ptsUs = body.readBigUInt64BE(16);
  if (params !== (sync ? (codec === "h264" ? 2 : 3) : 0)) throw new Error("bad parameter-set count");
  let offset = HEADER_BYTES;
  for (let i = 0; i < params; i++) {
    if (offset + 2 > body.length) throw new Error("truncated parameter set");
    const length = body.readUInt16BE(offset); offset += 2;
    if (length === 0 || offset + length > body.length) throw new Error("bad parameter set");
    offset += length;
  }
  let units = 0;
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error("truncated NAL length");
    const length = body.readUInt32BE(offset); offset += 4;
    if (length === 0 || offset + length > body.length) throw new Error("bad NAL length");
    offset += length; units += 1;
  }
  if (units === 0) throw new Error("no NAL units");
  return { sync, width, height, ptsUs, body };
}

/** Close code and reason for an admission refusal (BridgeError with a stable code). */
function admissionClose(error: unknown): { code: number; reason: string } {
  const stable = new Set(["mac-windows-owner-only", "mac-windows-disabled", "mac-windows-stopped", "mac-windows-badge",
    "mac-windows-screen-recording", "unsupported-platform", "mac-windows-permission"]);
  const details = error instanceof BridgeError ? error.details : undefined;
  const code = details && typeof details === "object" && !Array.isArray(details) && typeof details.code === "string" ? details.code : undefined;
  return code && stable.has(code) ? { code: 1008, reason: code } : { code: 1011, reason: "capture-failed" };
}

/** Exit code to close code (contract section 2's helper exits). */
function exitClose(code: number | null): { code: number; reason: string } {
  if (code === 3) return { code: 1008, reason: "mac-windows-screen-recording" };
  if (code === 5) return { code: 4404, reason: "window-gone" };
  if (code === 6) return { code: 4415, reason: "codec-unavailable" };
  return { code: 1011, reason: "capture-failed" };
}

let active = 0;
/** Streams running now, for tests and health. */
export function activeMacWindowStreams(): number { return active; }

const live = new Set<(code: number, why: string) => void>();

/** Hook shutdown: stop every live stream (1001) before the sockets are torn down. */
export function closeMacWindowStreams(): void {
  for (const shutdown of [...live]) shutdown(1001, "shutdown");
}

export async function streamMacWindow(client: StreamClient, query: URLSearchParams, owner: boolean, deps: MacWindowStreamDeps = defaultDeps): Promise<void> {
  const logRefusal = (why: string, id?: number) => { void logMacWindowStreamRefusal(why, id).catch(() => undefined); };
  const closeNow = (code: number, why: string) => {
    if (client.readyState !== OPEN) return;
    try { client.close(code, reason(why)); } catch { /* already gone */ }
  };
  // The owner gate comes first: no query parsing, no slot disclosure.
  if (!owner) { logRefusal("mac-windows-owner-only"); closeNow(1008, "mac-windows-owner-only"); return; }
  let options: MacWindowStreamOptions;
  try { options = streamQuery(query); } catch { logRefusal("bad-request"); closeNow(1008, "bad-request"); return; }
  if (active >= MAX_MAC_WINDOW_STREAMS) { logRefusal("stream-busy", options.id); closeNow(1013, "stream-busy"); return; }
  active += 1;

  let starting = true;
  let childExited = false;
  let released = false;
  const release = () => { if (!released) { released = true; active = Math.max(0, active - 1); } };
  const releaseIfDone = () => { if (!starting && (!child || childExited)) release(); };

  let ended = false;
  let child: ChildProcess | undefined;
  /** The child announced it started; an 'error' after this is not a spawn failure. */
  let childStarted = false;
  let lease: MacWindowStreamLease | undefined;
  let finishedLease = false;
  const finishLease = (outcome?: string) => {
    if (finishedLease || !lease) return;
    finishedLease = true;
    void lease.finish(outcome).catch(() => undefined);
  };

  let firstSendTimer: ReturnType<typeof setTimeout> | undefined;
  let pullTimer: ReturnType<typeof setTimeout> | undefined;
  let pullDeadline: ReturnType<typeof setTimeout> | undefined;
  let ackDeadline: ReturnType<typeof setTimeout> | undefined;
  let tokenTimer: ReturnType<typeof setTimeout> | undefined;
  let termTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const later = (ms: number, task: () => void) => {
    const timer = setTimeout(task, Math.max(0, Math.ceil(ms)));
    timer.unref?.();
    return timer;
  };
  const clear = (timer: ReturnType<typeof setTimeout> | undefined) => { if (timer) clearTimeout(timer); };

  // Frames.
  let epoch = 1;
  /** The start sent for the current epoch, or undefined before its first frame. */
  let started: { width: number; height: number } | undefined;
  /** Advance the epoch before the next frame, once, however many reasons queued. */
  let rotate = false;
  let needsSync = true;
  let lastPts: bigint | undefined;

  // Pacing.
  let tier = options.tier;
  let requestedTier = options.tier;
  let maxTier = MAC_WINDOW_MAX_TIER;
  let tokens = BUCKET_CAPACITY_BYTES;
  let rate = tierRate(tier);
  let refilledAt = deps.now();
  let staged: ParsedSample | undefined;
  let outstanding: { seq: number; tier: number; sentAt: number } | undefined;
  let lastSeq = 0;
  let pullOutstanding = false;
  let lastPullAt = -Infinity;
  let oversize = 0;
  let spawned = false;

  const reader = new FrameReader(MAX_RECORD_BYTES);

  const refill = () => {
    const now = deps.now();
    if (now > refilledAt) {
      tokens = Math.min(BUCKET_CAPACITY_BYTES, tokens + (now - refilledAt) * rate / 1000);
      refilledAt = now;
    }
  };
  /** Switch tiers: credit already earned stays, the new rate starts now. */
  const applyTier = (next: number) => {
    refill();
    tier = next;
    rate = tierRate(next);
  };

  /** Resolve the outstanding pull without producing a frame. */
  const resolvePull = () => {
    pullOutstanding = false;
    clear(pullDeadline); pullDeadline = undefined;
  };

  const sendControl = (message: Record<string, unknown>): boolean => {
    if (ended) return false;
    if (client.readyState !== OPEN) { end(); return false; }
    try { client.send(JSON.stringify(message), { binary: false }); } catch { end(1011, "capture-failed"); return false; }
    return true;
  };

  const sendFrame = (message: Buffer): boolean => {
    if (client.readyState !== OPEN) { end(); return false; }
    try {
      client.send(message, { binary: true }, error => { if (error && !ended) end(1011, "capture-failed"); });
    } catch { end(1011, "capture-failed"); return false; }
    return true;
  };

  const end = (code?: number, why?: string) => {
    if (ended) return;
    ended = true;
    for (const timer of [firstSendTimer, pullTimer, pullDeadline, ackDeadline, tokenTimer, termTimer, killTimer]) clear(timer);
    firstSendTimer = pullTimer = pullDeadline = ackDeadline = tokenTimer = termTimer = killTimer = undefined;
    staged = undefined; outstanding = undefined; pullOutstanding = false;
    live.delete(shutdown);
    if (child && !childExited) {
      const running = child;
      // STOP first; EOF is STOP too, so ending stdin also covers a wedged helper.
      try { running.stdin?.write("STOP\n"); running.stdin?.end(); } catch { /* pipe already closed */ }
      termTimer = later(STOP_GRACE_MS, () => { try { running.kill("SIGTERM"); } catch { /* gone */ } });
      killTimer = later(SIGKILL_AFTER_MS, () => { try { running.kill("SIGKILL"); } catch { /* gone */ } });
      running.once("exit", () => {
        clear(termTimer); termTimer = undefined;
        clear(killTimer); killTimer = undefined;
      });
    }
    releaseIfDone();
    finishLease(why);
    if (code !== undefined) closeNow(code, why ?? "capture-failed");
  };

  function shutdown(code: number, why: string): void { end(code, why); }
  live.add(shutdown);
  client.once("close", () => end());
  client.once("error", () => end());

  /** Rotate the epoch before the next frame; several queued reasons collapse. */
  const restartEpoch = () => {
    if (started) rotate = true;
    needsSync = true;
  };

  const tryPull = () => {
    if (ended || !spawned || pullOutstanding || staged || outstanding || pullTimer) return;
    if (requestedTier !== tier) {
      // Applied at the first pull after the outstanding sample was resolved.
      restartEpoch();
      applyTier(requestedTier);
    }
    const due = lastPullAt + 1000 / MAC_WINDOW_TIERS[tier].fps;
    const now = deps.now();
    if (now < due) {
      pullTimer = later(due - now, () => { pullTimer = undefined; tryPull(); });
      return;
    }
    if (!submit(`PULL ${tier} ${needsSync ? 1 : 0}\n`)) return;
    lastPullAt = now;
    pullOutstanding = true;
    pullDeadline = later(PULL_DEADLINE_MS, () => {
      pullDeadline = undefined;
      if (!ended && pullOutstanding) end(1011, "capture-failed");
    });
  };

  const submit = (line: string): boolean => {
    if (!child?.stdin || childExited) { end(1011, "capture-failed"); return false; }
    try { child.stdin.write(line); return true; } catch { end(1011, "capture-failed"); return false; }
  };

  /** Debit the bucket for the whole staged message, then send it. */
  const pump = () => {
    if (ended || !staged || outstanding) return;
    refill();
    if (tokens + 1e-6 < staged.body.length) {
      if (!tokenTimer) {
        tokenTimer = later((staged.body.length - tokens) * 1000 / rate, () => { tokenTimer = undefined; pump(); });
      }
      return;
    }
    clear(tokenTimer); tokenTimer = undefined;
    tokens -= staged.body.length;
    const sample = staged;
    staged = undefined;
    if (rotate) {
      epoch = epoch >= 0xffff_ffff ? 1 : epoch + 1;
      rotate = false;
      started = undefined;
    }
    // A coded size change is a new epoch's sync frame; a delta may not move it.
    if (started && (started.width !== sample.width || started.height !== sample.height)) {
      if (!sample.sync) { end(1011, "bad-helper-frame"); return; }
      epoch = epoch >= 0xffff_ffff ? 1 : epoch + 1;
      started = undefined;
      needsSync = true;
    }
    if (needsSync && !sample.sync) { end(1011, "bad-helper-frame"); return; }
    if (!started) {
      if (!sample.sync) { end(1011, "bad-helper-frame"); return; }
      if (!sendControl({ type: "start", version: 1, codec: options.codec, epoch, width: sample.width, height: sample.height, tier, maxTier })) return;
      started = { width: sample.width, height: sample.height };
    }
    const seq = lastSeq + 1;
    lastSeq = seq;
    const message = Buffer.from(sample.body);
    message.writeUInt32BE(seq, 12);
    outstanding = { seq, tier, sentAt: deps.now() };
    if (sample.sync) needsSync = false;
    oversize = 0;
    clear(firstSendTimer); firstSendTimer = undefined;
    ackDeadline = later(ACK_DEADLINE_MS, () => {
      ackDeadline = undefined;
      if (!ended && outstanding?.seq === seq) end(1013, "slow-link");
    });
    sendFrame(message);
  };

  const onSample = (body: Buffer) => {
    let sample: ParsedSample;
    try { sample = parseSample(body, options.codec); } catch { end(1011, "bad-helper-frame"); return; }
    if (lastPts !== undefined && sample.ptsUs <= lastPts) { end(1011, "bad-helper-frame"); return; }
    lastPts = sample.ptsUs;
    if (needsSync && !sample.sync) { end(1011, "bad-helper-frame"); return; }
    staged = sample;
    pump();
  };

  const onOversize = () => {
    // Only oversize responses at the floor count; any video frame resets it.
    staged = undefined;
    if (tier === 0) oversize += 1;
    maxTier = Math.max(0, Math.min(maxTier, tier - 1));
    requestedTier = Math.min(requestedTier, maxTier);
    restartEpoch();
    if (tier === 0 && oversize >= 3) { end(1013, "slow-link"); return; }
    tryPull();
  };

  const onRecord = (record: Buffer) => {
    const tag = record[0];
    if (tag !== 0 && tag !== 1 && tag !== 2) { end(1011, "bad-helper-frame"); return; }
    if (tag !== 1 && record.length !== 1) { end(1011, "bad-helper-frame"); return; }
    if (!pullOutstanding) { end(1011, "bad-helper-frame"); return; }
    resolvePull();
    if (tag === 0) { tryPull(); return; }
    if (tag === 2) { onOversize(); return; }
    onSample(record.subarray(1));
  };

  const controlSeq = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 4_294_967_295 ? value : undefined;

  /** Stale below the outstanding seq, a future seq is a protocol error. */
  const seqState = (seq: number): "stale" | "current" | "future" => {
    if (outstanding) return seq < outstanding.seq ? "stale" : seq > outstanding.seq ? "future" : "current";
    return seq <= lastSeq ? "stale" : "future";
  };

  const onAck = (seq: number) => {
    const state = seqState(seq);
    if (state === "stale") return;
    if (state === "future" || !outstanding) { end(1008, "bad-control"); return; }
    const sample = outstanding;
    outstanding = undefined;
    clear(ackDeadline); ackDeadline = undefined;
    const ackMs = Math.max(0, Math.round(deps.now() - sample.sentAt));
    if (!sendControl({ type: "stats", seq: sample.seq, ackMs, tier: sample.tier })) return;
    tryPull();
  };

  const onKeyframe = (seq: number) => {
    const state = seqState(seq);
    if (state === "stale") return;
    if (state === "future" || !outstanding) { end(1008, "bad-control"); return; }
    outstanding = undefined;
    clear(ackDeadline); ackDeadline = undefined;
    restartEpoch();
    tryPull();
  };

  const onControl = (data: Buffer, isBinary: boolean) => {
    if (ended) return;
    if (isBinary || data.length > MAX_CONTROL_BYTES) { end(1008, "bad-control"); return; }
    let parsed: unknown;
    try { parsed = JSON.parse(data.toString("utf8")); } catch { end(1008, "bad-control"); return; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { end(1008, "bad-control"); return; }
    const message = parsed as Record<string, unknown>;
    if (message.type === "ack" || message.type === "keyframe") {
      const seq = controlSeq(message.seq);
      if (seq === undefined) { end(1008, "bad-control"); return; }
      if (message.type === "ack") onAck(seq); else onKeyframe(seq);
      return;
    }
    if (message.type === "set") {
      const set = message.tier;
      if (typeof set !== "number" || !Number.isInteger(set) || set < 0 || set > MAC_WINDOW_MAX_TIER) { end(1008, "bad-control"); return; }
      requestedTier = Math.min(set, maxTier);
      tryPull();
      return;
    }
    end(1008, "bad-control");
  };
  client.on("message", onControl);

  try {
    if (ended || client.readyState !== OPEN) return;
    lease = await beginMacWindowStream(owner, options.id, (why: MacWindowStreamEnd) => end(1008, why));
    if (ended || client.readyState !== OPEN) { finishLease(); return; }
    const binary = await deps.helper();
    if (ended || client.readyState !== OPEN) return;
    const spawnedChild = deps.spawn(binary, ["stream", String(options.id), options.codec]);
    child = spawnedChild;
    spawnedChild.once("spawn", () => { childStarted = true; });
    spawnedChild.once("exit", (code: number | null) => {
      childExited = true;
      releaseIfDone();
      if (!ended) { const close = exitClose(code); end(close.code, close.reason); }
    });
    spawnedChild.once("error", () => {
      // Only a failure before 'spawn' is a failed start; a later error (a
      // refused signal, say) leaves a started child running, so its slot stays
      // taken until it actually exits.
      if (!childStarted) childExited = true;
      releaseIfDone();
      if (!ended) end(1011, "capture-failed");
    });
    // A helper that exits mid-write makes Node emit EPIPE here, asynchronously.
    spawnedChild.stdin?.on("error", () => { if (!ended) end(1011, "capture-failed"); });
    const stdout = spawnedChild.stdout;
    stdout?.on("data", (chunk: Buffer) => {
      if (ended) return;
      let records: Buffer[];
      try { records = reader.push(chunk); } catch { end(1011, "bad-helper-frame"); return; }
      for (const record of records) { if (ended) return; onRecord(record); }
    });
    stdout?.on("end", () => {
      if (ended) return;
      try { reader.finish(); } catch { end(1011, "bad-helper-frame"); }
    });
    // Bounded, never quoted: the helper's own words never reach a close reason.
    spawnedChild.stderr?.on("data", () => { /* drained */ });
    spawned = true;
    firstSendTimer = later(FIRST_SEND_DEADLINE_MS, () => {
      firstSendTimer = undefined;
      if (!ended) end(1011, "capture-failed");
    });
    tryPull();
  } catch (error) {
    if (!ended) { const close = admissionClose(error); end(close.code, close.reason); }
  } finally {
    starting = false;
    releaseIfDone();
  }
}

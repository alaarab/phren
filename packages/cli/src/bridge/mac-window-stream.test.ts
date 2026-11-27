import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FrameReader } from "./frame-reader.js";
import {
  activeMacWindowStreams, closeMacWindowStreams, type MacWindowCodec, type MacWindowStreamDeps,
  MAX_MESSAGE_BYTES, streamMacWindow, streamQuery,
} from "./mac-window-stream.js";

/** The window id and layout the tests stream. */
const ID = "9";

function framed(...payloads: Buffer[]): Buffer {
  return Buffer.concat(payloads.flatMap(payload => { const head = Buffer.alloc(4); head.writeUInt32BE(payload.length); return [head, payload]; }));
}

/** One helper stdout record: u32 length, tag, body. */
function record(tag: number, body?: Buffer): Buffer {
  return framed(Buffer.concat([Buffer.from([tag]), body ?? Buffer.alloc(0)]));
}
const idle = () => record(0);
const oversize = () => record(2);

/** One binary wire message as the helper writes it (seq zero, the Hook assigns it). */
function wire(options: { sync?: boolean; codec?: MacWindowCodec; width?: number; height?: number; pts?: bigint; seq?: number; unitBytes?: number; params?: Buffer[] } = {}): Buffer {
  const codec = options.codec ?? "h264";
  const sync = options.sync ?? false;
  const params = options.params ?? (sync
    ? codec === "h264" ? [Buffer.from([0x67, 0x42, 0x00]), Buffer.from([0x68, 0xce, 0x3c])]
      : [Buffer.from([0x40, 0x01]), Buffer.from([0x42, 0x01]), Buffer.from([0x44, 0x01])]
    : []);
  const header = Buffer.alloc(24);
  header.write("MWV1", 0, "latin1");
  header[4] = sync ? 1 : 0;
  header[5] = params.length;
  header.writeUInt16BE(options.width ?? 480, 6);
  header.writeUInt16BE(options.height ?? 300, 8);
  header.writeUInt32BE(options.seq ?? 0, 12);
  header.writeBigUInt64BE(options.pts ?? 1_000n, 16);
  const parts: Buffer[] = [header];
  for (const param of params) { const length = Buffer.alloc(2); length.writeUInt16BE(param.length); parts.push(length, param); }
  const unit = options.unitBytes === undefined ? Buffer.from([0x65, 0x88, 0x84]) : Buffer.alloc(options.unitBytes, 0x55);
  const length = Buffer.alloc(4); length.writeUInt32BE(unit.length);
  parts.push(length, unit);
  const body = Buffer.concat(parts);
  if (options.unitBytes !== undefined && body.length !== options.unitBytes + 24 + params.reduce((sum, param) => sum + 2 + param.length, 0) + 4) throw new Error("bad wire size");
  return body;
}

class FakeClient extends EventEmitter {
  readyState = 1;
  sent: (string | Buffer)[] = [];
  closed?: { code?: number; reason?: string };
  holdSends = false;
  held: ((error?: Error) => void)[] = [];
  send(data: string | Buffer, _options: { binary: boolean }, done?: (error?: Error) => void) {
    this.sent.push(data);
    if (!done) return;
    if (this.holdSends) this.held.push(done); else done();
  }
  close(code?: number, reason?: string) {
    if (this.readyState !== 1) return;
    this.readyState = 3; this.closed = { code, reason }; this.emit("close");
  }
  control(message: unknown) { this.emit("message", Buffer.from(JSON.stringify(message)), false); }
  raw(data: Buffer, isBinary: boolean) { this.emit("message", data, isBinary); }
  binary() { return this.sent.filter((data): data is Buffer => Buffer.isBuffer(data)); }
  texts() { return this.sent.filter((data): data is string => typeof data === "string").map(data => JSON.parse(data) as Record<string, unknown>); }
}

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  commands: string[] = [];
  signals: string[] = [];
  stdinEnded = false;
  /** A helper that ignores SIGTERM until SIGKILL. */
  lingers = false;
  exited = false;
  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => this.commands.push(chunk.toString("utf8")));
    this.stdin.on("end", () => { this.stdinEnded = true; });
  }
  kill(signal?: NodeJS.Signals) {
    this.signals.push(signal ?? "SIGTERM");
    if (!this.lingers || signal === "SIGKILL") setImmediate(() => this.exit(null));
    return true;
  }
  /** The child process started, as Node's `spawn` event reports. */
  spawned() { this.emit("spawn"); }
  exit(code: number | null = 0) { if (this.exited) return; this.exited = true; this.emit("exit", code, null); }
}

function harness() {
  const children: FakeChild[] = [];
  const deps: MacWindowStreamDeps = {
    helper: vi.fn(async () => "/bridge/native/wincap"),
    spawn: vi.fn((_binary: string, _args: string[]) => { const child = new FakeChild(); children.push(child); return child as unknown as ChildProcess; }),
    now: () => Date.now(),
  };
  return { deps, children };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const open: FakeClient[] = [];

async function start(query: string, deps: MacWindowStreamDeps, owner = true) {
  const client = new FakeClient(); open.push(client);
  await streamMacWindow(client, new URLSearchParams(query), owner, deps);
  await flush();
  return client;
}
const pulls = (child: FakeChild) => child.commands.filter(command => command.startsWith("PULL "));
const stamps = (client: FakeClient) => client.texts().filter(message => message.type === "stats");

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); });
afterEach(async () => {
  for (const client of open.splice(0)) client.close(1000);
  vi.advanceTimersByTime(2_500);
  await flush();
  vi.useRealTimers();
  expect(activeMacWindowStreams()).toBe(0);
});

describe("frame reader", () => {
  it("reassembles records whose prefix and body are split across chunks", () => {
    const bytes = framed(Buffer.from("one"), Buffer.from("two"));
    const reader = new FrameReader();
    const out: Buffer[] = [];
    for (let i = 0; i < bytes.length; i += 1) out.push(...reader.push(bytes.subarray(i, i + 1)));
    expect(out.map(record => record.toString())).toEqual(["one", "two"]);
    expect(() => reader.finish()).not.toThrow();
  });
  it("rejects zero-length and over-cap records, and trailing bytes at finish", () => {
    expect(() => new FrameReader().push(Buffer.alloc(4))).toThrow();
    expect(() => new FrameReader(4).push(framed(Buffer.alloc(5)))).toThrow();
    const reader = new FrameReader();
    reader.push(framed(Buffer.from("ok")).subarray(0, 5));
    expect(() => reader.finish()).toThrow();
  });
});

describe("stream query", () => {
  it("defaults codec and tier", () => {
    expect(streamQuery(new URLSearchParams(`id=${ID}`))).toEqual({ id: 9, codec: "h264", tier: 1 });
    expect(streamQuery(new URLSearchParams("id=4294967295&codec=hevc&tier=0"))).toEqual({ id: 4_294_967_295, codec: "hevc", tier: 0 });
  });
  it.each([
    "", "id=", "id=0", "id=4294967296", "id=-1", "id=1.5", "id=01", "id=1&id=2",
    "id=1&codec=vp9", "id=1&tier=4", "id=1&tier=01", "id=1&tier=-1", "id=1&fps=8", "id=1&extra=2",
  ])("refuses %j", query => expect(() => streamQuery(new URLSearchParams(query))).toThrow());
});

describe("stream admission", () => {
  it("checks the owner before parsing the query or touching anything", async () => {
    const { deps, children } = harness();
    const client = await start("not a query at all", deps, false);
    expect(client.closed).toEqual({ code: 1008, reason: "mac-windows-owner-only" });
    expect(deps.helper).not.toHaveBeenCalled();
    expect(children).toHaveLength(0);
  });
  it("refuses a bad query with bad-request before the helper", async () => {
    const { deps } = harness();
    const client = await start("id=nope", deps);
    expect(client.closed).toEqual({ code: 1008, reason: "bad-request" });
    expect(deps.helper).not.toHaveBeenCalled();
  });
  it("keeps the owner refusal ahead of the busy slot", async () => {
    const { deps } = harness();
    let release!: (value: string) => void;
    deps.helper = () => new Promise<string>(resolve => { release = resolve; });
    const first = new FakeClient(); open.push(first);
    const running = streamMacWindow(first, new URLSearchParams(`id=${ID}`), true, deps);
    await flush();
    expect(activeMacWindowStreams()).toBe(1);
    const refused = await start(`id=10`, deps, false);
    expect(refused.closed).toEqual({ code: 1008, reason: "mac-windows-owner-only" });
    const busy = await start("id=10", deps);
    expect(busy.closed).toEqual({ code: 1013, reason: "stream-busy" });
    release("/bridge/native/wincap");
    await running;
  });
  it("spawns wincap stream with argv, three pipes and the validated id and codec", async () => {
    const { deps } = harness();
    await start(`id=${ID}&codec=hevc&tier=2`, deps);
    expect(deps.spawn).toHaveBeenCalledWith("/bridge/native/wincap", ["stream", ID, "hevc"]);
  });
  it("holds the one slot through helper startup and releases it after it settles", async () => {
    const { deps } = harness();
    let release!: (value: string) => void;
    deps.helper = () => new Promise<string>(resolve => { release = resolve; });
    const client = new FakeClient(); open.push(client);
    const running = streamMacWindow(client, new URLSearchParams(`id=${ID}`), true, deps);
    await flush();
    expect(activeMacWindowStreams()).toBe(1);
    client.close(1000);
    await flush();
    // The socket is gone but startup has not settled, so the slot stays taken.
    expect(activeMacWindowStreams()).toBe(1);
    const busy = await start("id=10", deps);
    expect(busy.closed).toEqual({ code: 1013, reason: "stream-busy" });
    release("/bridge/native/wincap");
    await running;
    expect(deps.spawn).not.toHaveBeenCalled();
    expect(activeMacWindowStreams()).toBe(0);
  });
  it("reports a helper that cannot be built and a spawn that fails", async () => {
    const built = harness();
    const failed = await start(`id=${ID}`, { ...built.deps, helper: async () => { throw new Error("swiftc"); } });
    expect(failed.closed).toEqual({ code: 1011, reason: "capture-failed" });
    expect(activeMacWindowStreams()).toBe(0);
    const spawn = harness();
    const thrown = await start(`id=${ID}`, { ...spawn.deps, spawn: () => { throw new Error("no helper"); } });
    expect(thrown.closed).toEqual({ code: 1011, reason: "capture-failed" });
    expect(activeMacWindowStreams()).toBe(0);
  });
});

describe("child lifecycle", () => {
  it("closes capture-failed on a stdin pipe error instead of crashing, and stays closed", async () => {
    const { deps, children } = harness();
    const client = await start(`id=${ID}`, deps);
    children[0].stdin.emit("error", new Error("EPIPE"));
    await flush();
    expect(client.closed).toEqual({ code: 1011, reason: "capture-failed" });
    // The teardown's own STOP write may hit the same closed pipe; it must not throw.
    expect(() => children[0].stdin.emit("error", new Error("EPIPE"))).not.toThrow();
  });
  it("releases the slot at once when the spawn itself fails", async () => {
    const { deps, children } = harness();
    const client = await start(`id=${ID}`, deps);
    children[0].emit("error", new Error("ENOENT"));
    await flush();
    expect(client.closed).toEqual({ code: 1011, reason: "capture-failed" });
    expect(activeMacWindowStreams()).toBe(0);
  });
  it("keeps the slot after a post-spawn error until the started child actually exits", async () => {
    const { deps, children } = harness();
    const client = await start(`id=${ID}`, deps);
    const child = children[0];
    child.spawned();
    child.emit("error", new Error("kill failed"));
    await flush();
    expect(client.closed).toEqual({ code: 1011, reason: "capture-failed" });
    // The child may still be alive: the next connection is refused, not admitted.
    expect(activeMacWindowStreams()).toBe(1);
    const busy = await start("id=10", deps);
    expect(busy.closed).toEqual({ code: 1013, reason: "stream-busy" });
    child.exit(0);
    await flush();
    expect(activeMacWindowStreams()).toBe(0);
  });
});

describe("pull pacing", () => {
  it("issues the first pull immediately with reset, then at most one per tier interval", async () => {
    const { deps, children } = harness();
    await start(`id=${ID}`, deps);
    const child = children[0];
    expect(pulls(child)).toEqual(["PULL 1 1\n"]);
    child.stdout.write(idle());
    await flush();
    expect(pulls(child)).toHaveLength(1);
    vi.advanceTimersByTime(124);
    expect(pulls(child)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(pulls(child)).toHaveLength(2);
    expect(pulls(child)[1]).toBe("PULL 1 1\n");
  });
  it("closes capture-failed when a pull is not answered within 5 s", async () => {
    const { deps } = harness();
    const client = await start(`id=${ID}`, deps);
    vi.advanceTimersByTime(5_000);
    expect(client.closed).toEqual({ code: 1011, reason: "capture-failed" });
  });
  it("closes capture-failed when 12 s pass without a first send even while idling", async () => {
    const { deps, children } = harness();
    const client = await start(`id=${ID}`, deps);
    const child = children[0];
    for (let tick = 1; tick <= 2; tick += 1) {
      vi.advanceTimersByTime(4_000);
      child.stdout.write(idle());
      await flush();
      expect(client.closed).toBeUndefined();
    }
    vi.advanceTimersByTime(4_000);
    expect(client.closed).toEqual({ code: 1011, reason: "capture-failed" });
  });
});

describe("frames", () => {
  it("sends the start, then the sync frame with the Hook's seq as one binary message", async () => {
    const { deps, children } = harness();
    const client = await start(`id=${ID}`, deps);
    children[0].stdout.write(record(1, wire({ sync: true, width: 480, height: 300, pts: 1_000n })));
    await flush();
    expect(client.texts()[0]).toEqual({ type: "start", version: 1, codec: "h264", epoch: 1, width: 480, height: 300, tier: 1, maxTier: 3 });
    const [frame] = client.binary();
    expect(frame.subarray(0, 4).toString("latin1")).toBe("MWV1");
    expect(frame[4] & 1).toBe(1);
    expect(frame.readUInt16BE(6)).toBe(480);
    expect(frame.readUInt32BE(12)).toBe(1);
    expect(frame.readBigUInt64BE(16)).toBe(1_000n);
    expect(client.binary()).toHaveLength(1);
  });
  it("reassembles a record split across chunks and keeps the seq contiguous", async () => {
    const { deps, children } = harness();
    const client = await start(`id=${ID}`, deps);
    const child = children[0];
    const bytes = record(1, wire({ sync: true, pts: 1_000n }));
    for (let i = 0; i < bytes.length; i += 1) child.stdout.write(bytes.subarray(i, i + 1));
    await flush();
    expect(client.binary()).toHaveLength(1);
    client.control({ type: "ack", seq: 1 });
    vi.advanceTimersByTime(125);
    child.stdout.write(record(1, wire({ pts: 2_000n })));
    await flush();
    expect(client.binary().map(frame => frame.readUInt32BE(12))).toEqual([1, 2]);
  });
  it("rejects a broken header, a helper seq and a bad parameter-set count", async () => {
    for (const body of [
      Buffer.alloc(28),
      wire({ sync: true, seq: 7 }),
      wire({ sync: true, codec: "hevc", params: [Buffer.from([1])] }),
      wire({ sync: true, width: 481 }),
    ]) {
      const { deps, children } = harness();
      const client = await start(`id=${ID}`, deps);
      children[0].stdout.write(record(1, body));
      await flush();
      expect(client.closed).toEqual({ code: 1011, reason: "bad-helper-frame" });
      vi.advanceTimersByTime(250);
      await flush();
      expect(activeMacWindowStreams()).toBe(0);
    }
  });
  it("rejects a second record that arrived in the same chunk before the next pull", async () => {
    const { deps, children } = harness();
    const client = await start(`id=${ID}`, deps);
    const child = children[0];
    vi.advanceTimersByTime(125);
    child.stdout.write(Buffer.concat([idle(), idle()]));
    await flush();
    expect(client.closed).toEqual({ code: 1011, reason: "bad-helper-frame" });
    expect(pulls(child)).toHaveLength(1);
  });
  it("rejects a partial next prefix that arrived before the next pull", async () => {
    const { deps, children } = harness();
    const client = await start(`id=${ID}`, deps);
    const child = children[0];
    vi.advanceTimersByTime(125);
    child.stdout.write(Buffer.concat([idle(), Buffer.from([0, 0, 0])]));
    await flush();
    expect(client.closed).toEqual({ code: 1011, reason: "bad-helper-frame" });
    expect(pulls(child)).toHaveLength(1);
  });
  it("rejects helper bytes while a staged sample holds the pull slot", async () => {
    const { deps, children } = harness();
    const client = await start(`id=${ID}&tier=3`, deps);
    const child = children[0];
    child.stdout.write(record(1, wire({ sync: true, unitBytes: MAX_MESSAGE_BYTES - 24 - 10 - 4, pts: 1_000n })));
    await flush();
    client.control({ type: "ack", seq: 1 });
    vi.advanceTimersByTime(84);
    child.stdout.write(record(1, wire({ unitBytes: 20_000, pts: 2_000n })));
    await flush();
    expect(pulls(child)).toHaveLength(2);
    child.stdout.write(idle());
    await flush();
    expect(client.closed).toEqual({ code: 1011, reason: "bad-helper-frame" });
  });
  it("treats stdout ending mid-record as bad-helper-frame", async () => {
    const { deps, children } = harness();
    const client = await start(`id=${ID}`, deps);
    const bytes = record(1, wire({ sync: true }));
    children[0].stdout.write(bytes.subarray(0, 5));
    await flush();
    children[0].stdout.end();
    await flush();
    expect(client.closed).toEqual({ code: 1011, reason: "bad-helper-frame" });
  });
  it("accepts a sync frame with new coded dimensions as a new epoch", async () => {
    const { deps, children } = harness();
    const client = await start(`id=${ID}`, deps);
    const child = children[0];
    child.stdout.write(record(1, wire({ sync: true, width: 480, height: 300, pts: 1_000n })));
    await flush();
    client.control({ type: "ack", seq: 1 });
    vi.advanceTimersByTime(125);
    child.stdout.write(record(1, wire({ sync: true, width: 320, height: 200, pts: 2_000n })));
    await flush();
    expect(client.texts().at(-1)).toMatchObject({ type: "start", epoch: 2, width: 320, height: 200 });
    expect(client.binary().at(-1)!.readUInt32BE(12)).toBe(2);
  });
});

describe("acknowledgements and stats", () => {
  it("answers an ACK with stats before anything else and rounds the ack time", async () => {
    const { deps, children } = harness();
    const client = await start(`id=${ID}&tier=2`, deps);
    children[0].stdout.write(record(1, wire({ sync: true, width: 640, height: 400, pts: 1_000n })));
    await flush();
    vi.advanceTimersByTime(130);
    client.control({ type: "ack", seq: 1 });
    expect(stamps(client)).toEqual([{ type: "stats", seq: 1, ackMs: 130, tier: 2 }]);
    expect(client.sent[2]).toBe(JSON.stringify({ type: "stats", seq: 1, ackMs: 130, tier: 2 }));
    expect(client.closed).toBeUndefined();
  });
  it("ignores stale and duplicate ACKs, and closes a future seq with 1008", async () => {
    const { deps, children } = harness();
    const client = await start(`id=${ID}`, deps);
    const child = children[0];
    child.stdout.write(record(1, wire({ sync: true, pts: 1_000n })));
    await flush();
    client.control({ type: "ack", seq: 1 });
    client.control({ type: "ack", seq: 1 });
    expect(stamps(client)).toHaveLength(1);
    vi.advanceTimersByTime(125);
    child.stdout.write(record(1, wire({ pts: 2_000n })));
    await flush();
    // Stale while another seq is outstanding: ignored, not closed.
    client.control({ type: "ack", seq: 1 });
    expect(client.closed).toBeUndefined();
    expect(stamps(client)).toHaveLength(1);
    client.control({ type: "ack", seq: 3 });
    expect(client.closed).toEqual({ code: 1008, reason: "bad-control" });
  });
  it("closes slow-link when an ACK does not arrive within 4 s, with one send and no extra pull", async () => {
    const { deps, children } = harness();
    const client = await start(`id=${ID}`, deps);
    children[0].stdout.write(record(1, wire({ sync: true, pts: 1_000n })));
    await flush();
    vi.advanceTimersByTime(3_000);
    expect(client.binary()).toHaveLength(1);
    expect(pulls(children[0])).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(client.closed).toEqual({ code: 1013, reason: "slow-link" });
  });
  it.each([
    ["binary", (client: FakeClient) => client.raw(Buffer.from("{}"), true)],
    ["a long text control", (client: FakeClient) => client.raw(Buffer.alloc(257, 0x20), false)],
    ["bad JSON", (client: FakeClient) => client.raw(Buffer.from("{"), false)],
    ["an unknown type", (client: FakeClient) => client.control({ type: "subscribe" })],
    ["an ack without a seq", (client: FakeClient) => client.control({ type: "ack" })],
    ["a zero seq", (client: FakeClient) => client.control({ type: "ack", seq: 0 })],
    ["a fractional seq", (client: FakeClient) => client.control({ type: "keyframe", seq: 1.5 })],
    ["a tier above 3", (client: FakeClient) => client.control({ type: "set", tier: 4 })],
    ["a missing tier", (client: FakeClient) => client.control({ type: "set" })],
  ])("closes bad-control on %s", async (_name, send) => {
    const { deps } = harness();
    const client = await start(`id=${ID}`, deps);
    send(client);
    expect(client.closed).toEqual({ code: 1008, reason: "bad-control" });
  });
});

describe("tier changes and recovery", () => {
  it("applies a set at the next pull, starts a new epoch and changes the pull rate", async () => {
    const { deps, children } = harness();
    const client = await start(`id=${ID}&tier=2`, deps);
    const child = children[0];
    child.stdout.write(record(1, wire({ sync: true, width: 640, height: 400, pts: 1_000n })));
    await flush();
    client.control({ type: "ack", seq: 1 });
    client.control({ type: "set", tier: 0 });
    // The pending tier-2 interval is replaced by tier 0's 200 ms at the next pull.
    vi.advanceTimersByTime(199);
    expect(pulls(child)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(pulls(child)).toEqual(["PULL 2 1\n", "PULL 0 1\n"]);
    child.stdout.write(record(1, wire({ sync: true, width: 320, height: 200, pts: 2_000n })));
    await flush();
    expect(client.texts().at(-1)).toEqual({ type: "start", version: 1, codec: "h264", epoch: 2, width: 320, height: 200, tier: 0, maxTier: 3 });
    expect(client.binary().at(-1)!.readUInt32BE(12)).toBe(2);
  });
  it("lowers maxTier on an oversize sample and restarts sync at the clamped tier", async () => {
    const { deps, children } = harness();
    const client = await start(`id=${ID}&tier=2`, deps);
    const child = children[0];
    child.stdout.write(record(1, wire({ sync: true, width: 640, height: 400, pts: 1_000n })));
    await flush();
    client.control({ type: "ack", seq: 1 });
    vi.advanceTimersByTime(100);
    expect(pulls(child).at(-1)).toBe("PULL 2 0\n");
    child.stdout.write(oversize());
    vi.advanceTimersByTime(125);
    expect(pulls(child).at(-1)).toBe("PULL 1 1\n");
    child.stdout.write(record(1, wire({ sync: true, width: 480, height: 300, pts: 2_000n })));
    await flush();
    expect(client.texts().at(-1)).toEqual({ type: "start", version: 1, codec: "h264", epoch: 2, width: 480, height: 300, tier: 1, maxTier: 1 });
    expect(client.binary().at(-1)!.readUInt32BE(12)).toBe(2);
  });
  it("closes slow-link after three oversize responses at tier 0", async () => {
    const { deps, children } = harness();
    const client = await start(`id=${ID}&tier=0`, deps);
    const child = children[0];
    child.stdout.write(record(1, wire({ sync: true, width: 320, height: 200, pts: 1_000n })));
    await flush();
    client.control({ type: "ack", seq: 1 });
    for (let count = 1; count <= 3; count += 1) {
      vi.advanceTimersByTime(200);
      expect(pulls(child).at(-1)).toBe(`PULL 0 ${count === 1 ? 0 : 1}\n`);
      child.stdout.write(oversize());
      await flush();
    }
    expect(client.closed).toEqual({ code: 1013, reason: "slow-link" });
  });
  it("retires an unacked sample on a keyframe request and rejects a dependent delta", async () => {
    const { deps, children } = harness();
    const client = await start(`id=${ID}`, deps);
    const child = children[0];
    child.stdout.write(record(1, wire({ sync: true, pts: 1_000n })));
    await flush();
    client.control({ type: "keyframe", seq: 1 });
    expect(client.closed).toBeUndefined();
    vi.advanceTimersByTime(125);
    expect(pulls(child).at(-1)).toBe("PULL 1 1\n");
    child.stdout.write(record(1, wire({ pts: 2_000n })));
    await flush();
    expect(client.closed).toEqual({ code: 1011, reason: "bad-helper-frame" });
  });
  it("ignores a keyframe for a retired seq", async () => {
    const { deps, children } = harness();
    const client = await start(`id=${ID}`, deps);
    const child = children[0];
    child.stdout.write(record(1, wire({ sync: true, pts: 1_000n })));
    await flush();
    client.control({ type: "ack", seq: 1 });
    client.control({ type: "keyframe", seq: 1 });
    expect(client.closed).toBeUndefined();
    expect(stamps(client)).toHaveLength(1);
  });
});

describe("token bucket", () => {
  it("sends a whole 24576-byte message from the initial balance", async () => {
    const { deps, children } = harness();
    const client = await start(`id=${ID}&tier=3`, deps);
    // 24-byte header + 10 bytes of parameter sets + 4-byte NAL length fill the cap.
    const body = wire({ sync: true, unitBytes: MAX_MESSAGE_BYTES - 24 - 10 - 4, pts: 1_000n });
    expect(body).toHaveLength(MAX_MESSAGE_BYTES);
    children[0].stdout.write(record(1, body));
    await flush();
    expect(client.binary()).toHaveLength(1);
    expect(client.binary()[0]).toHaveLength(MAX_MESSAGE_BYTES);
  });
  it("stages an over-budget sample, issues no pull meanwhile and sends only once it can be debited", async () => {
    const { deps, children } = harness();
    const client = await start(`id=${ID}&tier=3`, deps);
    const child = children[0];
    child.stdout.write(record(1, wire({ sync: true, unitBytes: MAX_MESSAGE_BYTES - 24 - 10 - 4, pts: 1_000n })));
    await flush();
    client.control({ type: "ack", seq: 1 });
    vi.advanceTimersByTime(84);
    expect(pulls(child)).toHaveLength(2);
    child.stdout.write(record(1, wire({ unitBytes: 20_000, pts: 2_000n })));
    await flush();
    expect(client.binary()).toHaveLength(1);
    expect(pulls(child)).toHaveLength(2);
    // 4032 bytes refilled in 84 ms; at 48000 B/s the rest needs ~333 ms.
    vi.advanceTimersByTime(300);
    expect(client.binary()).toHaveLength(1);
    expect(pulls(child)).toHaveLength(2);
    vi.advanceTimersByTime(50);
    expect(client.binary().map(frame => frame.length)).toEqual([MAX_MESSAGE_BYTES, 24 + 4 + 20_000]);
    expect(pulls(child)).toHaveLength(2);
  });
  it("holds a single unacknowledged frame under a long RTT and never overruns the byte cap", async () => {
    const { deps, children } = harness();
    const client = await start(`id=${ID}&tier=3`, deps);
    const child = children[0];
    child.stdout.write(record(1, wire({ sync: true, unitBytes: MAX_MESSAGE_BYTES - 24 - 10 - 4, pts: 1_000n })));
    await flush();
    vi.advanceTimersByTime(3_000);
    expect(client.binary()).toHaveLength(1);
    expect(pulls(child)).toHaveLength(1);
    const sentBytes = client.binary().reduce((sum, frame) => sum + frame.length, 0);
    expect(sentBytes).toBeLessThanOrEqual(MAX_MESSAGE_BYTES + 48_000 * 3);
  });
});

describe("teardown", () => {
  it("ends stdin with STOP, then SIGTERM at 250 ms and SIGKILL at 2 s", async () => {
    const { deps, children } = harness();
    const client = await start(`id=${ID}`, deps);
    const child = children[0];
    child.lingers = true;
    client.close(1000);
    expect(child.commands.at(-1)).toBe("STOP\n");
    await flush();
    expect(child.stdinEnded).toBe(true);
    expect(child.signals).toEqual([]);
    vi.advanceTimersByTime(249);
    expect(child.signals).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(child.signals).toEqual(["SIGTERM"]);
    vi.advanceTimersByTime(1_750);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    await flush();
    expect(activeMacWindowStreams()).toBe(0);
  });
  it("closes every live stream with 1001 shutdown when the Hook stops", async () => {
    const { deps, children } = harness();
    const client = await start(`id=${ID}`, deps);
    closeMacWindowStreams();
    expect(client.closed).toEqual({ code: 1001, reason: "shutdown" });
    expect(children[0].commands.at(-1)).toBe("STOP\n");
    vi.advanceTimersByTime(250);
    await flush();
    expect(activeMacWindowStreams()).toBe(0);
  });
  it.each([
    [3, 1008, "mac-windows-screen-recording"],
    [5, 4404, "window-gone"],
    [6, 4415, "codec-unavailable"],
    [0, 1011, "capture-failed"],
    [4, 1011, "capture-failed"],
  ])("maps helper exit %i to %i %s", async (exit, code, why) => {
    const { deps, children } = harness();
    const client = await start(`id=${ID}`, deps);
    children[0].exit(exit);
    await flush();
    expect(client.closed).toEqual({ code, reason: why });
    expect(activeMacWindowStreams()).toBe(0);
  });
});

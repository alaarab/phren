import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activeSimulatorStreams, FrameReader, LatestFrame, MAX_FRAME_BYTES, MAX_STREAMS, type StreamDeps, streamOptions, streamSimulator } from "./simulator-stream.js";

const udid = "AAAAAAAA-1111-4111-8111-111111111111";
const framed = (...frames: Buffer[]) => Buffer.concat(frames.flatMap(frame => { const head = Buffer.alloc(4); head.writeUInt32BE(frame.length); return [head, frame]; }));
const jpeg = (n: number, length = 8) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(length - 2, n)]);

class FakeClient extends EventEmitter {
  readyState = 1;
  sent: (string | Buffer)[] = [];
  closed?: { code?: number; reason?: string };
  /** Send callbacks held back, as a slow link would. */
  held: ((error?: Error) => void)[] = [];
  holdSends = false;
  send(data: string | Buffer, _options: { binary: boolean }, done?: (error?: Error) => void) {
    this.sent.push(data);
    if (!done) return;
    if (this.holdSends) this.held.push(done); else done();
  }
  close(code?: number, reason?: string) { if (this.readyState !== 1) return; this.readyState = 3; this.closed = { code, reason }; this.emit("close"); }
  frames() { return this.sent.filter((data): data is Buffer => Buffer.isBuffer(data)); }
}
class FakeChild extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough();
  signals: string[] = [];
  kill(signal?: NodeJS.Signals) { this.signals.push(signal ?? "SIGTERM"); return true; }
  exit(code = 0) { this.emit("exit", code, null); }
}
function harness(booted = [udid]) {
  const children: { binary: string; args: string[]; child: FakeChild }[] = [];
  const deps: StreamDeps = {
    booted: vi.fn(async () => booted.map(id => ({ udid: id, name: "iPhone", runtime: "iOS 27.0" }))),
    helper: vi.fn(async () => "/bridge/native/simcast"),
    spawn: vi.fn((binary: string, args: string[]) => { const child = new FakeChild(); children.push({ binary, args, child }); return child; }),
    platform: () => "darwin",
  };
  return { deps, children };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const open: FakeClient[] = [];
async function start(query: string, deps: StreamDeps) {
  const client = new FakeClient(); open.push(client);
  await streamSimulator(client, new URLSearchParams(query), deps);
  return client;
}
afterEach(() => { for (const client of open.splice(0)) client.close(); vi.useRealTimers(); });

describe("simulator stream request", () => {
  it.each([
    "", "udid=nope", `udid=${udid}x`, "udid=--help", `udid=${udid}&fps=0`, `udid=${udid}&fps=31`, `udid=${udid}&fps=2.5`,
    `udid=${udid}&size=100`, `udid=${udid}&size=1e3`, `udid=${udid}&quality=95`, `udid=${udid}&fps=-1`, `udid=${udid}&ack=yes`,
  ])("refuses %j with 1008 before looking anything up", async query => {
    const { deps } = harness();
    const client = await start(query, deps);
    expect(client.closed?.code).toBe(1008);
    expect(deps.booted).not.toHaveBeenCalled(); expect(deps.spawn).not.toHaveBeenCalled();
  });
  it("defaults to 24 fps at 1280 px and normalizes the identifier", () => {
    expect(streamOptions(new URLSearchParams(`udid=${udid.toLowerCase()}`))).toEqual({ udid, fps: 24, size: 1280, quality: 60, ack: false });
    expect(streamOptions(new URLSearchParams(`udid=${udid}&fps=12&size=720&quality=45&ack=1`))).toEqual({ udid, fps: 12, size: 720, quality: 45, ack: true });
  });
  it("refuses a simulator that is not booted without starting the helper", async () => {
    const { deps } = harness([]);
    const client = await start(`udid=${udid}`, deps);
    expect(client.closed).toEqual({ code: 1008, reason: "That simulator is not booted." });
    expect(deps.helper).not.toHaveBeenCalled(); expect(activeSimulatorStreams()).toBe(0);
  });
  it("refuses off macOS", async () => {
    const { deps } = harness();
    const client = await start(`udid=${udid}`, { ...deps, platform: () => "linux" });
    expect(client.closed?.code).toBe(1008); expect(deps.booted).not.toHaveBeenCalled();
  });
});

describe("helper frame framing", () => {
  it("reassembles frames split across chunks and several in one chunk", () => {
    const reader = new FrameReader(), bytes = framed(jpeg(1, 10), jpeg(2, 3), jpeg(3, 7));
    const out: Buffer[] = [];
    // One byte at a time splits the length prefix itself.
    for (let i = 0; i < 9; i++) out.push(...reader.push(bytes.subarray(i, i + 1)));
    out.push(...reader.push(bytes.subarray(9)));
    expect(out).toEqual([jpeg(1, 10), jpeg(2, 3), jpeg(3, 7)]);
  });
  it.each([0, MAX_FRAME_BYTES + 1])("rejects a %i-byte frame", length => {
    const head = Buffer.alloc(4); head.writeUInt32BE(length);
    expect(() => new FrameReader().push(head)).toThrow();
  });
});

describe("latest-frame sending", () => {
  it("keeps one frame in flight and replaces the waiting one, never queueing", () => {
    const done: (() => void)[] = [], sent: number[] = [];
    const latest = new LatestFrame((frame, callback) => { sent.push(frame[2]); done.push(callback); });
    for (let n = 1; n <= 5; n++) latest.offer(jpeg(n));
    expect(sent).toEqual([1]);
    done.shift()!();
    expect(sent).toEqual([1, 5]); expect(latest.dropped).toBe(3);
    done.shift()!();
    expect(sent).toEqual([1, 5]); expect(latest.sent).toBe(2);
  });
  it("holds frames over the byte budget until it refills, still sending the newest", () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const latest = new LatestFrame((frame, callback) => { sent.push(frame[2]); callback(); }, { bytesPerSecond: 1000 });
    latest.offer(jpeg(1, 1500));
    latest.offer(jpeg(2, 100)); latest.offer(jpeg(3, 100));
    expect(sent).toEqual([1]);
    vi.advanceTimersByTime(499);
    expect(sent).toEqual([1]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([1, 3]); expect(latest.dropped).toBe(1);
  });
  it("with acknowledgements, keeps two frames unacknowledged and sends the newest when one is acked", () => {
    const sent: number[] = [];
    const latest = new LatestFrame((frame, callback) => { sent.push(frame[2]); callback(); }, { window: 2, acked: true });
    for (let n = 1; n <= 5; n++) latest.offer(jpeg(n));
    expect(sent).toEqual([1, 2]);
    latest.ack();
    expect(sent).toEqual([1, 2, 5]); expect(latest.dropped).toBe(2);
    latest.ack(); latest.ack(); latest.ack();
    latest.offer(jpeg(6)); latest.offer(jpeg(7));
    // Surplus acknowledgements don't widen the window.
    expect(sent).toEqual([1, 2, 5, 6, 7]);
    latest.offer(jpeg(8));
    expect(sent).toEqual([1, 2, 5, 6, 7]);
  });
  it("stops after a failed send or close", () => {
    const sent: number[] = [];
    const latest = new LatestFrame((frame, callback) => { sent.push(frame[2]); callback(new Error("gone")); });
    latest.offer(jpeg(1)); latest.offer(jpeg(2));
    expect(sent).toEqual([1]);
  });
});

describe("simulator stream lifecycle", () => {
  it("starts the helper with validated arguments, announces the stream and forwards frames as binary", async () => {
    const { deps, children } = harness();
    const client = await start(`udid=${udid}&fps=20&size=960&quality=50`, deps);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ binary: "/bridge/native/simcast", args: [udid, "20", "960", "0.50"] });
    expect(JSON.parse(String(client.sent[0]))).toEqual({ type: "start", format: "jpeg", fps: 20, size: 960, quality: 50, ack: false });
    children[0].child.stdout.write(framed(jpeg(1), jpeg(2)));
    await flush();
    expect(client.frames()).toEqual([jpeg(1), jpeg(2)]);
  });
  it("drops older frames while the phone is still taking one", async () => {
    const { deps, children } = harness();
    const client = await start(`udid=${udid}`, deps);
    client.holdSends = true;
    const { stdout } = children[0].child;
    for (let n = 1; n <= 4; n++) stdout.write(framed(jpeg(n)));
    await flush();
    expect(client.frames()).toEqual([jpeg(1)]);
    client.held.shift()!();
    expect(client.frames()).toEqual([jpeg(1), jpeg(4)]);
  });
  it("paces frames by the phone's acknowledgements when it asks for them", async () => {
    const { deps, children } = harness();
    const client = await start(`udid=${udid}&ack=1`, deps);
    const { stdout } = children[0].child;
    for (let n = 1; n <= 5; n++) stdout.write(framed(jpeg(n)));
    await flush();
    expect(client.frames()).toEqual([jpeg(1), jpeg(2)]);
    client.emit("message", Buffer.from("not json"), false);
    client.emit("message", Buffer.from(JSON.stringify({ type: "ack" })), true);
    expect(client.frames()).toHaveLength(2);
    client.emit("message", Buffer.from(JSON.stringify({ type: "ack" })), false);
    expect(client.frames()).toEqual([jpeg(1), jpeg(2), jpeg(5)]);
  });
  it("stops the helper when the socket closes, and kills it if it lingers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { deps, children } = harness();
    const client = await start(`udid=${udid}`, deps);
    expect(activeSimulatorStreams()).toBe(1);
    client.close(1000);
    const { child } = children[0];
    expect(child.signals).toEqual(["SIGTERM"]); expect(activeSimulatorStreams()).toBe(0);
    vi.advanceTimersByTime(2_000);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    child.stdout.write(framed(jpeg(9)));
    await Promise.resolve();
    expect(client.frames()).toEqual([]);
  });
  it("closes the socket with the helper's reason when capture ends", async () => {
    const { deps, children } = harness();
    const client = await start(`udid=${udid}`, deps);
    children[0].child.stderr.write("the simulator's screen went away\n");
    await flush();
    children[0].child.exit(5);
    expect(client.closed).toEqual({ code: 1011, reason: "Simulator stream ended: the simulator's screen went away" });
    expect(activeSimulatorStreams()).toBe(0);
  });
  it("ends on a broken frame", async () => {
    const { deps, children } = harness();
    const client = await start(`udid=${udid}`, deps);
    children[0].child.stdout.write(Buffer.from([0, 0, 0, 0]));
    await flush();
    expect(client.closed?.code).toBe(1011); expect(children[0].child.signals).toEqual(["SIGTERM"]);
  });
  it("does not start the helper for a socket that closed while it was being built", async () => {
    const { deps } = harness();
    const client = new FakeClient();
    deps.helper = vi.fn(async () => { client.close(1000); return "/bridge/native/simcast"; });
    await streamSimulator(client, new URLSearchParams(`udid=${udid}`), deps);
    expect(deps.spawn).not.toHaveBeenCalled(); expect(activeSimulatorStreams()).toBe(0);
  });
  it("reports a helper that can't be built and caps concurrent streams", async () => {
    const { deps } = harness();
    const failing = await start(`udid=${udid}`, { ...deps, helper: async () => { throw new Error("swiftc"); } });
    expect(failing.closed).toEqual({ code: 1011, reason: "Couldn't start the simulator stream." });
    for (let i = 0; i < MAX_STREAMS; i++) await start(`udid=${udid}`, deps);
    const extra = await start(`udid=${udid}`, deps);
    expect(extra.closed?.code).toBe(1013); expect(deps.spawn).toHaveBeenCalledTimes(MAX_STREAMS);
  });
});

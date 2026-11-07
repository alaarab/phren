import * as fs from "node:fs";
import path from "node:path";
import { EventEmitter, once } from "node:events";
import { connect } from "node:net";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserMessageReader, MAX_BROWSER_MESSAGE, type Hello, type BrowserMessage } from "./browser-protocol.js";
import { browserSocketPath } from "./browser-socket.js";
import { runBrowser } from "./browser-env.js";
import { BrowserRegistry } from "./browser-registry.js";
import { BrowserRecordings } from "./browser-recordings.js";
import { streamBrowser } from "./browser-stream.js";
import { BUILTIN_MODULES } from "../modules/registry.js";
import { createRouteHandler } from "./server-routes.js";

const hello: Hello = { v: 1, browserId: "browser_123", pid: 123, session: "pane1", cwd: "/project", engine: "chromium", headless: true, playwright: "fake" };
const page = { browserId: hello.browserId, pageId: "page_1234", url: "https://example.test", title: "Example", width: 800, height: 600 };
const jpeg = Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9]);
function wire(type: number, data: unknown, bytes?: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(data));
  const payload = bytes ? Buffer.concat([Buffer.alloc(4), json, bytes]) : json;
  if (bytes) payload.writeUInt32BE(json.length);
  const head = Buffer.alloc(5); head.writeUInt32BE(payload.length + 1); head[4] = type;
  return Buffer.concat([head, payload]);
}
const roots: string[] = [];
const registries: BrowserRegistry[] = [];
function root(): string { const scratch = path.join(process.cwd(), ".scratch"); fs.mkdirSync(scratch, { recursive: true }); const dir = fs.mkdtempSync(path.join(scratch, "browser-test-")); roots.push(dir); return dir; }
function registry(): BrowserRegistry { const value = new BrowserRegistry(root()); registries.push(value); return value; }
afterEach(() => { for (const r of registries.splice(0)) r.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("browser socket protocol", () => {
  it("parses coalesced and byte-fragmented messages including binary JPEGs", () => {
    const reader = new BrowserMessageReader(), messages: BrowserMessage[] = [];
    const bytes = Buffer.concat([wire(1, hello), wire(2, page), wire(3, { browserId: hello.browserId, pageId: page.pageId, t: 1000, width: 800, height: 600 }, jpeg), wire(4, { browserId: hello.browserId })]);
    for (const byte of bytes) messages.push(...reader.push(Buffer.from([byte])));
    expect(messages.map(m => m.type)).toEqual([1, 2, 3, 4]);
    expect(messages[2]).toMatchObject({ jpeg, data: { t: 1000 } });
    expect(new BrowserMessageReader().push(bytes)).toEqual(messages);
  });
  it("rejects oversized headers, unknown types, invalid JSON/schema and truncated frame headers", () => {
    const oversized = Buffer.alloc(4); oversized.writeUInt32BE(MAX_BROWSER_MESSAGE + 1);
    for (const bytes of [oversized, wire(99, {}), wire(1, { ...hello, browserId: "../escape" }), Buffer.from([0, 0, 0, 2, 1, 123]), wire(3, {})]) {
      expect(() => new BrowserMessageReader().push(bytes)).toThrow();
    }
  });
});

it("owns browsers per connection, retains ended rows for an hour, and clears page frames on close", () => {
  const r = registry(), owner = {};
  r.accept(owner, { type: 1, data: hello }); r.accept(owner, { type: 2, data: page });
  expect(() => r.accept({}, { type: 4, data: { browserId: hello.browserId } })).toThrow();
  r.accept(owner, { type: 3, data: { browserId: hello.browserId, pageId: page.pageId, t: 1000, width: 800, height: 600 }, jpeg });
  expect(r.last(hello.browserId, page.pageId)).toEqual(jpeg);
  r.accept(owner, { type: 4, data: { browserId: hello.browserId, pageId: page.pageId } });
  expect(r.last(hello.browserId, page.pageId)).toBeUndefined();
  r.disconnect(owner);
  const ended = r.list()[0]; expect(ended).toMatchObject({ live: false, pages: [{ live: false }] });
  expect(r.recordings.list()[0].endedAt).not.toBeNull();
  expect(r.list(ended.endedAt! + 3_600_001)).toEqual([]);
});

it("records at most four changed frames per second with seekable offsets and a navigation timeline", () => {
  const recordings = new BrowserRecordings(root()); recordings.start(hello, 0); recordings.page(page, 0);
  const info = { browserId: hello.browserId, pageId: page.pageId, t: 1000, width: 800, height: 600 };
  recordings.frame(info, jpeg); recordings.frame({ ...info, t: 1100 }, Buffer.from("dropped"));
  recordings.frame({ ...info, t: 1300 }, jpeg);
  const second = Buffer.from([0xff, 0xd8, 2, 3, 0xff, 0xd9]); recordings.frame({ ...info, t: 1400 }, second);
  recordings.page({ ...page, url: "https://example.test/next" }, 1500); recordings.end(hello.browserId, 2000);
  const { meta, frames } = recordings.index(hello.browserId);
  expect(meta).toMatchObject({ frames: 2, bytes: 11, endedAt: 2000, navigations: [{ t: 0 }, { t: 1500 }] });
  expect(frames.map(f => [f.offset, f.length])).toEqual([[0, 5], [5, 6]]);
  expect(recordings.frameAt(hello.browserId, 1)).toEqual(second);
  const reopened = new BrowserRecordings(recordings.root); expect(reopened.frameAt(hello.browserId, 0)).toEqual(jpeg);
});

it("keeps each navigation as it was and completes an entry when its title arrives", () => {
  const recordings = new BrowserRecordings(root()); recordings.start(hello, 0);
  recordings.page({ ...page, url: "https://a.test/", title: "" }, 1);
  recordings.page({ ...page, url: "https://a.test/", title: "A" }, 2);
  recordings.page({ ...page, url: "https://b.test/", title: "" }, 3);
  recordings.page({ ...page, url: "https://b.test/", title: "B" }, 4);
  const meta = JSON.parse(fs.readFileSync(path.join(recordings.root, hello.browserId, "meta.json"), "utf8"));
  expect(meta.navigations.map((n: { url: string; title: string }) => [n.url, n.title])).toEqual([["https://a.test/", "A"], ["https://b.test/", "B"]]);
  expect(meta.pages).toHaveLength(1); expect(meta.pages[0]).toMatchObject({ url: "https://b.test/", title: "B" });
});

it("retains newest recordings within the byte budget and removes recordings after 24 hours", () => {
  const recordings = new BrowserRecordings(root());
  for (const [id, t] of [["browser_old", 0], ["browser_new", 1000]] as const) {
    recordings.start({ ...hello, browserId: id }, t);
    recordings.frame({ browserId: id, pageId: page.pageId, t, width: 1, height: 1 }, jpeg); recordings.end(id, t + 1);
  }
  const newDir = path.join(recordings.root, "browser_new");
  const budget = fs.readdirSync(newDir).reduce((n, file) => n + fs.statSync(path.join(newDir, file)).size, 0);
  recordings.retain(2000, budget);
  expect(recordings.list().map(m => m.id)).toEqual(["browser_new"]);
  recordings.retain(86_401_000); expect(recordings.list()).toEqual([]);
});

async function request(r: BrowserRegistry, method: string, url: string): Promise<{ status: number; body: Buffer; headers: Record<string, string> }> {
  const handler = createRouteHandler({ browsers: r, modules: { has: () => true, modules: BUILTIN_MODULES }, info: {}, streams: {} } as never);
  const req = Readable.from([]) as IncomingMessage; req.method = method; req.url = url; req.headers = {};
  let payload = Buffer.alloc(0); const headers: Record<string, string> = {};
  const response = { statusCode: 200, setHeader(k: string, v: string) { headers[k] = v; }, end(value?: string | Buffer) { payload = Buffer.from(value ?? ""); } };
  await handler(req, response as unknown as ServerResponse);
  return { status: response.statusCode, body: payload, headers };
}
it("validates replay ids and frame numbers through authenticated Hook routing, returns exact JPEGs and deletes", async () => {
  const r = registry(), owner = {};
  r.accept(owner, { type: 1, data: hello }); r.accept(owner, { type: 2, data: page });
  r.accept(owner, { type: 3, data: { browserId: hello.browserId, pageId: page.pageId, t: 1000, width: 800, height: 600 }, jpeg });
  for (const url of ["/v1/browsers/recordings/index?id=..", "/v1/browsers/recordings/frame?id=browser_123&n=-1", "/v1/browsers/recordings/frame?id=browser_123&n=1.5", "/v1/browsers/recordings/frame?id=browser_123"]) expect((await request(r, "GET", url)).status).toBe(400);
  expect((await request(r, "DELETE", "/v1/browsers/recordings?id=browser_123")).status).toBe(409);
  expect(JSON.parse((await request(r, "GET", "/v1/browsers")).body.toString())).toMatchObject({ browsers: [{ id: hello.browserId, live: true }] });
  const index = JSON.parse((await request(r, "GET", "/v1/browsers/recordings/index?id=browser_123")).body.toString());
  expect(index.frames).toEqual([{ n: 0, t: 1000, pageId: page.pageId, width: 800, height: 600 }]);
  const frame = await request(r, "GET", "/v1/browsers/recordings/frame?id=browser_123&n=0"); expect(frame.body).toEqual(jpeg); expect(frame.headers["Content-Type"]).toBe("image/jpeg");
  r.disconnect(owner); expect((await request(r, "DELETE", "/v1/browsers/recordings?id=browser_123")).status).toBe(204);
  expect((await request(r, "GET", "/v1/browsers/recordings/index?id=browser_123")).status).toBe(404);
});

class Phone extends EventEmitter {
  readyState = 1; sent: (string | Buffer)[] = []; code?: number;
  send(value: string | Buffer, _options: unknown, done?: (error?: Error) => void): void { this.sent.push(value); done?.(); }
  close(code?: number): void { this.code = code; this.readyState = 3; this.emit("close"); }
}
it("streams the latest page with a two-frame ack window and closes when its browser ends", () => {
  const r = registry(), owner = {}, phone = new Phone();
  r.accept(owner, { type: 1, data: hello }); r.accept(owner, { type: 2, data: page });
  streamBrowser(phone, new URLSearchParams("browser=browser_123&ack=1"), r);
  for (let n = 0; n < 4; n++) r.accept(owner, { type: 3, data: { browserId: hello.browserId, pageId: page.pageId, t: n * 300, width: 800, height: 600 }, jpeg: Buffer.from([n]) });
  expect(phone.sent.filter(Buffer.isBuffer)).toEqual([Buffer.from([0]), Buffer.from([1])]);
  phone.emit("message", Buffer.from('{"type":"ack"}'), false);
  expect(phone.sent.filter(Buffer.isBuffer).at(-1)).toEqual(Buffer.from([3]));
  r.accept(owner, { type: 2, data: { ...page, pageId: "page_next", url: "about:blank" } });
  expect(JSON.parse(phone.sent.filter(v => typeof v === "string").at(-1) as string)).toMatchObject({ type: "page", page: "page_next" });
  r.disconnect(owner); expect(phone.code).toBe(1000); expect(r.listenerCount("frame")).toBe(0);
  const invalid = new Phone(); streamBrowser(invalid, new URLSearchParams("browser=../bad"), r); expect(invalid.code).toBe(1008);
});

it("listens on a private socket and ends a producer on malformed input or disconnect", async () => {
  const r = registry(); await r.start();
  const socketPath = browserSocketPath(r.root);
  if (process.platform !== "win32") expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
  const socket = connect(socketPath); await once(socket, "connect");
  const registered = once(r, "change"); socket.write(wire(1, hello)); await registered;
  expect(r.list()[0].live).toBe(true);
  const ended = once(r, "change"), closed = once(socket, "close");
  socket.write(wire(99, {})); await closed; await ended;
  expect(r.list()[0].live).toBe(false);
  expect(r.recordings.list()[0].endedAt).not.toBeNull();
});

function sendPhone(phone: Phone, message: object): void { phone.emit("message", Buffer.from(JSON.stringify(message)), false); }
function controlMessages(phone: Phone): unknown[] { return phone.sent.filter((v): v is string => typeof v === "string").map(v => JSON.parse(v)).filter(v => v.type === "control"); }
function livePhones(r: BrowserRegistry): { owner: object; a: Phone; b: Phone } {
  const owner = {}, a = new Phone(), b = new Phone();
  r.accept(owner, { type: 1, data: hello }); r.accept(owner, { type: 2, data: page });
  for (const phone of [a, b]) streamBrowser(phone, new URLSearchParams(`browser=${hello.browserId}`), r);
  return { owner, a, b };
}
it("announces control, takes, steals, ignores a non-holder release, and releases on close and idle", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const r = registry(), { a, b } = livePhones(r);
  expect(controlMessages(a).at(-1)).toEqual({ type: "control", holder: null, help: null });
  sendPhone(a, { type: "control", action: "take" });
  expect(controlMessages(a).at(-1)).toMatchObject({ holder: "you" });
  expect(controlMessages(b).at(-1)).toMatchObject({ holder: "other" });
  const held = JSON.parse((await request(r, "GET", "/v1/browsers")).body.toString()).browsers[0];
  expect(held).toMatchObject({ control: { held: true, since: 1000 }, help: null });
  sendPhone(b, { type: "control", action: "take" });
  expect(controlMessages(a).at(-1)).toMatchObject({ holder: "other" });
  sendPhone(a, { type: "control", action: "release" });
  expect(controlMessages(b).at(-1)).toMatchObject({ holder: "you" });
  sendPhone(b, { type: "control", action: "release" });
  expect(controlMessages(b).at(-1)).toMatchObject({ holder: null });
  sendPhone(a, { type: "control", action: "take" }); a.close();
  expect(controlMessages(b).at(-1)).toMatchObject({ holder: null });
  sendPhone(b, { type: "control", action: "take" });
  await vi.advanceTimersByTimeAsync(119_000);
  sendPhone(b, { type: "input", event: "text", text: "keep alive" });
  await vi.advanceTimersByTimeAsync(119_999);
  expect(controlMessages(b).at(-1)).toMatchObject({ holder: "you" });
  await vi.advanceTimersByTimeAsync(1);
  expect(controlMessages(b).at(-1)).toMatchObject({ holder: null });
  expect(r.recordings.index(hello.browserId).meta.handoffs).toMatchObject([
    { kind: "take", t: 1000 }, { kind: "release", reason: "stolen" }, { kind: "take" }, { kind: "release" },
    { kind: "take" }, { kind: "release", reason: "disconnected" }, { kind: "take" }, { kind: "release", reason: "idle" },
  ]);
});

async function peer(r: BrowserRegistry) {
  const socket = connect(browserSocketPath(r.root)), reader = new BrowserMessageReader();
  const messages: BrowserMessage[] = [], arrival = new EventEmitter();
  socket.on("data", chunk => { messages.push(...reader.push(chunk)); arrival.emit("message"); });
  socket.on("error", () => {});
  await once(socket, "connect");
  return { socket, messages, async next(): Promise<BrowserMessage> { while (!messages.length) await once(arrival, "message"); return messages.shift()!; } };
}
it("drops input without control and forwards only bounded valid input as 0x10 to the streamed page", async () => {
  const r = registry(); await r.start(); const producer = await peer(r);
  let changed = once(r, "change"); producer.socket.write(wire(1, hello)); await changed;
  changed = once(r, "change"); producer.socket.write(wire(2, page)); await changed;
  const phone = new Phone(); streamBrowser(phone, new URLSearchParams(`browser=${hello.browserId}`), r);
  sendPhone(phone, { type: "input", event: "click", x: 0.5, y: 0.5 });
  expect(JSON.parse(phone.sent.at(-1) as string)).toEqual({ type: "error", message: "Take control first" });
  sendPhone(phone, { type: "control", action: "take" });
  sendPhone(phone, { type: "input", event: "text", text: "x".repeat(1001) });
  sendPhone(phone, { type: "input", event: "key", key: "Delete" });
  sendPhone(phone, { type: "input", event: "click", x: -2, y: 3 });
  expect(await producer.next()).toEqual({ type: 16, data: { browserId: hello.browserId, pageId: page.pageId, event: "click", x: 0, y: 1 } });
  // A later page announcement changes both the streamed frame and the input destination.
  changed = once(r, "change"); producer.socket.write(wire(2, { ...page, pageId: "page_next" })); await changed;
  sendPhone(phone, { type: "input", event: "wheel", x: 0.5, y: 0.25, dx: -0.1, dy: 0.5 });
  expect(await producer.next()).toMatchObject({ type: 16, data: { pageId: "page_next", event: "wheel", dx: -0.1, dy: 0.5 } });
  // A fresh second isolates the rate limit from the invalid messages above.
  const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 1000);
  for (let n = 0; n < 65; n++) sendPhone(phone, { type: "input", event: "text", text: String(n) });
  sendPhone(phone, { type: "control", action: "release" });
  // Closing the producer flushes its input stream, making the negative count assertion deterministic.
  producer.socket.end(); await once(producer.socket, "close");
  expect(producer.messages).toHaveLength(60);
  expect(producer.messages.at(-1)).toMatchObject({ data: { text: "59" } });
});

it.each(["done", "timeout", "ended", "cancelled"] as const)("settles an ask connection on %s and persists help handoffs", async outcome => {
  const r = registry(), { owner, a } = livePhones(r); await r.start();
  const cli = await peer(r);
  if (outcome === "timeout") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  cli.socket.write(wire(5, { session: hello.session, reason: "Log in", timeout: outcome === "timeout" ? 1 : 900 }));
  expect(await cli.next()).toEqual({ type: 18, data: { browserId: hello.browserId } });
  const listed = JSON.parse((await request(r, "GET", "/v1/browsers")).body.toString()).browsers[0];
  expect(listed).toMatchObject({ control: { held: false, since: null }, help: { reason: "Log in", t: expect.any(Number) } });
  expect(controlMessages(a).at(-1)).toMatchObject({ help: { reason: "Log in" } });
  if (outcome === "done") {
    sendPhone(a, { type: "control", action: "release" });
    expect(r.get(hello.browserId)?.help).not.toBeNull();
    sendPhone(a, { type: "control", action: "take" });
    expect(r.get(hello.browserId)?.help).not.toBeNull();
    sendPhone(a, { type: "control", action: "release" });
  } else if (outcome === "timeout") await vi.advanceTimersByTimeAsync(1000);
  else if (outcome === "ended") { sendPhone(a, { type: "control", action: "take" }); r.disconnect(owner); }
  else if (outcome === "cancelled") {
    const cleared = once(r, "control"); cli.socket.destroy(); await cleared;
  }
  if (outcome !== "cancelled") expect(await cli.next()).toEqual({ type: 19, data: { outcome } });
  expect(r.get(hello.browserId)?.help).toBeNull();
  expect(r.recordings.index(hello.browserId).meta.handoffs[0]).toMatchObject({ kind: "help", reason: "Log in", t: expect.any(Number) });
  expect(r.get(hello.browserId)?.live).toBe(outcome !== "ended");
});
it("returns no-browser without registering an ask as a producer", async () => {
  const r = registry(); await r.start(); const cli = await peer(r);
  cli.socket.write(wire(5, { reason: "Captcha" }));
  expect(await cli.next()).toEqual({ type: 19, data: { outcome: "no-browser" } });
  expect(r.list()).toEqual([]); expect(r.recordings.list()).toEqual([]);
});
it("selects an explicit browser, otherwise newest in session, otherwise newest live browser", async () => {
  const r = registry(), owner = {}; vi.spyOn(Date, "now").mockReturnValue(1000);
  r.accept(owner, { type: 1, data: hello });
  vi.mocked(Date.now).mockReturnValue(2000);
  r.accept(owner, { type: 1, data: { ...hello, browserId: "browser_session" } });
  r.accept(owner, { type: 1, data: { ...hello, browserId: "browser_other", session: "other" } });
  await r.start();
  for (const [selection, id] of [[{ browserId: hello.browserId, session: "other" }, hello.browserId], [{ session: hello.session }, "browser_session"], [{ session: "missing" }, "browser_other"], [{}, "browser_other"]] as const) {
    const cli = await peer(r); cli.socket.write(wire(5, { reason: "Help", ...selection }));
    expect(await cli.next()).toEqual({ type: 18, data: { browserId: id } });
    const cleared = once(r, "control"); cli.socket.destroy(); await cleared;
  }
  const cli = await peer(r); cli.socket.write(wire(5, { reason: "Help", browserId: "browser_missing" }));
  expect(await cli.next()).toEqual({ type: 19, data: { outcome: "no-browser" } });
});

it.each(["done", "no-browser", "timeout", "cancelled"] as const)("browser ask CLI prints one %s outcome, returns its exit code, and clears help", async outcome => {
  const r = registry();
  const phones = outcome === "no-browser" ? undefined : livePhones(r);
  await r.start();
  vi.stubEnv("PHREN_BROWSER_SOCKET", browserSocketPath(r.root)); vi.stubEnv("PHREN_BROWSER_SESSION", hello.session);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  if (outcome === "timeout") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const asked = outcome === "no-browser" ? undefined : once(r, "control");
  const result = runBrowser(["ask", "Log in", "--timeout", "1"]);
  if (asked) await asked;
  if (outcome === "done") {
    sendPhone(phones!.a, { type: "control", action: "take" });
    sendPhone(phones!.a, { type: "control", action: "release" });
  } else if (outcome === "timeout") await vi.advanceTimersByTimeAsync(1000);
  else if (outcome === "cancelled") {
    // Invoke the CLI signal handler without signalling Vitest's own SIGINT listeners.
    const cleared = once(r, "control"); process.rawListeners("SIGINT").at(-1)!.call(process); await cleared;
  }
  expect(await result).toBe(outcome === "done" ? 0 : 1);
  expect(log.mock.calls).toEqual([[`Browser help: ${outcome}`]]);
  if (phones) expect(r.get(hello.browserId)?.help).toBeNull();
});

import * as fs from "node:fs";
import path from "node:path";
import { EventEmitter, once } from "node:events";
import { connect } from "node:net";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserMessageReader, MAX_BROWSER_MESSAGE, type Hello, type BrowserMessage } from "./browser-protocol.js";
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
afterEach(() => { for (const r of registries.splice(0)) r.close(); for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

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
  const socketPath = path.join(r.root, "browser.sock");
  expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
  const socket = connect(socketPath); await once(socket, "connect");
  const registered = once(r, "change"); socket.write(wire(1, hello)); await registered;
  expect(r.list()[0].live).toBe(true);
  const ended = once(r, "change"), closed = once(socket, "close");
  socket.write(wire(99, {})); await closed; await ended;
  expect(r.list()[0].live).toBe(false);
  expect(r.recordings.list()[0].endedAt).not.toBeNull();
});

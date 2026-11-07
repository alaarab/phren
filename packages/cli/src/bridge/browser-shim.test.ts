import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserMessageReader, browserWire, type BrowserMessage } from "./browser-protocol.js";

const source = readFileSync(new URL("./browser-shim/phren-playwright.cjs", import.meta.url), "utf8");
afterEach(() => vi.useRealTimers());
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
async function shimFixture(socketPath = "/fake/browser.sock", exists = true) {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const messages: BrowserMessage[] = [], reader = new BrowserMessageReader();
  class Socket extends EventEmitter {
    destroyed = false; writableLength = 0;
    unref(): void {} destroy(): void { this.destroyed = true; }
    write(bytes: Buffer): void { messages.push(...reader.push(bytes)); }
  }
  const socket = new Socket(), cdp = new EventEmitter() as EventEmitter & { send: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn> };
  cdp.send = vi.fn(async () => ({})); cdp.detach = vi.fn(async () => {});
  const context = Object.assign(new EventEmitter(), { pages: (): EventEmitter[] => [page], newCDPSession: vi.fn(async () => cdp), browser: (): EventEmitter => browser });
  let url = "https://example.test/"; const main = {};
  const page = Object.assign(new EventEmitter(), { context: () => context, url: () => url, title: async () => "Example", viewportSize: () => ({ width: 800, height: 600 }), mainFrame: () => main });
  const browser = Object.assign(new EventEmitter(), { contexts: () => [context], newContext: async () => context });
  const originalLaunch = vi.fn(async () => browser);
  const playwright = { chromium: { launch: originalLaunch, launchPersistentContext: async () => context, connectOverCDP: async () => browser } };
  const loader = { _load: (_name: string) => playwright };
  let nextId = 0; const exported = { exports: {} as { initPage: (options: { page: unknown }) => Promise<void> } };
  runInNewContext(source, { module: exported, Buffer, Date, setTimeout, clearTimeout, process: { env: { PHREN_BROWSER_SOCKET: socketPath, PHREN_BROWSER_SESSION: "pane1" }, pid: 42, cwd: () => "/project" }, require: (name: string) => {
    if (name === "node:fs") return { existsSync: () => exists };
    if (name === "node:module") return loader;
    if (name === "node:net") return { createConnection: () => socket };
    if (name === "node:crypto") return { randomUUID: () => `identity_${++nextId}` };
    throw new Error(`Unexpected dependency ${name}`);
  } });
  const loaded = loader._load("playwright-core"); expect(await loaded.chromium.launch()).toBe(browser);
  socket.emit("connect"); await settle();
  return { socket, cdp, messages, page, browser, exported, context, main, navigate: (value: string) => { url = value; } };
}
it.each([
  { socketPath: "/fake/browser.sock", exists: true },
  { socketPath: String.raw`\\.\pipe\phren-browser-test`, exists: false },
])("preloads playwright-core, acks CDP, throttles frames, and observes lifecycle over $socketPath", async ({ socketPath, exists }) => {
  const { socket, cdp, messages, page, browser, exported, context, main, navigate } = await shimFixture(socketPath, exists);
  expect(messages[0]).toMatchObject({ type: 1, data: { session: "pane1", engine: "chromium", pid: 42 } });
  expect(cdp.send).toHaveBeenCalledWith("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 1280 });
  for (let n = 0; n < 3; n++) cdp.emit("Page.screencastFrame", { sessionId: n, data: Buffer.from([255, 216, n, 255, 217]).toString("base64"), metadata: { deviceWidth: 800, deviceHeight: 600 } });
  expect(cdp.send.mock.calls.filter(call => call[0] === "Page.screencastFrameAck").map(call => call[1])).toEqual([{ sessionId: 0 }, { sessionId: 1 }, { sessionId: 2 }]);
  expect(messages.filter(m => m.type === 3)).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(100);
  const frames = messages.filter(m => m.type === 3); expect(frames).toHaveLength(2);
  expect(frames[1]).toMatchObject({ jpeg: Buffer.from([255, 216, 2, 255, 217]) });
  const url = "https://example.test/next"; navigate(url); page.emit("framenavigated", main); await settle();
  expect(messages.filter(m => m.type === 2).at(-1)).toMatchObject({ data: { url, title: "Example" } });
  await exported.exports.initPage({ page }); expect(context.newCDPSession).toHaveBeenCalledTimes(1);
  page.emit("close"); await settle(); expect(messages.at(-1)).toMatchObject({ type: 4, data: { pageId: "identity_2" } });
  browser.emit("disconnected"); await settle(); expect(socket.destroyed).toBe(true); expect(cdp.detach).toHaveBeenCalledTimes(1);
});
it.each([{ exists: false, watch: undefined }, { exists: true, watch: "0" }])("leaves module loading untouched when watching is disabled or the socket is absent: %j", async ({ exists, watch }) => {
  const load = vi.fn(), loader = { _load: load }, exported = { exports: {} as { initPage: () => Promise<void> } };
  runInNewContext(source, { module: exported, process: { env: { PHREN_BROWSER_SOCKET: "/absent", PHREN_BROWSER_WATCH: watch } }, require: (name: string) => { if (name === "node:fs") return { existsSync: () => exists }; throw new Error("Must not load networking or patch Module"); } });
  expect(loader._load).toBe(load); await expect(exported.exports.initPage()).resolves.toBeUndefined();
});

it("maps framed phone input onto the page CDP session and survives malformed input and CDP failures", async () => {
  const { socket, cdp, messages, page } = await shimFixture();
  const browserId = messages.find(m => m.type === 1)!.data.browserId;
  const pageId = messages.find(m => m.type === 2)!.data.pageId;
  const input = (event: object) => browserWire(0x10, { browserId, pageId, ...event });
  cdp.emit("Page.screencastFrame", { sessionId: 1, data: Buffer.from([255, 216, 1, 255, 217]).toString("base64"), metadata: { deviceWidth: 1000, deviceHeight: 500 } });
  cdp.send.mockClear();
  const click = input({ event: "click", x: 0.25, y: 0.5 });
  for (const byte of click) socket.emit("data", Buffer.from([byte]));
  await settle();
  expect(cdp.send.mock.calls).toEqual([
    ["Input.dispatchMouseEvent", { type: "mouseMoved", x: 250, y: 250 }],
    ["Input.dispatchMouseEvent", { type: "mousePressed", x: 250, y: 250, button: "left", clickCount: 1 }],
    ["Input.dispatchMouseEvent", { type: "mouseReleased", x: 250, y: 250, button: "left", clickCount: 1 }],
  ]);
  cdp.send.mockClear();
  socket.emit("data", Buffer.concat([browserWire(99, {}), input({ event: "wheel", x: 1, y: 0, dx: -0.25, dy: 0.5 }), input({ event: "text", text: "hello" })]));
  await settle(); await settle();
  expect(cdp.send.mock.calls).toEqual([
    ["Input.dispatchMouseEvent", { type: "mouseWheel", x: 1000, y: 0, deltaX: -250, deltaY: 250 }],
    ["Input.insertText", { text: "hello" }],
  ]);
  for (const [key, virtual] of [["Enter", 13], ["Backspace", 8], ["Tab", 9], ["Escape", 27], ["ArrowUp", 38], ["ArrowDown", 40], ["ArrowLeft", 37], ["ArrowRight", 39]] as const) {
    cdp.send.mockClear(); socket.emit("data", input({ event: "key", key })); await settle();
    expect(cdp.send.mock.calls).toEqual([
      ["Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: virtual, ...(key === "Enter" ? { text: "\r" } : {}) }],
      ["Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: virtual }],
    ]);
  }
  cdp.send.mockClear();
  socket.emit("data", Buffer.concat([input({ event: "key", key: "constructor" }), input({ event: "click", x: "bad", y: 0 }), input({ event: "text", text: "x".repeat(1001) }), browserWire(16, { browserId: "wrong", pageId, event: "text", text: "ignored" })]));
  await settle(); await settle(); await settle();
  expect(cdp.send).not.toHaveBeenCalled();
  cdp.send.mockImplementationOnce(() => { throw new Error("sync CDP failure"); }).mockRejectedValueOnce(new Error("async CDP failure"));
  socket.emit("data", input({ event: "click", x: 0, y: 0 })); await settle(); await settle();
  socket.emit("data", input({ event: "text", text: "still alive" })); await settle();
  expect(cdp.send).toHaveBeenLastCalledWith("Input.insertText", { text: "still alive" });
  page.emit("close"); await settle(); cdp.send.mockClear();
  socket.emit("data", input({ event: "text", text: "closed" })); await settle();
  expect(cdp.send).not.toHaveBeenCalled();
});

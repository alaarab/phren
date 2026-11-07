import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import { createServer, connect, type Server, type Socket } from "node:net";
import path from "node:path";
import { BrowserMessageReader, browserWire, type ProducerMessage, type Ask, type BrowserInput, type BrowserOutcome } from "./browser-protocol.js";
import { BrowserRecordings } from "./browser-recordings.js";

export interface BrowserPage { id: string; url: string; title: string; width: number; height: number; live: boolean }
export interface BrowserHelp { reason: string; t: number }
export interface BrowserSession { id: string; session: string; cwd: string; engine: string; headless: boolean; startedAt: number; endedAt: number | null; live: boolean; pages: BrowserPage[]; control: { held: boolean; since: number | null }; help: BrowserHelp | null }
const MAX_INPUT_BACKLOG = 1024 * 1024;
export class BrowserRegistry extends EventEmitter {
  private browsers = new Map<string, BrowserSession>();
  private owners = new Map<string, object>();
  private controls = new Map<string, { holder: object; since: number; lastInput: number; timer: ReturnType<typeof setTimeout> }>();
  private asks = new Map<string, { socket: Socket; taken: boolean; timer: ReturnType<typeof setTimeout> }>();
  private frames = new Map<string, Buffer>();
  private server?: Server;
  private sockets = new Set<Socket>();
  private timer?: ReturnType<typeof setInterval>;
  readonly recordings: BrowserRecordings;
  constructor(readonly root: string) { super(); this.recordings = new BrowserRecordings(path.join(root, "browser-recordings")); }
  list(now = Date.now()): BrowserSession[] {
    for (const [id, b] of this.browsers) if (b.endedAt !== null && now - b.endedAt > 3_600_000) this.browsers.delete(id);
    return [...this.browsers.values()].reverse().sort((a, b) => Number(b.live) - Number(a.live) || b.startedAt - a.startedAt);
  }
  get(id: string): BrowserSession | undefined { return this.browsers.get(id); }
  last(browser: string, page: string): Buffer | undefined { return this.frames.get(`${browser}/${page}`); }
  accept(owner: object, message: ProducerMessage): void {
    const { data } = message, id = data.browserId;
    if (message.type === 1) {
      if (this.browsers.has(id)) throw new Error("Duplicate browser");
      this.recordings.start(message.data);
      this.owners.set(id, owner);
      this.browsers.set(id, { id, session: message.data.session, cwd: message.data.cwd, engine: "chromium", headless: message.data.headless, startedAt: Date.now(), endedAt: null, live: true, pages: [], control: { held: false, since: null }, help: null });
    } else {
      const browser = this.browsers.get(id);
      if (!browser?.live || this.owners.get(id) !== owner) throw new Error("Unknown browser");
      if (message.type === 2) {
        const p = message.data;
        let page = browser.pages.find(page => page.id === p.pageId);
        if (page && !page.live) throw new Error("Closed page");
        if (!page) { page = { id: p.pageId, url: p.url, title: p.title, width: p.width, height: p.height, live: true }; browser.pages.push(page); }
        Object.assign(page, { url: p.url, title: p.title, width: p.width, height: p.height });
        this.recordings.page(p);
      } else if (message.type === 3) {
        const p = browser.pages.find(p => p.id === message.data.pageId && p.live);
        if (!p) throw new Error("Unknown page");
        p.width = message.data.width; p.height = message.data.height;
        this.frames.set(`${id}/${p.id}`, message.jpeg);
        this.recordings.frame(message.data, message.jpeg);
        this.emit("frame", id, p.id, message.jpeg); return;
      } else if (message.data.pageId) {
        const p = browser.pages.find(p => p.id === message.data.pageId);
        if (!p) throw new Error("Unknown page");
        p.live = false; this.frames.delete(`${id}/${p.id}`);
      } else { this.end(id); return; }
    }
    this.emit("change", id);
  }
  controlState(id: string, connection: object): { type: "control"; holder: "you" | "other" | null; help: BrowserHelp | null } {
    const control = this.controls.get(id);
    return { type: "control", holder: control ? control.holder === connection ? "you" : "other" : null, help: this.get(id)?.help ?? null };
  }
  take(id: string, holder: object): void {
    const browser = this.get(id); if (!browser?.live) return;
    const ask = this.asks.get(id); if (ask) ask.taken = true;
    const previous = this.controls.get(id); if (previous?.holder === holder) return;
    if (previous) { clearTimeout(previous.timer); this.handoff(id, "release", "stolen"); }
    const now = Date.now();
    const control = { holder, since: now, lastInput: now, timer: setTimeout(() => this.release(id, holder, "idle"), 120_000) };
    control.timer.unref(); this.controls.set(id, control);
    browser.control = { held: true, since: now };
    this.handoff(id, "take"); this.controlChanged(id);
  }
  release(id: string, holder: object, reason?: string): void {
    const control = this.controls.get(id); if (!control || control.holder !== holder) return;
    clearTimeout(control.timer); this.controls.delete(id);
    const browser = this.get(id); if (browser) browser.control = { held: false, since: null };
    this.handoff(id, "release", reason);
    if (this.asks.get(id)?.taken) this.finishAsk(id, "done");
    this.controlChanged(id);
  }
  input(id: string, holder: object, input: BrowserInput): boolean {
    const control = this.controls.get(id);
    if (!control || control.holder !== holder) return false;
    if (!this.get(id)?.pages.some(p => p.id === input.pageId && p.live)) return true;
    control.lastInput = Date.now(); clearTimeout(control.timer);
    control.timer = setTimeout(() => this.release(id, holder, "idle"), 120_000); control.timer.unref();
    const socket = this.owners.get(id) as Socket | undefined;
    try {
      if (socket?.write && !socket.destroyed && socket.writableLength < MAX_INPUT_BACKLOG) socket.write(browserWire(0x10, input));
    } catch { /* A disconnected producer cannot take down the Hook. */ }
    return true;
  }
  private handoff(id: string, kind: "take" | "release" | "help", reason?: string): void {
    try { this.recordings.handoff(id, kind, reason); } catch { /* Control survives recording failures. */ }
  }
  private controlChanged(id: string): void { this.emit("control", id); this.emit("change", id); }
  private finishAsk(id: string, outcome?: BrowserOutcome): void {
    const ask = this.asks.get(id); if (!ask) return;
    clearTimeout(ask.timer); this.asks.delete(id);
    const browser = this.get(id); if (browser) browser.help = null;
    if (outcome && !ask.socket.destroyed) ask.socket.end(browserWire(0x13, { outcome }));
    this.controlChanged(id);
  }
  private ask(socket: Socket, request: Ask): void {
    const live = this.list().filter(b => b.live);
    const browser = request.browserId ? live.find(b => b.id === request.browserId) : live.find(b => request.session !== undefined && b.session === request.session) ?? live[0];
    if (!browser) { socket.end(browserWire(0x13, { outcome: "no-browser" })); return; }
    this.finishAsk(browser.id, "timeout");
    const timer = setTimeout(() => this.finishAsk(browser.id, "timeout"), (request.timeout ?? 900) * 1000); timer.unref();
    this.asks.set(browser.id, { socket, timer, taken: this.controls.has(browser.id) });
    browser.help = { reason: request.reason, t: Date.now() };
    socket.write(browserWire(0x12, { browserId: browser.id }));
    this.handoff(browser.id, "help", request.reason); this.controlChanged(browser.id);
  }
  disconnect(owner: object): void { for (const [id, who] of this.owners) if (who === owner) this.end(id); }
  private end(id: string): void {
    const b = this.browsers.get(id); if (!b?.live) return;
    // Settle help as ended before releasing control (which normally completes it).
    this.finishAsk(id, "ended");
    const control = this.controls.get(id); if (control) this.release(id, control.holder, "ended");
    b.live = false; b.endedAt = Date.now(); this.owners.delete(id);
    for (const p of b.pages) { p.live = false; this.frames.delete(`${id}/${p.id}`); }
    try { this.recordings.end(id); } catch { /* Preserve live lifecycle even if the disk failed. */ }
    this.emit("change", id);
  }
  async start(): Promise<void> {
    this.recordings.recover(); this.recordings.retain();
    const socketPath = path.join(this.root, "browser.sock");
    const old = await fs.lstat(socketPath).catch(() => undefined);
    if (old) {
      if (!old.isSocket() || (process.getuid && old.uid !== process.getuid())) throw new Error("Unexpected browser socket");
      const live = await new Promise<boolean>(resolve => { const s = connect(socketPath); s.once("connect", () => { s.destroy(); resolve(true); }); s.once("error", () => resolve(false)); s.setTimeout(500, () => { s.destroy(); resolve(true); }); });
      if (live) throw new Error("Browser socket already active");
      await fs.unlink(socketPath);
    }
    this.server = createServer(socket => {
      if (this.sockets.size >= 128) { socket.destroy(); return; }
      this.sockets.add(socket); const reader = new BrowserMessageReader();
      let mode: "ask" | "browser" | undefined, asked = false;
      socket.on("data", (chunk: Buffer) => { try { for (const message of reader.push(chunk)) {
        if (!mode) mode = message.type === 5 ? "ask" : "browser";
        if (mode === "ask") {
          if (message.type !== 5 || asked) throw new Error("Invalid ask connection");
          asked = true; this.ask(socket, message.data);
        } else if (message.type === 1 || message.type === 2 || message.type === 3 || message.type === 4) this.accept(socket, message);
        else throw new Error("Invalid producer message");
      } } catch { socket.destroy(); } });
      socket.on("error", () => {});
      socket.on("close", () => { this.sockets.delete(socket); for (const [id, ask] of this.asks) if (ask.socket === socket) this.finishAsk(id); this.disconnect(socket); });
    });
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(socketPath, resolve); });
    await fs.chmod(socketPath, 0o600);
    this.timer = setInterval(() => { try { this.recordings.retain(); this.list(); } catch { /* disk unavailable */ } }, 3_600_000); this.timer.unref();
  }
  close(): void { clearInterval(this.timer); for (const s of this.sockets) s.destroy(); for (const id of this.owners.keys()) this.end(id); this.server?.close(); }
}

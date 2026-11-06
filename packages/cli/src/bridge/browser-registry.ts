import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import { createServer, connect, type Server, type Socket } from "node:net";
import path from "node:path";
import { BrowserMessageReader, type BrowserMessage } from "./browser-protocol.js";
import { BrowserRecordings } from "./browser-recordings.js";

export interface BrowserPage { id: string; url: string; title: string; width: number; height: number; live: boolean }
export interface BrowserSession { id: string; session: string; cwd: string; engine: string; headless: boolean; startedAt: number; endedAt: number | null; live: boolean; pages: BrowserPage[] }
export class BrowserRegistry extends EventEmitter {
  private browsers = new Map<string, BrowserSession>();
  private owners = new Map<string, object>();
  private frames = new Map<string, Buffer>();
  private server?: Server;
  private sockets = new Set<Socket>();
  private timer?: ReturnType<typeof setInterval>;
  readonly recordings: BrowserRecordings;
  constructor(readonly root: string) { super(); this.recordings = new BrowserRecordings(path.join(root, "browser-recordings")); }
  list(now = Date.now()): BrowserSession[] {
    for (const [id, b] of this.browsers) if (b.endedAt !== null && now - b.endedAt > 3_600_000) this.browsers.delete(id);
    return [...this.browsers.values()].sort((a, b) => Number(b.live) - Number(a.live) || b.startedAt - a.startedAt);
  }
  get(id: string): BrowserSession | undefined { return this.browsers.get(id); }
  last(browser: string, page: string): Buffer | undefined { return this.frames.get(`${browser}/${page}`); }
  accept(owner: object, message: BrowserMessage): void {
    const { data } = message, id = data.browserId;
    if (message.type === 1) {
      if (this.browsers.has(id)) throw new Error("Duplicate browser");
      this.recordings.start(message.data);
      this.owners.set(id, owner);
      this.browsers.set(id, { id, session: message.data.session, cwd: message.data.cwd, engine: "chromium", headless: message.data.headless, startedAt: Date.now(), endedAt: null, live: true, pages: [] });
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
  disconnect(owner: object): void { for (const [id, who] of this.owners) if (who === owner) this.end(id); }
  private end(id: string): void {
    const b = this.browsers.get(id); if (!b?.live) return;
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
      socket.on("data", chunk => { try { for (const message of reader.push(chunk)) this.accept(socket, message); } catch { socket.destroy(); } });
      socket.on("error", () => {});
      socket.on("close", () => { this.sockets.delete(socket); this.disconnect(socket); });
    });
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(socketPath, resolve); });
    await fs.chmod(socketPath, 0o600);
    this.timer = setInterval(() => { try { this.recordings.retain(); this.list(); } catch { /* disk unavailable */ } }, 3_600_000); this.timer.unref();
  }
  close(): void { clearInterval(this.timer); for (const s of this.sockets) s.destroy(); for (const id of this.owners.keys()) this.end(id); this.server?.close(); }
}

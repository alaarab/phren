import * as fs from "node:fs";
import path from "node:path";
import { BridgeError } from "./protocol.js";
import { BROWSER_ID, type Hello, type PageInfo, type FrameInfo } from "./browser-protocol.js";

export interface RecordingMeta {
  id: string; browserId: string; session: string; cwd: string; engine: string; headless: boolean;
  startedAt: number; endedAt: number | null; frames: number; bytes: number;
  pages: { pageId: string; url: string; title: string; t: number }[];
  navigations: { t: number; pageId: string; url: string; title: string }[];
}
interface IndexFrame { t: number; pageId: string; offset: number; length: number; width: number; height: number }
export function browserId(value: string | null): string {
  if (!value || !BROWSER_ID.test(value)) throw new BridgeError(400, "Invalid browser identifier.");
  return value;
}
export class BrowserRecordings {
  private active = new Map<string, { meta: RecordingMeta; last: Map<string, { t: number; jpeg: Buffer }> }>();
  constructor(readonly root: string) { fs.mkdirSync(root, { recursive: true, mode: 0o700 }); }
  private dir(id: string): string { return path.join(this.root, browserId(id)); }
  private save(meta: RecordingMeta): void {
    const dir = this.dir(meta.id);
    fs.writeFileSync(path.join(dir, "meta.tmp"), JSON.stringify(meta), { mode: 0o600 });
    fs.renameSync(path.join(dir, "meta.tmp"), path.join(dir, "meta.json"));
  }
  start(hello: Hello, now = Date.now()): void {
    const dir = this.dir(hello.browserId);
    fs.mkdirSync(dir, { mode: 0o700 }); // never overwrite an earlier recording
    fs.writeFileSync(path.join(dir, "frames.bin"), "", { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "index.jsonl"), "", { mode: 0o600 });
    const meta: RecordingMeta = { id: hello.browserId, browserId: hello.browserId, session: hello.session, cwd: hello.cwd, engine: hello.engine, headless: hello.headless, startedAt: now, endedAt: null, frames: 0, bytes: 0, pages: [], navigations: [] };
    this.save(meta); this.active.set(meta.id, { meta, last: new Map() });
  }
  page(page: PageInfo, now = Date.now()): void {
    const state = this.active.get(page.browserId); if (!state) return;
    const nav = { t: now, pageId: page.pageId, url: page.url, title: page.title };
    const previous = state.meta.navigations.filter(n => n.pageId === page.pageId).at(-1);
    if (previous?.url === page.url && previous.title === page.title) return;
    const existing = state.meta.pages.find(p => p.pageId === page.pageId);
    // A copy: the page entry follows the latest navigation, the timeline keeps each one as it was.
    if (existing) Object.assign(existing, { url: nav.url, title: nav.title }); else state.meta.pages.push({ ...nav });
    // The shim announces a navigation before its title loads; the title then completes that entry.
    if (previous?.url === page.url && !previous.title) previous.title = page.title;
    else state.meta.navigations.push(nav);
    this.save(state.meta);
  }
  frame(info: FrameInfo, jpeg: Buffer): void {
    const state = this.active.get(info.browserId); if (!state) return;
    const last = state.last.get(info.pageId);
    if (last && (info.t - last.t < 250 || jpeg.equals(last.jpeg))) return;
    // Bound an individual live recording too, so a long-running browser cannot fill disk between sweeps.
    if (state.meta.bytes + jpeg.length > 1024 ** 3) return;
    const dir = this.dir(info.browserId);
    const row: IndexFrame = { t: info.t, pageId: info.pageId, offset: state.meta.bytes, length: jpeg.length, width: info.width, height: info.height };
    fs.appendFileSync(path.join(dir, "frames.bin"), jpeg);
    fs.appendFileSync(path.join(dir, "index.jsonl"), JSON.stringify(row) + "\n");
    state.meta.bytes += jpeg.length; state.meta.frames++;
    state.last.set(info.pageId, { t: info.t, jpeg }); this.save(state.meta);
  }
  end(id: string, now = Date.now()): void {
    const state = this.active.get(id); if (!state) return;
    state.meta.endedAt = now; this.save(state.meta); this.active.delete(id);
  }
  list(): RecordingMeta[] {
    return fs.readdirSync(this.root).filter(id => BROWSER_ID.test(id)).flatMap(id => {
      try { return [JSON.parse(fs.readFileSync(path.join(this.dir(id), "meta.json"), "utf8")) as RecordingMeta]; } catch { return []; }
    }).sort((a, b) => b.startedAt - a.startedAt);
  }
  index(id: string): { meta: RecordingMeta; frames: IndexFrame[] } {
    const dir = this.dir(id);
    try {
      return { meta: JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")), frames: fs.readFileSync(path.join(dir, "index.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as IndexFrame) };
    } catch { throw new BridgeError(404, "Recording not found."); }
  }
  frameAt(id: string, n: number): Buffer {
    const row = this.index(id).frames[n]; if (!row) throw new BridgeError(404, "Frame not found.");
    const fd = fs.openSync(path.join(this.dir(id), "frames.bin"), "r");
    try { const bytes = Buffer.alloc(row.length); if (fs.readSync(fd, bytes, 0, bytes.length, row.offset) !== bytes.length) throw new BridgeError(404, "Frame unavailable."); return bytes; } finally { fs.closeSync(fd); }
  }
  remove(id: string): void {
    browserId(id);
    if (this.active.has(id)) throw new BridgeError(409, "Browser is still recording.");
    fs.rmSync(this.dir(id), { recursive: true, force: true });
  }
  /** Recover archives left open by a Hook crash before accepting new producers. */
  recover(now = Date.now()): void {
    for (const meta of this.list()) if (meta.endedAt === null && !this.active.has(meta.id)) { meta.endedAt = now; this.save(meta); }
  }
  retain(now = Date.now(), budget = 1024 ** 3): void {
    const all = this.list();
    const sizes = new Map(all.map(m => [m.id, fs.readdirSync(this.dir(m.id)).reduce((n, file) => n + fs.statSync(path.join(this.dir(m.id), file)).size, 0)]));
    let total = [...sizes.values()].reduce((a, b) => a + b, 0);
    for (const meta of all.reverse()) {
      if (now - meta.startedAt >= 86_400_000 || total > budget) {
        // Retention includes live recordings. Capture continues live after its expired archive is removed.
        this.active.delete(meta.id); this.remove(meta.id); total -= sizes.get(meta.id) ?? 0;
      }
    }
  }
}

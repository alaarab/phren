import * as fs from "node:fs";
import path from "node:path";
import { BridgeError } from "./protocol.js";
import { BROWSER_ID, type Hello, type PageInfo, type FrameInfo } from "./browser-protocol.js";

export interface BrowserHandoff { t: number; kind: "take" | "release" | "help"; reason?: string }
export interface RecordingMeta {
  id: string; browserId: string; session: string; cwd: string; engine: string; headless: boolean;
  startedAt: number; endedAt: number | null; frames: number; bytes: number;
  pages: { pageId: string; url: string; title: string; t: number }[];
  handoffs: BrowserHandoff[];
  navigations: { t: number; pageId: string; url: string; title: string }[];
}
/**
 * What a watched page can make the Hook keep. Its URL, title and navigations
 * are the page's to choose, so each is cut to a size and the lists to a length:
 * the metadata file, rewritten whole on every change, stays under about 1 MB.
 */
export const RECORDING_LIMITS = { url: 1024, title: 200, reason: 1024, navigations: 500, navigationsPerSecond: 10, pages: 100, handoffs: 500, saveEveryMs: 1000 } as const;
interface Active { meta: RecordingMeta; last: Map<string, { t: number; jpeg: Buffer }>; savedAt: number; timer?: NodeJS.Timeout; second: number; inSecond: number }
interface IndexFrame { t: number; pageId: string; offset: number; length: number; width: number; height: number }
export function browserId(value: string | null): string {
  if (!value || !BROWSER_ID.test(value)) throw new BridgeError(400, "Invalid browser identifier.");
  return value;
}
export class BrowserRecordings {
  private active = new Map<string, Active>();
  constructor(readonly root: string) { fs.mkdirSync(root, { recursive: true, mode: 0o700 }); }
  private dir(id: string): string { return path.join(this.root, browserId(id)); }
  private save(meta: RecordingMeta): void {
    const dir = this.dir(meta.id);
    fs.writeFileSync(path.join(dir, "meta.tmp"), JSON.stringify(meta), { mode: 0o600 });
    fs.renameSync(path.join(dir, "meta.tmp"), path.join(dir, "meta.json"));
  }
  /** Frames arrive up to four times a second; their counters reach the file at most once a second, and at the end. */
  private saveSoon(state: Active): void {
    const wait = state.savedAt + RECORDING_LIMITS.saveEveryMs - Date.now();
    if (wait <= 0) { this.saveNow(state); return; }
    state.timer ??= setTimeout(() => {
      state.timer = undefined;
      // Retention may have removed the recording meanwhile.
      if (this.active.get(state.meta.id) === state) try { this.saveNow(state); } catch { /* the folder is gone */ }
    }, wait).unref();
  }
  private saveNow(state: Active): void {
    clearTimeout(state.timer); state.timer = undefined;
    this.save(state.meta); state.savedAt = Date.now();
  }
  private forget(id: string): void { clearTimeout(this.active.get(id)?.timer); this.active.delete(id); }
  start(hello: Hello, now = Date.now()): void {
    const dir = this.dir(hello.browserId);
    fs.mkdirSync(dir, { mode: 0o700 }); // never overwrite an earlier recording
    fs.writeFileSync(path.join(dir, "frames.bin"), "", { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "index.jsonl"), "", { mode: 0o600 });
    const meta: RecordingMeta = { id: hello.browserId, browserId: hello.browserId, session: hello.session, cwd: hello.cwd, engine: hello.engine, headless: hello.headless, startedAt: now, endedAt: null, frames: 0, bytes: 0, pages: [], navigations: [], handoffs: [] };
    this.save(meta); this.active.set(meta.id, { meta, last: new Map(), savedAt: Date.now(), second: 0, inSecond: 0 });
  }
  page(page: PageInfo, now = Date.now()): void {
    const state = this.active.get(page.browserId); if (!state) return;
    const nav = { t: now, pageId: page.pageId, url: page.url.slice(0, RECORDING_LIMITS.url), title: page.title.slice(0, RECORDING_LIMITS.title) };
    const previous = state.meta.navigations.filter(n => n.pageId === page.pageId).at(-1);
    if (previous?.url === nav.url && previous.title === nav.title) return;
    const existing = state.meta.pages.find(p => p.pageId === page.pageId);
    // A copy: the page entry follows the latest navigation, the timeline keeps each one as it was.
    if (existing) Object.assign(existing, { url: nav.url, title: nav.title });
    else if (state.meta.pages.length < RECORDING_LIMITS.pages) state.meta.pages.push({ ...nav });
    else return;
    // The shim announces a navigation before its title loads; the title then completes that entry.
    if (previous?.url === nav.url && !previous.title) previous.title = nav.title;
    else {
      // A page that navigates in a loop fills neither the timeline nor the disk:
      // past the limits the page entry still follows it, the timeline does not.
      const second = Math.floor(now / 1000);
      if (state.second !== second) { state.second = second; state.inSecond = 0; }
      if (state.meta.navigations.length >= RECORDING_LIMITS.navigations || ++state.inSecond > RECORDING_LIMITS.navigationsPerSecond) { this.saveSoon(state); return; }
      state.meta.navigations.push(nav);
    }
    this.saveNow(state);
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
    state.last.set(info.pageId, { t: info.t, jpeg }); this.saveSoon(state);
  }
  handoff(id: string, kind: BrowserHandoff["kind"], reason?: string): void {
    const state = this.active.get(id); if (!state) return;
    if (state.meta.handoffs.length >= RECORDING_LIMITS.handoffs) return;
    state.meta.handoffs.push({ t: Date.now(), kind, ...(reason ? { reason: reason.slice(0, RECORDING_LIMITS.reason) } : {}) });
    this.saveNow(state);
  }
  end(id: string, now = Date.now()): void {
    const state = this.active.get(id); if (!state) return;
    state.meta.endedAt = now; this.saveNow(state); this.forget(id);
  }
  list(): RecordingMeta[] {
    return fs.readdirSync(this.root).filter(id => BROWSER_ID.test(id)).flatMap(id => {
      try { return [JSON.parse(fs.readFileSync(path.join(this.dir(id), "meta.json"), "utf8")) as RecordingMeta]; } catch { return []; }
    }).sort((a, b) => b.startedAt - a.startedAt);
  }
  index(id: string): { meta: RecordingMeta; frames: IndexFrame[] } {
    const dir = this.dir(id);
    try {
      return { meta: JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")), 
        // A crash during an append leaves a torn last line; the complete rows before it still play.
        frames: fs.readFileSync(path.join(dir, "index.jsonl"), "utf8").split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as IndexFrame]; } catch { return []; } }) };
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
    for (const meta of this.list()) if (meta.endedAt === null && !this.active.has(meta.id)) {
      // The counters in the file can trail the frames written in the last second before the crash.
      try {
        const frames = this.index(meta.id).frames, final = frames.at(-1);
        meta.frames = frames.length; meta.bytes = final ? final.offset + final.length : 0;
      } catch { /* keep what the file says */ }
      meta.endedAt = now; this.save(meta);
    }
  }
  retain(now = Date.now(), budget = 1024 ** 3): void {
    const all = this.list();
    const sizes = new Map(all.map(m => [m.id, fs.readdirSync(this.dir(m.id)).reduce((n, file) => n + fs.statSync(path.join(this.dir(m.id), file)).size, 0)]));
    let total = [...sizes.values()].reduce((a, b) => a + b, 0);
    for (const meta of all.reverse()) {
      if (now - meta.startedAt >= 86_400_000 || total > budget) {
        // Retention includes live recordings. Capture continues live after its expired archive is removed.
        this.forget(meta.id); this.remove(meta.id); total -= sizes.get(meta.id) ?? 0;
      }
    }
  }
}

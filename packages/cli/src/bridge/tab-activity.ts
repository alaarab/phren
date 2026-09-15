import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { bridgeRoot, object, objects, type Json } from "./protocol.js";

type Stamp = { signature: string; lastChangedAt: string };
export const tabActivityKey = (workspace: unknown, tab: unknown): string => JSON.stringify([workspace, tab]);

/** A clock for Herdr's clockless state counters. Only successful snapshots
 * prune tabs; offline servers keep their last known times. Writes are ordered
 * and atomic, and an unchanged poll never rewrites the file. */
export class TabActivityStore {
  private entries = new Map<string, Stamp>();
  private loaded = false;
  private dirty = false;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly file = path.join(bridgeRoot(), "tab-activity.json"),
              private readonly now: () => Date = () => new Date()) {}

  observe(server: string, snapshot: Json): Promise<ReadonlyMap<string, string>> {
    const at = this.now().toISOString();
    const operation = this.pending.catch(() => {}).then(async () => {
      if (!this.loaded) {
        const saved = await readFile(this.file, "utf8").then(JSON.parse).catch(() => ({}));
        for (const [key, value] of Object.entries(object(object(saved).entries))) {
          const stamp = object(value);
          if (typeof stamp.signature === "string" && typeof stamp.lastChangedAt === "string"
              && Number.isFinite(Date.parse(stamp.lastChangedAt))) {
            this.entries.set(key, { signature: stamp.signature, lastChangedAt: stamp.lastChangedAt });
          }
        }
        this.loaded = true;
      }
      const prefix = JSON.stringify(server) + ":";
      const seen = new Set<string>(), times = new Map<string, string>();
      let changed = false;
      for (const tab of objects(snapshot.tabs)) {
        const tabKey = tabActivityKey(tab.workspace_id, tab.tab_id), key = prefix + tabKey;
        seen.add(key);
        // Include every pane: a lower counter changing must count even when
        // another pane still has the tab's maximum state_change_seq.
        const panes = objects(snapshot.panes).filter(p => p.workspace_id === tab.workspace_id && p.tab_id === tab.tab_id)
          .map(p => [p.pane_id, p.agent, p.agent_status, p.state_change_seq, p.title || p.terminal_title_stripped])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
        const signature = JSON.stringify([tab.agent_status, tab.state_change_seq, tab.label, tab.title, panes]);
        let stamp = this.entries.get(key);
        if (stamp?.signature !== signature) {
          stamp = { signature, lastChangedAt: at };
          this.entries.set(key, stamp); changed = true;
        }
        times.set(tabKey, stamp!.lastChangedAt);
      }
      for (const key of this.entries.keys()) {
        if (key.startsWith(prefix) && !seen.has(key)) { this.entries.delete(key); changed = true; }
      }
      this.dirty ||= changed;
      if (this.dirty) {
        try {
          await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
          const temporary = this.file + ".tmp";
          await writeFile(temporary, JSON.stringify({ version: 1, entries: Object.fromEntries(this.entries) }), { mode: 0o600 });
          await rename(temporary, this.file);
          this.dirty = false;
        } catch {
          // A full/unwritable disk must not hide live sessions. Keep the clock
          // in memory and retry saving on the next successful snapshot.
        }
      }
      return times;
    });
    this.pending = operation;
    return operation;
  }
}

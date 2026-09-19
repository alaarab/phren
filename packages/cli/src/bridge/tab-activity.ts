import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { bridgeRoot, object, objects, type Json } from "./protocol.js";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
type Stamp = { signature: string; lastChangedAt: string };
export const tabActivityKey = (workspace: unknown, tab: unknown): string => JSON.stringify([workspace, tab]);

/** A clock for Herdr's clockless state counters. Only successful snapshots
 * prune tabs; each activity pass also prunes missing servers. Writes are ordered
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
      await this.load();
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
        const signature = digest(JSON.stringify([tab.agent_status, tab.state_change_seq, tab.label, tab.title, panes]));
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
      await this.persist();
      return times;
    });
    this.pending = operation;
    return operation;
  }
  private async load() {
    if (!this.loaded) {
        const saved = await readFile(this.file, "utf8").then(JSON.parse).catch(() => ({}));
        for (const [key, value] of Object.entries(object(object(saved).entries))) {
          const stamp = object(value);
          if (typeof stamp.signature === "string" && typeof stamp.lastChangedAt === "string"
              && Number.isFinite(Date.parse(stamp.lastChangedAt))) {
            const hashed = /^[a-f0-9]{64}$/.test(stamp.signature);
            this.entries.set(key, { signature: hashed ? stamp.signature : digest(stamp.signature), lastChangedAt: stamp.lastChangedAt });
            this.dirty ||= !hashed;
          }
        }
        this.loaded = true;
      }
  }
  private async persist() {
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
  }
  pruneServers(servers: string[]): Promise<void> {
    const operation = this.pending.catch(() => {}).then(async () => {
      await this.load();
      const prefixes = servers.map(server => JSON.stringify(server) + ":");
      for (const key of this.entries.keys()) if (!prefixes.some(prefix => key.startsWith(prefix))) {
        this.entries.delete(key); this.dirty = true;
      }
      await this.persist();
    });
    this.pending = operation;
    return operation;
  }

}

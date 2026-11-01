import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { atomicInPrivateDir, bridgeRoot, object, objects, type Json } from "./protocol.js";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
type Stamp = { signature: string; statusSignature?: string; lastChangedAt: string; statusSince: string };
type StatusRow = { workspace: unknown; tab: unknown; status: unknown };
export type TabActivityStamp = Pick<Stamp, "lastChangedAt" | "statusSince">;
export type TabActivityObservation = { generation: number; stamps: ReadonlyMap<string, TabActivityStamp> };
export const tabActivityKey = (workspace: unknown, tab: unknown): string => JSON.stringify([workspace, tab]);

/** A clock for Herdr's clockless state counters. Only successful snapshots
 * prune tabs; each activity pass also prunes missing servers. Writes are ordered
 * and atomic, and an unchanged poll never rewrites the file. */
export class TabActivityStore {
  private entries = new Map<string, Stamp>();
  private loaded = false;
  private dirty = false;
  private pending: Promise<unknown> = Promise.resolve();
  private nextGeneration = new Map<string, number>();
  private committedGeneration = new Map<string, number>();
  constructor(private readonly file = path.join(bridgeRoot(), "tab-activity.json"),
              private readonly now: () => Date = () => new Date()) {}

  observe(server: string, snapshot: Json): Promise<TabActivityObservation> {
    const at = this.now().toISOString();
    const operation = this.pending.catch(() => {}).then(async () => {
      await this.load();
      const generation = (this.nextGeneration.get(server) ?? 0) + 1;
      this.nextGeneration.set(server, generation);
      const prefix = JSON.stringify(server) + ":";
      const seen = new Set<string>(), stamps = new Map<string, TabActivityStamp>();
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
        const stamp = this.entries.get(key);
        if (!stamp) {
          this.entries.set(key, { signature, lastChangedAt: at, statusSince: at }); changed = true;
        } else if (stamp.signature !== signature) {
          this.entries.set(key, { ...stamp, signature, lastChangedAt: at }); changed = true;
        }
        const current = this.entries.get(key)!;
        stamps.set(tabKey, { lastChangedAt: current.lastChangedAt, statusSince: current.statusSince });
      }
      for (const key of this.entries.keys()) {
        if (key.startsWith(prefix) && !seen.has(key)) { this.entries.delete(key); changed = true; }
      }
      this.dirty ||= changed;
      await this.persist();
      return { generation, stamps };
    });
    this.pending = operation;
    return operation;
  }
  /** The status clock follows the final `agentStatus` the overview sends, after
   * background work and other decoration change it. Keep this off `observe`:
   * the background activity timer polls raw snapshots and must not reset it.
   * `generation` comes from the observation that started this enrichment, so an
   * older snapshot that finishes later cannot overwrite a newer one. */
  recordStatus(server: string, rows: readonly StatusRow[], generation: number): Promise<ReadonlyMap<string, TabActivityStamp>> {
    const at = this.now().toISOString();
    const operation = this.pending.catch(() => {}).then(async () => {
      await this.load();
      const prefix = JSON.stringify(server) + ":";
      const stamps = new Map<string, TabActivityStamp>();
      const committed = this.committedGeneration.get(server) ?? 0, stale = generation < committed;
      if (!stale) this.committedGeneration.set(server, generation);
      let changed = false;
      for (const row of rows) {
        const tabKey = tabActivityKey(row.workspace, row.tab), key = prefix + tabKey;
        const stamp = this.entries.get(key);
        if (!stamp) continue;
        const statusSignature = digest(JSON.stringify([row.status]));
        if (!stale) {
          if (stamp.statusSignature === undefined) {
            this.entries.set(key, { ...stamp, statusSignature }); changed = true;
          } else if (stamp.statusSignature !== statusSignature) {
            this.entries.set(key, { ...stamp, statusSignature, statusSince: at }); changed = true;
          }
        }
        const current = this.entries.get(key)!;
        stamps.set(tabKey, { lastChangedAt: current.lastChangedAt, statusSince: current.statusSince });
      }
      this.dirty ||= changed;
      await this.persist();
      return stamps;
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
            const savedStatus = typeof stamp.statusSignature === "string" ? stamp.statusSignature : undefined;
            const statusHashed = savedStatus !== undefined && /^[a-f0-9]{64}$/.test(savedStatus);
            const statusSince = typeof stamp.statusSince === "string" && Number.isFinite(Date.parse(stamp.statusSince))
              ? stamp.statusSince : stamp.lastChangedAt;
            this.entries.set(key, { signature: hashed ? stamp.signature : digest(stamp.signature),
              statusSignature: savedStatus === undefined ? undefined : statusHashed ? savedStatus : digest(savedStatus),
              lastChangedAt: stamp.lastChangedAt, statusSince });
            this.dirty ||= !hashed || savedStatus === undefined || !statusHashed || statusSince !== stamp.statusSince;
          }
        }
        this.loaded = true;
      }
  }
  private async persist() {
      if (this.dirty) {
        try {
          await atomicInPrivateDir(this.file, JSON.stringify({ version: 1, entries: Object.fromEntries(this.entries) }));
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

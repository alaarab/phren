import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TabActivityStore, tabActivityKey } from "./tab-activity.js";
import { workspaceSnapshot } from "./herdr.js";
import { objects, type Json } from "./protocol.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function file() { const dir = await mkdtemp(path.join(tmpdir(), "phren-tab-activity-")); directories.push(dir); return path.join(dir, "tab-activity.json"); }
function snapshot(status = "working", seq = 1, title = "Build", label = "Tab"): Json {
  return { workspaces: [{ workspace_id: "w1", label: "Project" }],
    tabs: [{ workspace_id: "w1", tab_id: "t1", label, agent_status: status }],
    panes: [{ workspace_id: "w1", tab_id: "t1", pane_id: "p1", agent: "codex", state_change_seq: seq, title }] };
}
const key = tabActivityKey("w1", "t1");
const statusRows = (snapshot: Json) => objects(snapshot.tabs).map(tab => ({ workspace: tab.workspace_id, tab: tab.tab_id, status: tab.agent_status }));
const observe = async (store: TabActivityStore, snapshot: Json, server = "default") => (await store.observe(server, snapshot)).stamps;
async function observed(store: TabActivityStore, snapshot: Json, server = "default") {
  const { generation } = await store.observe(server, snapshot);
  return store.recordStatus(server, statusRows(snapshot), generation);
}

describe("persisted tab activity clock", () => {
  it("stamps changes and exports ISO dates without rewriting unchanged polls", async () => {
    const location = await file(); let now = new Date("2026-09-15T10:00:00Z");
    const store = new TabActivityStore(location, () => now);
    const first = await observed(store, snapshot());
    expect(first.get(key)).toEqual({ lastChangedAt: now.toISOString(), statusSince: now.toISOString() });
    const row = objects(objects(workspaceSnapshot(snapshot(), undefined, undefined, first).groups)[0].children)[0];
    expect(row.lastChangedAt).toBe(now.toISOString());
    expect(row.statusSince).toBe(now.toISOString());
    const modified = (await stat(location)).mtimeMs;
    now = new Date("2026-09-15T10:01:00Z");
    expect((await observed(store, snapshot())).get(key)).toEqual(first.get(key));
    expect((await stat(location)).mtimeMs).toBe(modified);
    for (const changed of [snapshot("waiting"), snapshot("waiting", 2), snapshot("waiting", 2, "Review")]) {
      now = new Date(now.getTime() + 1000);
      expect((await observed(store, changed)).get(key)?.lastChangedAt).toBe(now.toISOString());
    }
  });
  it("keeps statusSince through title, label and counter changes and resets it on a status change", async () => {
    const location = await file(), first = "2026-09-15T10:00:00.000Z";
    let now = new Date(first);
    const store = new TabActivityStore(location, () => now);
    await observed(store, snapshot("working"));
    for (const [name, change, statusChanged] of [
      ["title", snapshot("working", 1, "Review"), false],
      ["label", snapshot("working", 1, "Build", "Renamed"), false],
      ["counter", snapshot("working", 2), false],
      ["status", snapshot("waiting", 2), true],
    ] as const) {
      now = new Date(now.getTime() + 60_000);
      const stamp = (await observed(store, change)).get(key)!;
      expect(stamp.lastChangedAt, name).toBe(now.toISOString());
      expect(stamp.statusSince, name).toBe(statusChanged ? now.toISOString() : first);
    }
  });
  it("keeps a statusSince older than lastChangedAt across restarts", async () => {
    const location = await file(), first = new Date("2026-09-15T10:00:00Z");
    let now = first;
    const store = new TabActivityStore(location, () => now);
    await observed(store, snapshot("working"));
    now = new Date("2026-09-15T10:01:00Z");
    const changed = (await observed(store, snapshot("working", 1, "Review"))).get(key)!;
    expect(changed).toEqual({ lastChangedAt: now.toISOString(), statusSince: first.toISOString() });
    const restarted = new TabActivityStore(location, () => new Date("2026-09-15T10:02:00Z"));
    expect((await observed(restarted, snapshot("working", 1, "Review"))).get(key)).toEqual(changed);
  });
  it("ignores a malformed persisted statusSince and falls back to lastChangedAt", async () => {
    const location = await file(), now = new Date("2026-09-15T10:00:00Z");
    const plain = JSON.stringify(["working", null, "Tab", null, [["p1", "codex", null, 1, "Build"]]]);
    await writeFile(location, JSON.stringify({ entries: { ['"default":' + key]: {
      signature: plain, lastChangedAt: now.toISOString(), statusSince: "not-a-date" } } }));
    const restarted = new TabActivityStore(location, () => new Date(now.getTime() + 60_000));
    const stamp = (await observed(restarted, snapshot())).get(key)!;
    expect(stamp.lastChangedAt).toBe(now.toISOString());
    expect(stamp.statusSince).toBe(now.toISOString());
    const saved = JSON.parse(await readFile(location, "utf8")).entries['"default":' + key];
    expect(saved.statusSince).toBe(now.toISOString());
  });
  it("restores times across restarts and prunes only the observed server", async () => {
    const location = await file(), before = new Date("2026-09-15T10:00:00Z"), after = new Date("2026-09-15T11:00:00Z");
    const store = new TabActivityStore(location, () => before);
    await Promise.all([store.observe("default", snapshot()), store.observe("work", snapshot())]);
    const restarted = new TabActivityStore(location, () => after);
    expect((await observe(restarted, snapshot())).get(key)?.lastChangedAt).toBe(before.toISOString());
    await restarted.observe("default", { tabs: [], panes: [] });
    const entries = JSON.parse(await readFile(location, "utf8")).entries;
    expect(Object.keys(entries)).toHaveLength(1);
    expect((await observe(restarted, snapshot(), "work")).get(key)?.lastChangedAt).toBe(before.toISOString());
    expect((await observe(restarted, snapshot())).get(key)?.lastChangedAt).toBe(after.toISOString());
  });
  it("handles a corrupt file and lower pane counters, ignoring pane order", async () => {
    const location = await file(); await writeFile(location, "broken");
    let now = new Date("2026-09-15T10:00:00Z");
    const store = new TabActivityStore(location, () => now), s = snapshot();
    const second = { workspace_id: "w1", tab_id: "t1", pane_id: "p2", state_change_seq: 100 };
    s.panes = [...objects(s.panes), second];
    await store.observe("default", s);
    now = new Date("2026-09-15T11:00:00Z");
    s.panes = objects(s.panes).reverse();
    expect((await observe(store, s)).get(key)?.lastChangedAt).toBe("2026-09-15T10:00:00.000Z");
    objects(s.panes).find(p => p.pane_id === "p1")!.state_change_seq = 2;
    expect((await observe(store, s)).get(key)?.lastChangedAt).toBe(now.toISOString());
  });
  it("keeps serving timestamps when persistence fails and retries unchanged data", async () => {
    const location = await file(), blocked = path.join(path.dirname(location), "blocked");
    await writeFile(blocked, "not a directory");
    const destination = path.join(blocked, "tab-activity.json");
    const now = new Date("2026-09-15T10:00:00Z"), store = new TabActivityStore(destination, () => now);
    expect((await observe(store, snapshot())).get(key)?.lastChangedAt).toBe(now.toISOString());
    await rm(blocked);
    expect((await observe(store, snapshot())).get(key)?.lastChangedAt).toBe(now.toISOString());
    expect(JSON.parse(await readFile(destination, "utf8")).entries).toHaveProperty('"default":["w1","t1"]');
  });
  it("persists only signature hashes, migrates old plaintext, and prunes absent servers", async () => {
    const location = await file(), now = new Date("2026-09-15T10:00:00Z");
    const store = new TabActivityStore(location, () => now);
    await store.observe("default", snapshot("working", 1, "PRIVATE TITLE"));
    await store.observe("gone", snapshot("waiting", 1, "PRIVATE OTHER"));
    let saved = await readFile(location, "utf8");
    expect(saved).not.toContain("PRIVATE"); expect(saved).not.toContain("Tab");
    for (const stamp of Object.values(JSON.parse(saved).entries) as { signature: string }[]) expect(stamp.signature).toMatch(/^[a-f0-9]{64}$/);
    await new TabActivityStore(location).pruneServers(["default"]);
    saved = await readFile(location, "utf8");
    expect(saved).not.toContain("gone"); expect(Object.keys(JSON.parse(saved).entries)).toHaveLength(1);
    const plain = JSON.stringify(["working", null, "Tab", null, [["p1", "codex", null, 1, "PRIVATE TITLE"]]]);
    await writeFile(location, JSON.stringify({ entries: { ['"default":' + key]: { signature: plain, lastChangedAt: now.toISOString() } } }));
    const restarted = new TabActivityStore(location, () => new Date(now.getTime() + 1000));
    expect((await observe(restarted, snapshot("working", 1, "PRIVATE TITLE"))).get(key)?.lastChangedAt).toBe(now.toISOString());
    expect(await readFile(location, "utf8")).not.toContain("PRIVATE");
  });

});

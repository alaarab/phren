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
function snapshot(status = "working", seq = 1, title = "Build"): Json {
  return { workspaces: [{ workspace_id: "w1", label: "Project" }],
    tabs: [{ workspace_id: "w1", tab_id: "t1", label: "Tab", agent_status: status }],
    panes: [{ workspace_id: "w1", tab_id: "t1", pane_id: "p1", agent: "codex", state_change_seq: seq, title }] };
}
const key = tabActivityKey("w1", "t1");

describe("persisted tab activity clock", () => {
  it("stamps changes and exports ISO dates without rewriting unchanged polls", async () => {
    const location = await file(); let now = new Date("2026-09-15T10:00:00Z");
    const store = new TabActivityStore(location, () => now);
    const first = await store.observe("default", snapshot());
    expect(first.get(key)).toBe(now.toISOString());
    expect(objects(objects(workspaceSnapshot(snapshot(), undefined, undefined, first).groups)[0].children)[0].lastChangedAt).toBe(now.toISOString());
    const modified = (await stat(location)).mtimeMs;
    now = new Date("2026-09-15T10:01:00Z");
    expect((await store.observe("default", snapshot())).get(key)).toBe(first.get(key));
    expect((await stat(location)).mtimeMs).toBe(modified);
    for (const changed of [snapshot("waiting"), snapshot("waiting", 2), snapshot("waiting", 2, "Review")]) {
      now = new Date(now.getTime() + 1000);
      expect((await store.observe("default", changed)).get(key)).toBe(now.toISOString());
    }
  });
  it("restores times across restarts and prunes only the observed server", async () => {
    const location = await file(), before = new Date("2026-09-15T10:00:00Z"), after = new Date("2026-09-15T11:00:00Z");
    const store = new TabActivityStore(location, () => before);
    await Promise.all([store.observe("default", snapshot()), store.observe("work", snapshot())]);
    const restarted = new TabActivityStore(location, () => after);
    expect((await restarted.observe("default", snapshot())).get(key)).toBe(before.toISOString());
    await restarted.observe("default", { tabs: [], panes: [] });
    const entries = JSON.parse(await readFile(location, "utf8")).entries;
    expect(Object.keys(entries)).toHaveLength(1);
    expect((await restarted.observe("work", snapshot())).get(key)).toBe(before.toISOString());
    expect((await restarted.observe("default", snapshot())).get(key)).toBe(after.toISOString());
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
    expect((await store.observe("default", s)).get(key)).toBe("2026-09-15T10:00:00.000Z");
    objects(s.panes).find(p => p.pane_id === "p1")!.state_change_seq = 2;
    expect((await store.observe("default", s)).get(key)).toBe(now.toISOString());
  });
  it("keeps serving timestamps when persistence fails and retries unchanged data", async () => {
    const location = await file(), blocked = path.join(path.dirname(location), "blocked");
    await writeFile(blocked, "not a directory");
    const destination = path.join(blocked, "tab-activity.json");
    const now = new Date("2026-09-15T10:00:00Z"), store = new TabActivityStore(destination, () => now);
    expect((await store.observe("default", snapshot())).get(key)).toBe(now.toISOString());
    await rm(blocked);
    expect((await store.observe("default", snapshot())).get(key)).toBe(now.toISOString());
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
    expect((await restarted.observe("default", snapshot("working", 1, "PRIVATE TITLE"))).get(key)).toBe(now.toISOString());
    expect(await readFile(location, "utf8")).not.toContain("PRIVATE");
  });

});

import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OwnerInbox, type InboxItem, type InboxSource } from "./owner-inbox.js";
import { ownerInboxView } from "./owner-inbox-view.js";
import { hookPeers, peerRequest } from "./peers.js";
vi.mock("./peers.js", () => ({ hookPeers: vi.fn(), peerRequest: vi.fn() }));
let root: string, sources: InboxSource[];
const inbox = () => new OwnerInbox(async () => sources, path.join(root, "owner-inbox.json"));
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-inbox-")); sources = []; vi.mocked(hookPeers).mockResolvedValue([]); });
afterEach(async () => { vi.resetAllMocks(); await rm(root, { recursive: true, force: true }); });
describe("owner inbox", () => {
  it("adds, lists and resolves durably with idempotent adds and history", async () => {
    const box = inbox(), id = "11111111-1111-4111-8111-111111111111";
    const add = { action: "add", id, title: "Restart the router", project: "phren" };
    await Promise.all([box.run(add), box.run(add)]); expect((await box.run({})).items).toHaveLength(1);
    await expect(box.run({ ...add, title: "Other" })).rejects.toThrow("another item");
    await box.run({ action: "resolve", id, resolution: "Router restarted" });
    expect((await inbox().run({})).items).toEqual([]);
    expect((await inbox().run({ includeResolved: true })).items).toMatchObject([{ state: "resolved", resolution: "Router restarted" }]);
  });
  it("retires automatic waits when answered and preserves manual decisions and history", async () => {
    const box = inbox();
    await box.run({ action: "add", title: "Choose the release window" });
    sources = [{ source: "question:1", kind: "needs-you", title: "Choose a target" },
      { source: "approval:1", kind: "blocked", title: "Approve the tool", actionId: "ask1" }];
    expect((await box.run({})).items).toHaveLength(3);
    sources = [];
    await box.tick();
    expect((await box.run({})).items).toMatchObject([{ kind: "manual", title: "Choose the release window" }]);
    expect((await box.run({ includeResolved: true })).items).toMatchObject([
      { kind: "manual", state: "open" },
      { state: "resolved", live: false, resolution: "stale: source gone" },
      { state: "resolved", live: false, resolution: "stale: source gone" },
    ]);
  });
  it("updates one item despite changing prompt timestamps and countdowns; separates questions and sessions", async () => {
    const target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "codex" as const, session: "11111111-1111-4111-8111-111111111111" };
    sources = [{ source: "prompt:old-timestamp", target, kind: "blocked", title: "Auto-resolves in 3s" }];
    const first = (await inbox().run({})).items as InboxItem[];
    sources = [{ ...sources[0], source: "prompt:new-timestamp", title: "Auto-resolves in 2s" }];
    expect((await inbox().run({})).items).toMatchObject([{ id: first[0].id, title: "Auto-resolves in 2s" }]);
    expect((await inbox().run({})).items).toHaveLength(1);
    sources = ["q1", "q2"].map(actionId => ({ ...sources[0], actionId }));
    expect((await inbox().run({})).items).toHaveLength(2);
    sources = [{ ...sources[0], target: { ...target, session: "22222222-2222-4222-8222-222222222222" } }];
    expect((await inbox().run({})).items).toMatchObject([{ target: { session: "22222222-2222-4222-8222-222222222222" } }]);
    expect((await inbox().run({})).items).toHaveLength(1);
  });
  it("keeps an owner dismissal through repeated polls, but allows a new wait after the source disappears", async () => {
    sources = [{ source: "prompt:1", kind: "blocked", title: "Approve the tool" }];
    const box = inbox(), [first] = (await box.run({})).items as InboxItem[];
    await box.run({ action: "resolve", id: first.id, resolution: "stale: dismissed by owner" });
    expect((await inbox().run({})).items).toEqual([]);
    sources = []; await inbox().tick();
    sources = [{ source: "prompt:1", kind: "blocked", title: "Next tool" }];
    const [next] = (await inbox().run({})).items as InboxItem[];
    expect(next.id).not.toBe(first.id);
    sources = []; await inbox().tick();
    sources = [{ source: "prompt:1", kind: "blocked", title: "Another wait" }];
    expect((await inbox().run({})).items).toHaveLength(1);
  });
  it("migrates legacy stale and duplicate rows once without touching manual items", async () => {
    const at = "2026-10-06T10:00:00.000Z", target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "codex", session: "11111111-1111-4111-8111-111111111111" };
    const row = { kind: "blocked", title: "codex needs terminal input.", state: "open", createdAt: at, updatedAt: at };
    const manual = { ...row, id: randomUUID(), kind: "manual", title: "Owner decision" };
    await writeFile(path.join(root, "owner-inbox.json"), JSON.stringify([
      manual, { ...row, id: randomUUID(), source: "gone", live: true },
      { ...row, id: randomUUID(), source: "ended", live: false },
      { ...row, id: randomUUID(), source: "old1", target, live: true },
      { ...row, id: randomUUID(), source: "old2", target, live: true },
    ]));
    sources = [{ source: "new", target: target as InboxSource["target"], kind: "blocked", title: "Still waiting" }];
    expect((await inbox().run({})).items).toHaveLength(2);
    const migrated = await readFile(path.join(root, "owner-inbox.json"), "utf8");
    const rows = JSON.parse(migrated) as InboxItem[];
    expect(rows[0]).toEqual(manual);
    expect(rows.slice(1, 3)).toMatchObject([{ state: "resolved", resolution: "stale: source gone", live: false }, { state: "resolved", resolution: "stale: source gone", live: false }]);
    expect(rows[4]).toMatchObject({ state: "resolved", resolution: "duplicate: source" });
    await inbox().tick();
    expect(await readFile(path.join(root, "owner-inbox.json"), "utf8")).toBe(migrated);
  });
  it("hides an unverified remote wait without resolving it during an outage", async () => {
    const dispatch = randomUUID();
    sources = [{ source: "remote", dispatch, computer: "Desk", kind: "needs-you", title: "Choose a target" }];
    await inbox().tick();
    const offline = new OwnerInbox(async () => ({ sources: [], unavailableDispatches: [dispatch] }), path.join(root, "owner-inbox.json"));
    expect((await offline.run({})).items).toEqual([]);
    expect((await offline.run({ includeResolved: true })).items).toMatchObject([{ state: "open", live: false }]);
    expect((await inbox().run({})).items).toMatchObject([{ state: "open", live: true }]);
  });
  it("preserves every resolve from eight concurrent processes", async () => {
    const ids = Array.from({ length: 24 }, () => randomUUID());
    for (const id of ids) await inbox().run({ action: "add", id, title: `Decision ${id}` });
    const script = path.join(root, "writer.mjs");
    await writeFile(script, `import { OwnerInbox } from ${JSON.stringify(new URL("./owner-inbox.ts", import.meta.url).href)};
      process.send('ready');
      process.once('message', async ({ file, ids }) => {
        try {
          const box = new OwnerInbox(async () => { await new Promise(r => setTimeout(r, 40)); return []; }, file);
          for (const id of ids) await box.run({ action: 'resolve', id, resolution: 'owner answered' });
          process.disconnect();
        } catch (e) { console.error(e); process.exit(1); }
      });`);
    const children = Array.from({ length: 8 }, () => fork(script, { execArgv: ["--import", import.meta.resolve("tsx")], stdio: ["ignore", "ignore", "pipe", "ipc"] }));
    const finished = children.map(child => new Promise<void>((resolve, reject) => {
      let stderr = ""; child.stderr!.on("data", chunk => { stderr += chunk; });
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolve() : reject(new Error(stderr || `writer exited ${code}`)));
    }));
    try {
      await Promise.all(children.map(child => new Promise(resolve => child.once("message", resolve))));
      children.forEach((child, index) => child.send({ file: path.join(root, "owner-inbox.json"), ids: ids.slice(index * 3, index * 3 + 3) }));
      await Promise.all(finished);
    } finally { children.forEach(child => child.kill()); }
    expect((await inbox().run({})).items).toEqual([]);
    const rows = (await inbox().run({ includeResolved: true })).items as InboxItem[];
    expect(rows).toHaveLength(24);
    expect(rows.every(row => row.state === "resolved" && row.resolution === "owner answered")).toBe(true);
  }, 30_000);
  it("filters legacy stale peer rows and merges a forwarded approval with its worker inbox", async () => {
    const target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "codex" as const, session: "11111111-1111-4111-8111-111111111111" };
    sources = [{ source: "dispatch:1", kind: "blocked", title: "Approve test run", computer: "Desk", target, actionId: "q1" }];
    vi.mocked(hookPeers).mockResolvedValue([{ name: "Desk" }] as never);
    vi.mocked(peerRequest).mockResolvedValue({ items: [
      { id: "stale", kind: "blocked", state: "open", live: false },
      { id: "manual", kind: "manual", state: "open", title: "Owner decision" },
      { id: "duplicate", kind: "blocked", state: "open", live: true, target, actionId: "q1" },
    ] });
    expect((await ownerInboxView(inbox(), {})).items).toMatchObject([
      { title: "Approve test run", inboxComputer: "local" }, { id: "manual", inboxComputer: "Desk" },
    ]);
    expect((await ownerInboxView(inbox(), { includeResolved: true })).items).toHaveLength(4);
  });
  it("lists peer inboxes without recursion, reports unreachable peers and routes resolution to the owning Hook", async () => {
    vi.mocked(hookPeers).mockResolvedValue([{ name: "Desk" }, { name: "Offline" }] as never);
    vi.mocked(peerRequest).mockImplementation(async (peer, route, body) => {
      if (peer.name === "Offline") throw Error("offline");
      return body ? { ok: true, item: { id: "remote-id", state: "resolved" } } : { items: [{ id: "remote-id", kind: "manual", title: "Remote question" }] };
    });
    const view = await ownerInboxView(inbox(), { action: "list" });
    expect(view.items).toMatchObject([{ inboxComputer: "Desk" }]); expect(view.unreachable).toMatchObject([{ computer: "Offline" }]);
    expect(peerRequest).toHaveBeenCalledWith(expect.objectContaining({ name: "Desk" }), "/v1/owner-inbox?local=1");
    await ownerInboxView(inbox(), { action: "resolve", computer: "Desk", id: "11111111-1111-4111-8111-111111111111" });
    expect(peerRequest).toHaveBeenLastCalledWith(expect.objectContaining({ name: "Desk" }), "/v1/owner-inbox", expect.objectContaining({ action: "resolve" }));
  });
});

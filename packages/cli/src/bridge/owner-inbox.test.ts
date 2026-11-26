import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OwnerInbox, pasteCommand, type InboxItem, type InboxSource } from "./owner-inbox.js";
import { ownerInboxView } from "./owner-inbox-view.js";
import { hookPeers, peerRequest } from "./peers.js";
vi.mock("./peers.js", () => ({ hookPeers: vi.fn(), peerRequest: vi.fn() }));
const linked = (name: string) => ({ name, address: `${name.toLowerCase()}.example`, username: "sam", port: 22 });
let root: string, sources: InboxSource[];
const inbox = () => new OwnerInbox(async () => sources, path.join(root, "owner-inbox.json"));
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-inbox-")); sources = []; vi.mocked(hookPeers).mockResolvedValue([]); });
afterEach(async () => { vi.resetAllMocks(); await rm(root, { recursive: true, force: true }); });
describe("owner inbox", () => {
  it("adds, lists and resolves durably with idempotent adds and history", async () => {
    const box = inbox(), id = "11111111-1111-4111-8111-111111111111";
    const add = { action: "add", id, title: "Restart the router", project: "phren" };
    await Promise.all([box.run(add), box.run(add)]); expect((await box.run({})).items).toHaveLength(1);
    const updated = await box.run({ ...add, title: "Other" });
    expect(updated.updated).toBe(true);
    expect((await inbox().run({})).items).toMatchObject([{ id, title: "Other", project: "phren" }]);
    await box.run({ action: "resolve", id, resolution: "Router restarted" });
    expect((await inbox().run({})).items).toEqual([]);
    expect((await inbox().run({ includeResolved: true })).items).toMatchObject([{ state: "resolved", resolution: "Router restarted" }]);
  });
  it("validates the command, task, pr and key fields of a manual add", async () => {
    const box = inbox();
    const added = await box.run({ action: "add", title: "Merge the release", command: "gh pr merge 877 --squash\necho\tmerged", task: "bid:c2cc33d0", pr: "https://github.com/alaarab/phren/pull/877/" });
    expect(added.item).toMatchObject({ command: "gh pr merge 877 --squash\necho\tmerged", task: "bid:c2cc33d0", pr: "https://github.com/alaarab/phren/pull/877" });
    expect(added.item).toHaveProperty("paste", `gh pr merge 877 --squash\necho\tmerged\nphren owner-inbox resolve ${(added.item as InboxItem).id} --resolution done`);
    for (const bad of [
      { task: "bid:zzzzzzzz" }, { task: "c2cc33d0" }, { pr: "https://github.com/o/r/issues/5" }, { pr: "http://github.com/o/r/pull/1" },
      { pr: "https://github.com/o/r/pull/not-a-number" }, { command: "echo hi\r\necho bye" }, { command: "echo \x07bell" },
      { command: "echo\x00" }, { command: "" }, { command: Array.from({ length: 21 }, (_, i) => `line ${i + 1}`).join("\n") }, { key: "has space" },
    ]) await expect(box.run({ action: "add", title: "Bad add", ...bad })).rejects.toThrow(z.ZodError);
    const twenty = await box.run({ action: "add", title: "Twenty lines is fine", command: Array.from({ length: 20 }, (_, i) => `step ${i + 1}\t`).join("\n") });
    expect((twenty.item as InboxItem).command).toContain("step 20");
  });
  it("upserts by explicit key, by the default pr key and by id; an unchanged re-add writes nothing", async () => {
    const box = inbox(), file = path.join(root, "owner-inbox.json");
    const first = (await box.run({ action: "add", title: "Renew the certificate", command: "certbot renew", key: "certs:weekly" })).item as InboxItem;
    const updated = await box.run({ action: "add", title: "Renew the certificate again", command: "certbot renew --quiet", key: "certs:weekly" });
    expect(updated.updated).toBe(true);
    expect(updated.item).toMatchObject({ id: first.id, title: "Renew the certificate again", command: "certbot renew --quiet" });
    const pr = "https://github.com/alaarab/phren/pull/877";
    const prFirst = (await box.run({ action: "add", title: "Merge the release", pr })).item as InboxItem;
    const prAgain = await box.run({ action: "add", title: "Merge the release now", pr: `${pr}/` });
    expect(prAgain.updated).toBe(true);
    expect(prAgain.item).toMatchObject({ id: prFirst.id, title: "Merge the release now", pr });
    expect((await box.run({})).items).toHaveLength(2);
    const before = await readFile(file, "utf8");
    const unchanged = await box.run({ action: "add", title: "Merge the release now", pr });
    expect(unchanged.updated).toBeUndefined();
    expect(await readFile(file, "utf8")).toBe(before);
    await box.run({ action: "resolve", id: first.id, resolution: "done" });
    const fresh = await box.run({ action: "add", title: "Renew the certificate", command: "certbot renew", key: "certs:weekly" });
    expect(fresh.updated).toBeUndefined();
    expect((fresh.item as InboxItem).id).not.toBe(first.id);
  });
  it("reopens a resolved manual item when its explicit id brings changed fields; an identical retry stays resolved", async () => {
    const box = inbox(), id = "22222222-2222-4222-8222-222222222222";
    const add = { action: "add", id, title: "Renew the token", command: "phren secret login", project: "hub" };
    await box.run(add);
    await box.run({ action: "resolve", id, resolution: "done: token renewed" });
    const retry = await box.run(add);
    expect(retry.reopened).toBeUndefined();
    expect(retry.item).toMatchObject({ id, state: "resolved", title: "Renew the token", resolution: "done: token renewed" });
    const reopened = await box.run({ ...add, title: "Renew the newer token" });
    expect(reopened.reopened).toBe(true);
    expect(reopened.item).toMatchObject({ id, state: "open", title: "Renew the newer token", command: "phren secret login" });
    expect((reopened.item as InboxItem).resolvedAt).toBeUndefined();
    expect((reopened.item as InboxItem).resolution).toBeUndefined();
    expect((await inbox().run({})).items).toMatchObject([{ id, state: "open" }]);
  });
  it("still refuses an explicit id that names an automatic row", async () => {
    sources = [{ source: "prompt:1", kind: "blocked", title: "Approve the tool" }];
    const [auto] = (await inbox().run({})).items as InboxItem[];
    await expect(inbox().run({ action: "add", id: auto.id, title: "Approve it all" })).rejects.toThrow("another item");
  });
  it("computes paste commands for one line and for several, with and without a computer", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(pasteCommand({ id, command: "gh pr merge 877" })).toBe(`gh pr merge 877 && phren owner-inbox resolve ${id} --resolution done`);
    expect(pasteCommand({ id, command: "cd ~phren\npnpm test" })).toBe(`cd ~phren\npnpm test\nphren owner-inbox resolve ${id} --resolution done`);
    expect(pasteCommand({ id, command: "gh pr merge 877" }, "Desk")).toBe(`gh pr merge 877 && phren owner-inbox resolve ${id} --resolution done --computer Desk`);
    expect(pasteCommand({ id, command: "cd ~phren\npnpm test" }, "local")).toBe(`cd ~phren\npnpm test\nphren owner-inbox resolve ${id} --resolution done`);
  });
  it("auto-resolves the manual items the done probe reports, and only those", async () => {
    const done = vi.fn(async (items: InboxItem[]) => new Map<string, string>(items.filter(item => item.title === "A").map(item => [item.id, "done: PR merged"])));
    const box = new OwnerInbox(async () => sources, path.join(root, "owner-inbox.json"), done);
    const a = (await box.run({ action: "add", title: "A" })).item as InboxItem;
    const b = (await box.run({ action: "add", title: "B" })).item as InboxItem;
    await box.tick();
    expect(done.mock.calls[0][0].map(item => item.id)).toEqual([a.id, b.id]);
    expect((await box.run({})).items).toMatchObject([{ id: b.id, state: "open" }]);
    expect((await box.run({ includeResolved: true })).items).toMatchObject([
      { id: a.id, state: "resolved", resolution: "done: PR merged" }, { id: b.id, state: "open" }]);
    done.mockClear();
    await box.run({ action: "add", title: "C" });
    await box.run({ action: "resolve", id: b.id, resolution: "owner answered" });
    expect(done).not.toHaveBeenCalled();
  });
  it("leaves manual items untouched when the done probe fails", async () => {
    const failing = new OwnerInbox(async () => sources, path.join(root, "failing.json"), async () => { throw new Error("forge down"); });
    await failing.run({ action: "add", title: "Merge the release" });
    await failing.tick();
    const rows = (await failing.run({ includeResolved: true })).items as InboxItem[];
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("open");
    expect(rows[0].resolvedAt).toBeUndefined();
    expect(rows[0].resolution).toBeUndefined();
  });
  it("recomputes paste per inbox computer, overwriting a peer's", async () => {
    vi.mocked(hookPeers).mockResolvedValue([linked("Desk")] as never);
    const id = "33333333-3333-4333-8333-333333333333";
    vi.mocked(peerRequest).mockResolvedValue({ items: [
      { id, kind: "manual", state: "open", title: "Remote merge", command: "gh pr merge 9", paste: "stale from the peer" },
    ] });
    const box = inbox();
    const local = (await box.run({ action: "add", title: "Log in to the forge", command: "gh auth login" })).item as InboxItem;
    const view = await ownerInboxView(box, {});
    expect(view.items).toMatchObject([
      { title: "Log in to the forge", inboxComputer: "local", paste: `gh auth login && phren owner-inbox resolve ${local.id} --resolution done` },
      { id, inboxComputer: "Desk", paste: `gh pr merge 9 && phren owner-inbox resolve ${id} --resolution done --computer Desk` },
    ]);
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
    vi.mocked(hookPeers).mockResolvedValue([linked("Desk")] as never);
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
    vi.mocked(hookPeers).mockResolvedValue([linked("Desk"), linked("Offline")] as never);
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

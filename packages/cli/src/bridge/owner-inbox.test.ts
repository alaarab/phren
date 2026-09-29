import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OwnerInbox, type InboxSource } from "./owner-inbox.js";
import { ownerInboxView } from "./owner-inbox-view.js";
import { dispatchStatus } from "./dispatch.js";
import { hookPeers, peerRequest } from "./peers.js";
vi.mock("./dispatch.js", () => ({ dispatchStatus: vi.fn() }));
vi.mock("./peers.js", () => ({ hookPeers: vi.fn(), peerRequest: vi.fn() }));
let root: string, sources: InboxSource[];
const inbox = () => new OwnerInbox(async () => sources, path.join(root, "owner-inbox.json"));
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-inbox-")); sources = []; vi.mocked(dispatchStatus).mockResolvedValue([]); vi.mocked(hookPeers).mockResolvedValue([]); });
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
  it("combines needs-you returns and blocked prompts without dismissing on a read", async () => {
    const id = "22222222-2222-4222-8222-222222222222", at = new Date().toISOString();
    vi.mocked(dispatchStatus).mockResolvedValue([{ id, project: "phren", computer: "Desk", returned: { state: "needs-you", at, read: true, question: "Choose the release window?" } }] as never);
    sources = [{ source: "prompt:1", kind: "blocked", title: "Approve the tool", actionId: "ask1" }];
    const first = (await inbox().run({})).items as Array<{ id: string; kind: string }>;
    expect(first.map(i => i.kind)).toEqual(["needs-you", "blocked"]);
    const box = inbox(); await box.run({ action: "resolve", id: first[1].id });
    expect((await box.run({})).items).toHaveLength(1);
    sources = [{ source: "prompt:2", kind: "blocked", title: "Approve another tool", actionId: "ask2" }];
    expect((await box.run({})).items).toHaveLength(2);
    vi.mocked(dispatchStatus).mockResolvedValue([]); sources = [];
    expect((await box.run({})).items).toMatchObject([{ live: false }, { live: false }]);
  });
  it("lists peer inboxes without recursion, reports unreachable peers and routes resolution to the owning Hook", async () => {
    vi.mocked(hookPeers).mockResolvedValue([{ name: "Desk" }, { name: "Offline" }] as never);
    vi.mocked(peerRequest).mockImplementation(async (peer, route, body) => {
      if (peer.name === "Offline") throw Error("offline");
      return body ? { ok: true, item: { id: "remote-id", state: "resolved" } } : { items: [{ id: "remote-id", title: "Remote question" }] };
    });
    const view = await ownerInboxView(inbox(), { action: "list" });
    expect(view.items).toMatchObject([{ inboxComputer: "Desk" }]); expect(view.unreachable).toMatchObject([{ computer: "Offline" }]);
    expect(peerRequest).toHaveBeenCalledWith(expect.objectContaining({ name: "Desk" }), "/v1/owner-inbox?local=1");
    await ownerInboxView(inbox(), { action: "resolve", computer: "Desk", id: "11111111-1111-4111-8111-111111111111" });
    expect(peerRequest).toHaveBeenLastCalledWith(expect.objectContaining({ name: "Desk" }), "/v1/owner-inbox", expect.objectContaining({ action: "resolve" }));
  });
});

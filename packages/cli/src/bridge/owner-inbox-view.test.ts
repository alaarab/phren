import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Json } from "./protocol.js";
import type { OwnerInbox } from "./owner-inbox.js";

const state = vi.hoisted(() => ({
  peers: [] as { name: string }[],
  reads: [] as { peer: string; route: string }[],
  answers: new Map<string, Json>(),
  failures: new Set<string>(),
}));

vi.mock("./peers.js", () => ({ hookPeers: async () => state.peers, peerRequest: vi.fn() }));
vi.mock("./peer-reads.js", () => ({
  peerRead: async (peer: { name: string }, route: string) => {
    state.reads.push({ peer: peer.name, route });
    const key = `${peer.name}\n${route}`;
    if (state.failures.has(peer.name)) throw new Error(`${peer.name} is unreachable.`);
    return state.answers.get(key) ?? { ok: true, items: [] };
  },
}));
vi.mock("./dispatch-hosts.js", () => ({ isLocalComputer: (name: string) => name.toLowerCase() === "local" }));

const { ownerInboxView, compactInboxItem } = await import("./owner-inbox-view.js");

const AT = "2026-11-27T10:00:00.000Z";
const target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "claude", session: "11111111-1111-4111-8111-111111111111" };
const id = "aaaaaaaa-1111-4111-8111-111111111111";
/** A full stored row: everything a Hook keeps, most of which the phone never needs. */
const fullRow = (overrides: Json = {}): Json => ({
  id, kind: "manual", title: "OVH US VPS-2 is in stock", state: "open", createdAt: AT, updatedAt: AT,
  project: "phren", command: "ssh ovh", task: "bid:1234abcd", pr: "https://github.com/a/b/pull/1", key: "ovh",
  source: "task-stale:phren:bid:1234abcd", live: true, dispatch: "22222222-2222-4222-8222-222222222222",
  actionId: "question-1", inboxComputer: "elsewhere", ...overrides,
});
const COMPACT = ["id", "title", "kind", "state", "createdAt", "updatedAt", "inboxComputer", "project", "computer", "target"];
const inbox = (items: Json[]) => ({ run: vi.fn(async () => ({ ok: true, items })) }) as unknown as OwnerInbox;

beforeEach(() => {
  state.peers = [{ name: "Desk" }, { name: "Studio" }];
  state.reads = [];
  state.answers.clear();
  state.failures.clear();
});

describe("owner inbox compact reads", () => {
  it("forwards compact=1 to peers and projects every row again at the boundary", async () => {
    const local = fullRow({ id, kind: "manual" });
    const automatic = fullRow({ id: "bbbbbbbb-2222-4222-8222-222222222222", kind: "needs-you", live: true, target });
    // A peer that ignored compact=1 answers in full, as an older Hook does.
    state.answers.set("Desk\n/v1/owner-inbox?local=1&compact=1", { ok: true, items: [fullRow({ id: "cccccccc-3333-4333-8333-333333333333", target })] });
    const view = await ownerInboxView(inbox([local, automatic]), { action: "list" }, false, true);

    expect(view.unreachable).toEqual([]);
    const items = view.items as Json[];
    expect(items).toHaveLength(3);
    for (const item of items) expect(Object.keys(item).every(key => COMPACT.includes(key))).toBe(true);
    expect(items.map(item => item.inboxComputer)).toEqual(["local", "local", "Desk"]);
    expect(items[0]).toMatchObject({ id, title: "OVH US VPS-2 is in stock", kind: "manual", state: "open", project: "phren" });
    expect(items[1].target).toEqual(target);
    // Nothing the phone cannot use: no command, paste, dispatch link or bookkeeping.
    for (const key of ["command", "paste", "task", "pr", "key", "source", "live", "dispatch", "actionId", "resolvedAt", "resolution"]) {
      expect(items.some(item => key in item)).toBe(false);
    }
    // Every peer read asked for the compact form.
    expect(state.reads.map(read => read.route)).toEqual(expect.arrayContaining(["/v1/owner-inbox?local=1&compact=1"]));
    expect(state.reads.every(read => read.route.includes("compact=1"))).toBe(true);
  });

  it("keeps the full legacy shape and asks peers for it when compact is absent", async () => {
    state.answers.set("Desk\n/v1/owner-inbox?local=1", { ok: true, items: [fullRow({ target })] });
    const view = await ownerInboxView(inbox([fullRow()]), { action: "list" });
    const items = view.items as Json[];
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ command: "ssh ovh", source: "task-stale:phren:bid:1234abcd", live: true, dispatch: "22222222-2222-4222-8222-222222222222" });
    expect(items[0].paste).toContain("phren owner-inbox resolve");
    expect(state.reads.every(read => !read.route.includes("compact"))).toBe(true);
  });

  it("suppresses duplicate live rows and keeps unreachable peers as compact reads do", async () => {
    state.peers = [{ name: "Desk" }, { name: "Studio" }, { name: "Loft" }];
    const duplicate = fullRow({ id: "dddddddd-4444-4444-8444-444444444444", kind: "blocked", target, computer: "Worker" });
    state.answers.set("Desk\n/v1/owner-inbox?local=1&compact=1", { ok: true, items: [duplicate] });
    state.answers.set("Loft\n/v1/owner-inbox?local=1&compact=1", { ok: true, items: [duplicate] });
    state.failures.add("Studio");
    const view = await ownerInboxView(inbox([]), { action: "list" }, false, true);
    expect((view.items as Json[]).map(item => item.inboxComputer)).toEqual(["Desk"]);
    expect(view.unreachable).toEqual([{ computer: "Studio", error: "Studio is unreachable." }]);
  });

  it("compacts a local-only read without asking any peer", async () => {
    const view = await ownerInboxView(inbox([fullRow({ target, inboxComputer: undefined })]), { action: "list" }, true, true);
    expect(state.reads).toEqual([]);
    expect(Object.keys(view)).toEqual(["ok", "items"]);
    expect((view.items as Json[])[0]).toEqual(compactInboxItem(fullRow({ target, inboxComputer: undefined })));
    expect(view.items).toEqual([{ id, title: "OVH US VPS-2 is in stock", kind: "manual", state: "open", createdAt: AT, updatedAt: AT, project: "phren", target }]);
  });

  it("compacts a single named peer read too", async () => {
    state.answers.set("Desk\n/v1/owner-inbox?local=1&compact=1", { ok: true, items: [fullRow()] });
    const view = await ownerInboxView(inbox([]), { action: "list", computer: "Desk" }, false, true);
    expect(view.items).toEqual([compactInboxItem(fullRow({ inboxComputer: "Desk" }))]);
    expect(view.unreachable).toEqual([]);
  });
});

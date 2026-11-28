import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Json } from "./protocol.js";
import type { OwnerInbox } from "./owner-inbox.js";

const state = vi.hoisted(() => ({
  peers: [] as { name: string }[],
  reads: [] as { peer: string; route: string; timeout?: number }[],
  answers: new Map<string, Json>(),
  failures: new Map<string, string>(),
}));

vi.mock("./peers.js", () => ({ hookPeers: async () => state.peers, peerRequest: vi.fn() }));
vi.mock("./peer-reads.js", () => ({
  peerRead: async (peer: { name: string }, route: string, options?: { timeout?: number }) => {
    state.reads.push({ peer: peer.name, route, timeout: options?.timeout });
    const failure = state.failures.get(peer.name);
    if (failure) throw new Error(failure);
    return state.answers.get(`${peer.name}\n${route}`) ?? { ok: true, items: [] };
  },
}));
vi.mock("./dispatch-hosts.js", () => ({ isLocalComputer: (name: string) => name.toLowerCase() === "local" }));

const { ownerInboxView, compactInboxItem, COMPACT_PEER_TIMEOUT_MS } = await import("./owner-inbox-view.js");

const AT = "2026-11-27T10:00:00.000Z";
const target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "claude", session: "11111111-1111-4111-8111-111111111111" };
const id = "aaaaaaaa-1111-4111-8111-111111111111";
const NEW = "bbbbbbbb-2222-4222-8222-222222222222";
const ASK = "cccccccc-3333-4333-8333-333333333333";
const STALE = "dddddddd-4444-4444-8444-444444444444";
/** A full stored row: everything a Hook keeps, most of which the phone never needs. */
const fullRow = (overrides: Json = {}): Json => ({
  id, kind: "manual", title: "OVH US VPS-2 is in stock", state: "open", createdAt: AT, updatedAt: AT,
  project: "phren", command: "ssh ovh", pr: "https://github.com/a/b/pull/1", key: "ovh",
  source: "housekeeping:free-disk", live: true, dispatch: "22222222-2222-4222-8222-222222222222",
  actionId: "question-1", inboxComputer: "elsewhere", ...overrides,
});
/** What the phone may see. */
const COMPACT = ["id", "title", "kind", "state", "createdAt", "updatedAt", "inboxComputer", "project", "computer", "target"];
/** The keys a peer read keeps for aggregation only. */
const RECONCILE = ["live", "source", "actionId"];
const inbox = (items: Json[]) => ({ run: vi.fn(async () => ({ ok: true, items })) }) as unknown as OwnerInbox;
/** An upgraded peer's real compact local answer, produced by this same code. */
const upgradedPeer = async (rows: Json[]) => ownerInboxView(inbox(rows), { action: "list" }, true, true, true);
const peerURL = (extra = "") => `/v1/owner-inbox?local=1&compact=1${extra}`;

beforeEach(() => {
  state.peers = [{ name: "Desk" }, { name: "Studio" }];
  state.reads = [];
  state.answers.clear();
  state.failures.clear();
});

describe("owner inbox compact reads", () => {
  it("keeps a live row from an upgraded peer's compact answer and dedupes it against a legacy peer", async () => {
    // The upgraded peer (this build) filters its own rows and answers compact.
    const forwarded = fullRow({ id: ASK, kind: "needs-you", title: "Approve the deploy?", actionId: "approval-7", target, computer: "Worker" });
    const stale = fullRow({ id: STALE, kind: "blocked", title: "Review disk usage", source: "housekeeping:free-disk", actionId: undefined, target: undefined });
    const desk = await upgradedPeer([forwarded, stale]);
    expect(desk.items).toEqual([expect.objectContaining({ actionId: "approval-7", live: true }), expect.objectContaining({ source: "housekeeping:free-disk", live: true })]);
    state.answers.set(`Desk\n${peerURL("&reconcile=1")}`, desk);
    // A legacy peer ignores both flags and answers in full, describing the same approval and the other computer’s housekeeping item.
    state.answers.set(`Studio\n${peerURL("&reconcile=1")}`, {
      ok: true, items: [fullRow({ id: NEW, kind: "blocked", title: "Only on Studio", source: "pane:Studio", actionId: undefined, target: { ...target, pane: "w1:p2" } }), forwarded, stale],
    });
    const view = await ownerInboxView(inbox([fullRow({ id, kind: "manual" })]), { action: "list" }, false, true);

    const items = view.items as Json[];
    expect(view.unreachable).toEqual([]);
    // The upgraded peer's blocked row would have vanished while its peer looked reachable.
    expect(items.some(item => item.title === "Review disk usage")).toBe(true);
    expect(items.find(item => item.title === "Review disk usage")).toMatchObject({ id: STALE, kind: "blocked" });
    // The forwarded approval is described by both Hooks once.
    expect(items.filter(item => item.title === "Approve the deploy?")).toHaveLength(1);
    expect(items.some(item => item.title === "Only on Studio")).toBe(true);
    // What crosses the peer exchange is stripped before the phone sees it.
    for (const item of items) expect(Object.keys(item).every(key => COMPACT.includes(key))).toBe(true);
    for (const key of RECONCILE) expect(items.some(item => key in item)).toBe(false);
    for (const key of ["command", "paste", "pr", "key", "dispatch", "resolvedAt", "resolution"]) expect(items.some(item => key in item)).toBe(false);
    // Every peer read asked for the compact form, the aggregation keys, and the phone's six-second deadline.
    expect(state.reads.every(read => read.route.includes("compact=1") && read.route.includes("reconcile=1"))).toBe(true);
    expect(state.reads.every(read => read.timeout === COMPACT_PEER_TIMEOUT_MS)).toBe(true);
  });

  it("keeps the full legacy shape and asks peers for it when compact is absent", async () => {
    state.answers.set("Desk\n/v1/owner-inbox?local=1", { ok: true, items: [fullRow({ target })] });
    const view = await ownerInboxView(inbox([fullRow()]), { action: "list" });
    const items = view.items as Json[];
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ command: "ssh ovh", source: "housekeeping:free-disk", live: true, dispatch: "22222222-2222-4222-8222-222222222222" });
    expect(items[0].paste).toContain("phren owner-inbox resolve");
    expect(state.reads.every(read => !read.route.includes("compact") && !read.route.includes("reconcile"))).toBe(true);
    expect(state.reads.every(read => read.timeout === undefined)).toBe(true);
  });

  it("suppresses duplicate live rows across two compact peers", async () => {
    state.peers = [{ name: "Desk" }, { name: "Loft" }];
    const duplicate = fullRow({ id: STALE, kind: "blocked", target, computer: "Worker" });
    const answer = await upgradedPeer([duplicate]);
    state.answers.set(`Desk\n${peerURL("&reconcile=1")}`, answer);
    state.answers.set(`Loft\n${peerURL("&reconcile=1")}`, answer);
    const view = await ownerInboxView(inbox([]), { action: "list" }, false, true);
    expect((view.items as Json[]).map(item => item.id)).toEqual([STALE]);
  });

  it("puts a slow compact peer in unreachable and keeps the other sections", async () => {
    state.peers = [{ name: "Desk" }, { name: "Slow" }];
    state.answers.set(`Desk\n${peerURL("&reconcile=1")}`, await upgradedPeer([fullRow({ id: NEW, kind: "blocked", source: "pane:Desk" })]));
    state.failures.set("Slow", "Slow did not answer within 6 seconds.");
    const view = await ownerInboxView(inbox([]), { action: "list" }, false, true);
    expect((view.items as Json[]).map(item => item.id)).toEqual([NEW]);
    expect(view.unreachable).toEqual([{ computer: "Slow", error: "Slow did not answer within 6 seconds." }]);
    // The deadline asked for is the one that lets the phone keep healthy sections.
    expect(state.reads.find(read => read.peer === "Slow")?.timeout).toBe(COMPACT_PEER_TIMEOUT_MS);
    expect(COMPACT_PEER_TIMEOUT_MS).toBe(6_000);
  });

  it("compacts a local-only read without asking any peer", async () => {
    const view = await ownerInboxView(inbox([fullRow({ target, inboxComputer: undefined })]), { action: "list" }, true, true);
    expect(state.reads).toEqual([]);
    expect(Object.keys(view)).toEqual(["ok", "items"]);
    expect((view.items as Json[])[0]).toEqual(compactInboxItem(fullRow({ target, inboxComputer: undefined })));
    expect(view.items).toEqual([{ id, title: "OVH US VPS-2 is in stock", kind: "manual", state: "open", createdAt: AT, updatedAt: AT, project: "phren", target }]);
  });

  it("gives a compact reader the issue link in the title unless it asks for the field", async () => {
    state.peers = [];
    // A stored row carries the link in its title and no key of its own.
    const row = fullRow({ title: "OVH US VPS-2 is in stock (issue: github.com/alaarab/phren#42)" });
    const legacy = await ownerInboxView(inbox([row]), { action: "list" }, true, true);
    expect(legacy.items).toEqual([{ ...compactInboxItem(row), title: "OVH US VPS-2 is in stock (issue: github.com/alaarab/phren#42)" }]);
    expect("issue" in (legacy.items as Json[])[0]).toBe(false);
    const asked = await ownerInboxView(inbox([row]), { action: "list", issues: true }, true, true);
    expect(asked.items).toMatchObject([{ id, title: "OVH US VPS-2 is in stock", issue: "github.com/alaarab/phren#42" }]);
    expect(compactInboxItem(row, false, true).issue).toBe("github.com/alaarab/phren#42");
  });

  it("asks peers for the structured link only when the reader does, and shapes their answers", async () => {
    state.peers = [{ name: "Desk" }];
    const stored = fullRow({ title: "OVH US VPS-2 is in stock (issue: github.com/alaarab/phren#42)" });
    state.answers.set("Desk\n/v1/owner-inbox?local=1", { ok: true, items: [stored] });
    const legacy = await ownerInboxView(inbox([]), { action: "list" });
    expect(state.reads[0].route).toBe("/v1/owner-inbox?local=1");
    expect(legacy.items).toMatchObject([{ title: "OVH US VPS-2 is in stock (issue: github.com/alaarab/phren#42)" }]);
    expect("issue" in (legacy.items as Json[])[0]).toBe(false);
    // A new peer answers with the field peeled off the title, and this Hook
    // strips it again for a reader that did not ask.
    state.answers.set("Desk\n/v1/owner-inbox?local=1&issues=1", { ok: true, items: [{ ...stored, title: "OVH US VPS-2 is in stock", issue: "github.com/alaarab/phren#42" }] });
    const asked = await ownerInboxView(inbox([]), { action: "list", issues: true });
    expect(state.reads[1].route).toBe("/v1/owner-inbox?local=1&issues=1");
    expect(asked.items).toMatchObject([{ title: "OVH US VPS-2 is in stock", issue: "github.com/alaarab/phren#42" }]);
  });

  it("keeps the aggregation keys only when the peer read asks for them", async () => {
    const row = fullRow({ kind: "blocked", target });
    const plain = await ownerInboxView(inbox([row]), { action: "list" }, true, true);
    expect(plain.items).toEqual([compactInboxItem(row)]);
    expect(RECONCILE.every(key => !(key in (plain.items as Json[])[0]))).toBe(true);
    const peer = await ownerInboxView(inbox([row]), { action: "list" }, true, true, true);
    expect(peer.items).toEqual([compactInboxItem(row, true)]);
    expect((peer.items as Json[])[0]).toMatchObject({ live: true, source: "housekeeping:free-disk", actionId: "question-1" });
  });

  it("compacts a single named peer read too", async () => {
    state.answers.set("Desk\n/v1/owner-inbox?local=1&compact=1", { ok: true, items: [fullRow()] });
    const view = await ownerInboxView(inbox([]), { action: "list", computer: "Desk" }, false, true);
    expect(view.items).toEqual([compactInboxItem(fullRow({ inboxComputer: "Desk" }))]);
    expect(view.unreachable).toEqual([]);
    // A phone's single-Hook read asks for no aggregation keys.
    expect(state.reads[0].route).not.toContain("reconcile");
  });
});

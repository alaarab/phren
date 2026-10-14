import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain ESM UI module
import { needsYou, sessions, sessionKind } from "../ui/shell/store.js";

const computer = (state: string) => ({ computer: state, state, overview: { groups: [{ children: [
  { id: "wait", agentStatus: "waiting", target: {} },
  { id: "work", agentStatus: "working", target: {} },
  { id: "approve", agentStatus: "idle", approvalPending: true, target: {} },
] }] } });

describe("live desktop attention", () => {
  it("excludes cached computers from attention and live counts while retaining last-seen rows on request", () => {
    const merged = { computers: ["online", "offline", "connecting", "verify", "missing"].map((state) => state === "missing" ? { ...computer(state), state: undefined } : computer(state)) };
    expect(needsYou(merged).map((row: { key: string }) => row.key)).toEqual(["online/wait", "online/approve"]);
    expect(sessions(merged)).toHaveLength(3);
    expect(sessions(merged, { includeOffline: true })).toHaveLength(15);
  });

  it.each([
    ["error", false, "error"], ["unknown", false, "unknown"], ["future-status", false, "unknown"],
    [undefined, false, "unknown"], ["idle", false, "idle"], ["waiting", false, "needs"],
    ["blocked", false, "needs"], ["error", true, "needs"], ["working", false, "working"], ["done", false, "done"],
  ])("keeps sidebar status %s with approval=%s as %s", (agentStatus, approvalPending, expected) => {
    expect(sessionKind({ agentStatus, approvalPending })).toBe(expected);
  });
});

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

async function notifications() {
  vi.resetModules();
  class Socket extends EventTarget {
    static opened: Socket[] = [];
    constructor(_url: string) { super(); Socket.opened.push(this); }
    message(body: unknown) { this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(body) })); }
    close() { this.dispatchEvent(new Event("close")); }
  }
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("location", { protocol: "https:", host: "desktop.test" });
  vi.stubGlobal("document", new EventTarget());
  // @ts-expect-error plain ESM UI module
  const { connectStore } = await import("../ui/shell/store.js");
  // @ts-expect-error plain ESM UI module
  const { startApprovals } = await import("../ui/shell/approvals.js");
  // @ts-expect-error plain ESM UI module
  const { startNeedsNotify } = await import("../ui/shell/needs-notify.js");
  const notify = vi.fn();
  connectStore();
  startNeedsNotify({ notify }, { enabled: () => true, openSession: vi.fn() });
  startApprovals();
  const overview = (children: unknown[]) => Socket.opened[0].message({ type: "overview", merged: {
    computers: [{ computer: "mini", state: "online", overview: { groups: [{ children }] } }],
  } });
  return { notify, overview, Socket };
}

it("notifies replacement approvals while blocked, and deduplicates plain waits by session", async () => {
  const { notify, overview, Socket } = await notifications();
  overview([]); // First frame establishes the baseline without notifying.
  const child = { id: "7", title: "Build", agentStatus: "blocked", approvalPending: true, target: { pane: "p" } };
  overview([child]);
  const status = Socket.opened[1];
  const approval = (actionId: string) => status.message({ agentStatus: { pendingApproval: { actionId } } });
  approval("A");
  expect(notify).toHaveBeenCalledTimes(1);
  approval("A");
  overview([child]);
  approval("B");
  expect(notify).toHaveBeenCalledTimes(2);
  expect(notify.mock.lastCall?.[2]).toEqual({ key: "mini/7", reply: false });
  overview([{ ...child, agentStatus: "waiting", approvalPending: false }]);
  overview([{ ...child, agentStatus: "waiting", approvalPending: false, lastReply: "Still waiting" }]);
  expect(notify).toHaveBeenCalledTimes(3);
  expect(notify.mock.lastCall?.[2]).toEqual({ key: "mini/7", reply: true });
});

it("silently baselines existing approvals until they are replaced", async () => {
  const { notify, overview, Socket } = await notifications();
  const child = { id: "7", agentStatus: "blocked", approvalPending: true, target: { pane: "p" } };
  overview([child]);
  const approval = (actionId: string) => Socket.opened[1].message({ agentStatus: { pendingApproval: { actionId } } });
  approval("existing");
  overview([child]);
  expect(notify).not.toHaveBeenCalled();
  approval("replacement");
  expect(notify).toHaveBeenCalledTimes(1);
});

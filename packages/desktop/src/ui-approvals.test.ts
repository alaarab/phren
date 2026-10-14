import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Home must never be reached while servicing the tray, including startup.
vi.mock("../ui/shell/sections.js", () => ({
  sectionHandle: () => { throw new Error("The tray mounted a section"); },
}));

class Socket extends EventTarget {
  static opened: Socket[] = [];
  closed = false;
  constructor(public url: string) { super(); Socket.opened.push(this); }
  message(body: unknown) {
    const event = new Event("message");
    Object.assign(event, { data: JSON.stringify(body) });
    this.dispatchEvent(event);
  }
  close() { this.closed = true; this.dispatchEvent(new Event("close")); }
}

const target = { server: "herdr", workspace: "w", tab: "t", pane: "p" };
const overview = (approvalPending = true, present = true) => ({
  type: "overview",
  merged: { computers: [{ computer: "mini", state: "online", overview: { groups: [{ children: present ? [{
    id: "a", title: "Fix build", agentStatus: "waiting", approvalPending, target,
  }] : [] }] } }] },
});
const approvalFrame = (approval: unknown) => ({ agentStatus: { pendingApproval: approval } });

beforeEach(() => {
  vi.resetModules();
  Socket.opened = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("location", { protocol: "https:", host: "desktop.test" });
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("localStorage", { getItem: () => null });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => "{}" }));
});
afterEach(() => { vi.unstubAllGlobals(); });

async function start() {
  const { connectStore } = await import("../ui/shell/store.js");
  const { approvals, startApprovals } = await import("../ui/shell/approvals.js");
  startApprovals();
  connectStore();
  return { approvals, startApprovals, overviewSocket: Socket.opened[0] };
}

describe("shared approvals", () => {
  it("feeds the tray and answers Allow / Deny before Home has ever opened", async () => {
    const { approvals, overviewSocket } = await start();
    const { startTray } = await import("../ui/shell/tray.js");
    const setTray = vi.fn();
    let answer!: (value: { key: string; decision: string }) => void;
    startTray({ setTray, onTrayAnswer: (fn: typeof answer) => { answer = fn; } });
    overviewSocket.message(overview());
    const status = Socket.opened[1];
    expect(status.url).toContain("/hosts/mini/v1/status?server=herdr");
    status.message(approvalFrame({ actionId: "a1", command: "pnpm build" }));
    expect(setTray.mock.lastCall?.[0].rows).toEqual([
      { key: "mini/a", title: "Fix build", sub: "mini · wants approval", approval: "pnpm build", actionId: "a1" },
    ]);
    answer({ key: "mini/a", decision: "approve" });
    answer({ key: "mini/a", decision: "deny" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(vi.mocked(fetch).mock.calls.map(([url, init]) => [url, JSON.parse(String(init?.body))])).toEqual([
      ["/hosts/mini/v1/approvals/answer", { target, actionId: "a1", decision: "approve" }],
      ["/hosts/mini/v1/approvals/answer", { target, actionId: "a1", decision: "deny" }],
    ]);
    expect(approvals.approval("mini/a")?.summary).toBe("pnpm build");
  });

  it("shares one watcher and clears resolved or vanished approvals, ignoring late frames", async () => {
    const { approvals, startApprovals, overviewSocket } = await start();
    const changed = vi.fn();
    const unsubscribe = approvals.subscribe(changed);
    startApprovals();
    overviewSocket.message(overview());
    overviewSocket.message(overview());
    expect(Socket.opened).toHaveLength(2);
    const status = Socket.opened[1];
    status.message(approvalFrame({ actionId: 42, title: "Approve edit" }));
    expect(approvals.approval("mini/a")).toEqual({ actionId: "42", summary: "Approve edit" });
    status.message(approvalFrame(null));
    expect(approvals.approval("mini/a")).toBeUndefined();
    status.message(approvalFrame({ actionId: "later" }));
    expect(approvals.approval("mini/a")?.summary).toBe("Approval required");
    overviewSocket.message(overview(false, false));
    expect(status.closed).toBe(true);
    status.message(approvalFrame({ actionId: "stale" }));
    await approvals.answerKey("mini/a", "approve");
    expect(approvals.approval("mini/a")).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalled();
    unsubscribe();
    changed.mockClear();
    overviewSocket.message(overview());
    Socket.opened[2].message(approvalFrame({ actionId: "new" }));
    expect(changed).not.toHaveBeenCalled();
    expect(approvals.approval("mini/a")?.actionId).toBe("new");
  });

  it("clears a closed watcher and uses the latest action and project grant when answering", async () => {
    const { approvals, overviewSocket } = await start();
    overviewSocket.message(overview());
    Socket.opened[1].message(approvalFrame({ actionId: "old" }));
    Socket.opened[1].close();
    expect(approvals.approval("mini/a")).toBeUndefined();
    overviewSocket.message(overview());
    Socket.opened[2].message(approvalFrame({ actionId: "new", reason: "r".repeat(200) }));
    expect(approvals.approval("mini/a")?.summary).toHaveLength(160);
    await approvals.answerKey("mini/a", "approve", "project");
    expect(JSON.parse(String(vi.mocked(fetch).mock.lastCall?.[1]?.body))).toEqual({
      target, actionId: "new", decision: "allow-project",
    });
  });
});

describe("answerKey with the action a surface showed", () => {
  it("refuses when the pending approval was replaced after it was shown", async () => {
    const { approvals, overviewSocket } = await start();
    overviewSocket.message(overview());
    const status = Socket.opened[1];
    status.message(approvalFrame({ actionId: "A", title: "rm -rf build" }));
    status.message(approvalFrame({ actionId: "B", title: "rm -rf build" })); // replaced, same summary
    expect(await approvals.answerKey("mini/a", "approve", undefined, "A")).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(await approvals.answerKey("mini/a", "approve", undefined, "B")).toBe(true);
    expect(JSON.parse(String(vi.mocked(fetch).mock.lastCall?.[1]?.body))).toMatchObject({ actionId: "B" });
  });

  it("the menu bar answers with the action it showed", async () => {
    await start();
    const { startTray } = await import("../ui/shell/tray.js");
    const setTray = vi.fn();
    let answer!: (value: { key: string; decision: string; actionId?: string }) => void;
    startTray({ setTray, onTrayAnswer: (fn: typeof answer) => { answer = fn; } });
    Socket.opened[0].message(overview());
    Socket.opened[1].message(approvalFrame({ actionId: "A", command: "pnpm build" }));
    expect(setTray.mock.lastCall?.[0].rows[0]).toMatchObject({ approval: "pnpm build", actionId: "A" });
    Socket.opened[1].message(approvalFrame({ actionId: "B", command: "pnpm build" }));
    answer({ key: "mini/a", decision: "approve", actionId: "A" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetch).not.toHaveBeenCalled();
  });
});

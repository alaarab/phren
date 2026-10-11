import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentHooks } from "./agent-hooks.js";
import { OwnerInbox } from "./owner-inbox.js";
import { ownerInboxSources } from "./owner-inbox-sources.js";
import { dispatchStatus } from "./dispatch.js";
import { paneChatState, recentServers, snapshot, rpc } from "./herdr.js";
import { hookPeers, peerRequest } from "./peers.js";
import { workerStates } from "./dispatch-returns.js";
import type { Json } from "./protocol.js";
vi.mock("./herdr.js", async original => ({ ...await original<object>(), paneChatState: vi.fn(), recentServers: vi.fn(), snapshot: vi.fn(), rpc: vi.fn() }));
vi.mock("./dispatch.js", async original => ({ ...await original<object>(), dispatchStatus: vi.fn() }));
vi.mock("./dispatch-returns.js", async original => ({ ...await original<object>(), workerStates: vi.fn() }));
vi.mock("./peers.js", async original => ({ ...await original<object>(), hookPeers: vi.fn(), peerRequest: vi.fn() }));
const target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "codex" as const, session: "aaaaaaaa-1111-4111-8111-111111111111" };
let root: string, hooks: AgentHooks, panes: Json[], screen: string;
const box = () => new OwnerInbox(() => ownerInboxSources(hooks), path.join(root, "owner-inbox.json"));
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "inbox-sources-")); hooks = new AgentHooks(); screen = "";
  panes = [{ pane_id: target.pane, tab_id: target.tab, workspace_id: target.workspace, agent: "codex", agent_status: "blocked" }];
  vi.mocked(recentServers).mockResolvedValue([{ session: "default" }]);
  vi.mocked(snapshot).mockImplementation(async () => ({ panes }));
  vi.mocked(paneChatState).mockResolvedValue({ sessionId: target.session });
  vi.mocked(rpc).mockImplementation(async (_server, method) => {
    if (method === "agent.read") return { read: { text: screen } };
    throw new Error(`Unexpected method ${method}`);
  });
  vi.mocked(dispatchStatus).mockResolvedValue([]);
  vi.mocked(hookPeers).mockResolvedValue([]);
});
afterEach(async () => { hooks.close(); vi.resetAllMocks(); await rm(root, { recursive: true, force: true }); });
describe("current owner inbox sources", () => {
  it.each(["working", "idle", "done", "closed"])("retires a blocked pane when it becomes %s without a phone watching", async state => {
    const inbox = box();
    expect((await inbox.run({})).items).toMatchObject([{ live: true, target }]);
    if (state === "closed") panes = []; else panes[0].agent_status = state;
    expect((await inbox.run({})).items).toEqual([]);
    expect((await inbox.run({ includeResolved: true })).items).toMatchObject([{ state: "resolved", live: false }]);
  });
  it("drops a remembered terminal approval after the pane resumes", async () => {
    screen = "Choose permissions\n› 1. Read only\n  2. Ask for approval\n  3. Full access";
    const inbox = box();
    expect((await inbox.run({})).items).toMatchObject([{ live: true, actionId: expect.any(String) }]);
    panes[0].agent_status = "working"; screen = "Working";
    expect((await inbox.run({})).items).toEqual([]);
    expect(hooks.terminalPrompt(target)).toBeUndefined();
  });
  it("retires answered and auto-resolved served questions", async () => {
    const question = vi.spyOn(hooks, "servedQuestion").mockReturnValue({ actionId: "q1", message: "Choose the target?" });
    panes[0].agent_status = "working";
    const inbox = box();
    expect((await inbox.run({})).items).toMatchObject([{ actionId: "q1" }]);
    question.mockReturnValue(undefined);
    expect((await inbox.run({})).items).toEqual([]);
  });
  it.each(["local", "Desk"])("rechecks %s dispatch receipts instead of trusting stale needs-you and approval returns", async computer => {
    panes = [];
    const id = "bbbbbbbb-1111-4111-8111-111111111111", at = new Date().toISOString();
    vi.mocked(dispatchStatus).mockResolvedValue([{ id, computer, target, project: "phren", label: "pr-finisher",
      returned: { state: "needs-you", at, question: "Continue?" },
      approval: { actionId: "stale-approval", tool: "Bash", at },
    }] as never);
    vi.mocked(hookPeers).mockResolvedValue([{ name: "Desk" }] as never);
    let workers: Json[] = [{ state: "idle", completed: true, reply: "Continue?" }];
    vi.mocked(workerStates).mockImplementation(async () => ({ workers }) as never);
    vi.mocked(peerRequest).mockImplementation(async () => ({ workers }));
    const inbox = box();
    expect((await inbox.run({})).items).toMatchObject([{ kind: "needs-you", title: "Continue?", live: true }]);
    workers = [{ state: "working", approval: { actionId: "new-approval", request: "Run tests?" } }];
    expect((await inbox.run({})).items).toMatchObject([{ kind: "blocked", actionId: "new-approval", live: true }]);
    workers = [{ state: "working" }];
    expect((await inbox.run({})).items).toEqual([]);
    workers = [{ state: "blocked" }];
    expect((await inbox.run({})).items).toHaveLength(1);
    workers = [{ state: "gone" }];
    expect((await inbox.run({})).items).toEqual([]);
  });
});

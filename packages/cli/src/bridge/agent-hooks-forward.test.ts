import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

// The hold is read once at import; keep it short so a test can outlive it.
vi.hoisted(() => { process.env.PHREN_APPROVAL_HOLD_MS = "300"; });

import { AgentHooks } from "./agent-hooks.js";
import { localSocket } from "./agent-hook-stores.js";
import { rpc, snapshot, validateTarget } from "./herdr.js";
import type { ApprovalPushService } from "./push.js";
import type { Target } from "./protocol.js";

vi.mock("./herdr.js", async importOriginal => ({
  ...await importOriginal<typeof import("./herdr.js")>(), rpc: vi.fn(), snapshot: vi.fn(), validateTarget: vi.fn(),
}));

const target: Target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1",
  source: "claude", session: "aaaaaaaa-1111-4111-8111-111111111111" };
const pane = { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: "claude", agent_status: "blocked", terminal_id: "term-1" };
const dialog = " Bash command\n\n   rm -rf build\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend";
const lease = { server: target.server, pane: target.pane, source: target.source };

/** Claude's hook subprocess: posts the ask and waits for the Hook's answer. */
function ask(input: unknown = { command: "rm -rf build" }): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: localSocket(), path: "/hook", method: "POST" }, res => {
      let body = ""; res.on("data", chunk => { body += chunk; }); res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ event: "PermissionRequest", target, tool: "Bash", input }));
  });
}

describe.skipIf(process.platform === "win32")("a dispatched worker's approval, forwarded to the dispatching Hook", () => {
  let bridge: string, previous: string | undefined, hooks: AgentHooks;
  const notify = vi.fn(async (_value: { binding: string; provider: string; computer?: string; request?: string; project?: string }) => true);
  const keys = () => vi.mocked(rpc).mock.calls.filter(call => call[1] === "agent.send_keys").map(call => call[2]?.keys);

  beforeEach(async () => {
    notify.mockClear();
    bridge = await mkdtemp(path.join(tmpdir(), "phren-forward-"));
    previous = process.env.PHREN_BRIDGE_HOME; process.env.PHREN_BRIDGE_HOME = bridge;
    vi.mocked(snapshot).mockReset().mockResolvedValue({ panes: [pane] });
    vi.mocked(validateTarget).mockReset().mockResolvedValue({});
    vi.mocked(rpc).mockReset().mockImplementation(async (_server, method) => {
      if (method === "pane.process_info") return { process_info: { foreground_processes: [{ pid: process.pid }] } };
      if (method === "agent.read") return { read: { text: dialog } };
      if (method === "agent.send_keys") return { ok: true };
      throw new Error(`Unexpected RPC ${method}`);
    });
    // No phone here: only the dispatch lease can make the Hook hold a request.
    hooks = new AgentHooks({ available: false, start: async () => {}, status: { configured: false }, notify } as unknown as ApprovalPushService);
    await hooks.start();
  });
  afterEach(async () => {
    hooks.close();
    if (previous === undefined) delete process.env.PHREN_BRIDGE_HOME; else process.env.PHREN_BRIDGE_HOME = previous;
    await rm(bridge, { recursive: true, force: true });
  });

  it("holds a leased pane's ask with no phone and no push, and offers it without its message", async () => {
    hooks.leaseDispatch([lease]);
    const answer = ask();
    await vi.waitFor(() => expect(hooks.workerApproval(target)).toBeDefined());
    const card = hooks.workerApproval(target)!;
    expect(card).toMatchObject({ tool: "Bash", request: "Run: rm -rf build", requestKind: "command", expiresAt: expect.any(String) });
    expect(card).not.toHaveProperty("message");
    expect(card).not.toHaveProperty("details");
    expect(card).not.toHaveProperty("pushed");
    await hooks.answer(target, card.actionId, "approve");
    expect(JSON.parse(await answer)).toMatchObject({ hookSpecificOutput: { decision: { behavior: "allow" } } });
    expect(hooks.workerApproval(target)).toBeUndefined();
  });

  it("hands an unleased pane's ask straight to its terminal", async () => {
    expect(await ask()).toBe("{}");
    expect(hooks.workerApproval(target)).toBeUndefined();
  });

  it("keeps a leased ask held when its push fails", async () => {
    hooks.close();
    hooks = new AgentHooks({ available: true, start: async () => {}, status: { configured: true }, notify: async () => false } as unknown as ApprovalPushService);
    await hooks.start();
    hooks.leaseDispatch([lease]);
    const answer = ask();
    await new Promise(resolve => setTimeout(resolve, 100));
    const card = hooks.workerApproval(target)!;
    expect(card).toBeDefined();
    expect(card).not.toHaveProperty("pushed");
    await hooks.answer(target, card.actionId, "deny");
    expect(JSON.parse(await answer)).toMatchObject({ hookSpecificOutput: { decision: { behavior: "deny" } } });
  });

  it("offers the dialog left in the terminal under a dialog- id that answers with the pane's keys", async () => {
    hooks.leaseDispatch([lease]);
    expect(await ask()).toBe("{}");
    await vi.waitFor(async () => {
      await hooks.observeWaitingPanes("default", [pane], async () => target);
      expect(hooks.workerApproval(target)).toBeDefined();
    });
    const card = hooks.workerApproval(target)!;
    expect(card.actionId).toMatch(/^dialog-[0-9a-f-]{36}$/);
    expect(card).toMatchObject({ terminal: true, tool: "Bash" });
    // The same dialog keeps its id.
    expect(hooks.workerApproval(target)!.actionId).toBe(card.actionId);
    await expect(hooks.answer({ ...target, session: "bbbbbbbb-1111-4111-8111-111111111111" }, card.actionId, "approve")).rejects.toThrow(/no longer pending/);
    await expect(hooks.answer(target, card.actionId, "approve", { command: "x" })).rejects.toThrow(/not valid/);
    await expect(hooks.answer(target, card.actionId, "allow-everywhere")).rejects.toThrow(/not valid/);
    expect(keys()).toEqual([]);
    await hooks.answer(target, card.actionId, "approve");
    expect(keys()).toEqual([["1"]]);
    await expect(hooks.answer(target, card.actionId, "approve")).rejects.toThrow(/no longer pending|changed/);
  });

  it("forgets a forwarded dialog once its pane stops waiting", async () => {
    hooks.leaseDispatch([lease]);
    await ask();
    await vi.waitFor(async () => {
      await hooks.observeWaitingPanes("default", [pane], async () => target);
      expect(hooks.workerApproval(target)).toBeDefined();
    });
    const { actionId } = hooks.workerApproval(target)!;
    await hooks.observeWaitingPanes("default", [{ ...pane, agent_status: "working" }], async () => target);
    await expect(hooks.answer(target, actionId, "approve")).rejects.toThrow(/no longer pending/);
  });

  it("pushes a forwarded request once and answers it through the callback", async () => {
    const pushing = { available: true, start: async () => {}, status: { configured: true }, notify } as unknown as ApprovalPushService;
    const dispatching = new AgentHooks(pushing);
    const answered = vi.fn(async (_decision: "approve" | "deny") => {});
    dispatching.pushForwarded({ provider: "claude", computer: "Linuxbox", project: "phren", request: "Run: rm -rf build", requestKind: "command" }, answered);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    const sent = notify.mock.calls[0][0];
    expect(sent).toMatchObject({ provider: "claude", computer: "Linuxbox", project: "phren", request: "Run: rm -rf build" });
    expect(dispatching.pushTarget(sent.binding)).toBeUndefined();
    await dispatching.answerPush(sent.binding, "deny");
    expect(answered).toHaveBeenCalledWith("deny");
    await expect(dispatching.answerPush(sent.binding, "approve")).rejects.toThrow(/no longer pending/);
    dispatching.close();
  });

  it("does not push a forwarded request when this Hook has no push", async () => {
    hooks.pushForwarded({ provider: "claude", computer: "Linuxbox", request: "x" }, async () => {});
    expect(notify).not.toHaveBeenCalled();
  });
});

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

/** Claude's hook subprocess: posts the ask and waits for the Hook's answer. */
function ask(): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: localSocket(), path: "/hook", method: "POST" }, res => {
      let body = ""; res.on("data", chunk => { body += chunk; }); res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ event: "PermissionRequest", target, tool: "Bash", input: { command: "rm -rf build" } }));
  });
}

describe("an approval pushed to a closed phone", () => {
  let bridge: string, previous: string | undefined, hooks: AgentHooks;
  const sent: { binding: string; expiresAt: string }[] = [];
  const keys = () => vi.mocked(rpc).mock.calls.filter(call => call[1] === "agent.send_keys").map(call => call[2]?.keys);

  beforeEach(async () => {
    sent.length = 0;
    bridge = await mkdtemp(path.join(tmpdir(), "phren-push-"));
    previous = process.env.PHREN_BRIDGE_HOME; process.env.PHREN_BRIDGE_HOME = bridge;
    vi.mocked(snapshot).mockReset().mockResolvedValue({ panes: [pane] });
    vi.mocked(validateTarget).mockReset().mockResolvedValue({});
    vi.mocked(rpc).mockReset().mockImplementation(async (_server, method) => {
      if (method === "pane.process_info") return { process_info: { foreground_processes: [{ pid: process.pid }] } };
      if (method === "agent.read") return { read: { text: dialog } };
      if (method === "agent.send_keys") return { ok: true };
      throw new Error(`Unexpected RPC ${method}`);
    });
    const push = { available: true, start: async () => {}, status: { configured: true },
      notify: vi.fn(async (value: { binding: string; expiresAt: string }) => { sent.push(value); return true; }) };
    hooks = new AgentHooks(push as unknown as ApprovalPushService);
    await hooks.start();
  });
  afterEach(async () => {
    hooks.close();
    if (previous === undefined) delete process.env.PHREN_BRIDGE_HOME; else process.env.PHREN_BRIDGE_HOME = previous;
    await rm(bridge, { recursive: true, force: true });
  });

  it("Approve from the lock screen answers a held ask through its hook", async () => {
    const answer = ask();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    // The notification lives past the hold, so it can still act once the hold ends.
    expect(Date.parse(sent[0].expiresAt) - Date.now()).toBeGreaterThan(60_000);
    expect(hooks.pushTarget(sent[0].binding)).toEqual(target);
    await hooks.answerPush(sent[0].binding, "approve");
    expect(JSON.parse(await answer)).toMatchObject({ hookSpecificOutput: { decision: { behavior: "allow" } } });
    await expect(hooks.answerPush(sent[0].binding, "approve")).rejects.toThrow(/no longer pending/);
  });

  it("after the hold ends, the same notification answers the dialog left in the terminal", async () => {
    const answer = ask();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(await answer).toBe("{}");
    // Answered before the next Hook tick has even read the pane.
    expect(hooks.pushTarget(sent[0].binding)).toEqual(target);
    await hooks.answerPush(sent[0].binding, "approve");
    expect(keys()).toEqual([["1"]]);
    await expect(hooks.answerPush(sent[0].binding, "deny")).rejects.toThrow(/no longer pending/);
  });

  it("the tick adopts the released ask without a second notification, and Deny types its no row", async () => {
    const answer = ask();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await answer;
    await hooks.observeWaitingPanes("default", [pane], async () => target);
    await hooks.observeWaitingPanes("default", [pane], async () => target);
    expect(sent).toHaveLength(1);
    await hooks.answerPush(sent[0].binding, "deny");
    expect(keys()).toEqual([["2"]]);
  });

  it("a released ask answered in the terminal leaves the notification powerless", async () => {
    const answer = ask();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await answer;
    await hooks.observeWaitingPanes("default", [{ ...pane, agent_status: "working" }], async () => target);
    expect(hooks.pushTarget(sent[0].binding)).toBeUndefined();
    await expect(hooks.answerPush(sent[0].binding, "approve")).rejects.toThrow(/no longer pending/);
    expect(keys()).toEqual([]);
  });
});

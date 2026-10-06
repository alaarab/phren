import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentHooks, appServerApproval, appServerDecision } from "./agent-hooks.js";
import { validateTarget } from "./herdr.js";
import type { PendingServerRequest } from "./codex-app-server.js";
import type { Json, Target } from "./protocol.js";

vi.mock("./herdr.js", async importOriginal => ({
  ...await importOriginal<typeof import("./herdr.js")>(), rpc: vi.fn(), validateTarget: vi.fn(),
}));

const target: Target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1",
  source: "codex", session: "aaaaaaaa-1111-4111-8111-111111111111" };
const command: PendingServerRequest = { requestId: 4, method: "item/commandExecution/requestApproval",
  params: { threadId: target.session, turnId: "t", itemId: "i", command: "touch approved.txt", cwd: "/tmp/work" }, threadId: target.session };

describe.skipIf(process.platform === "win32")("approvals from the Hook's own Codex app-server", () => {
  let hooks: AgentHooks, answers: Json[];
  beforeEach(() => {
    hooks = new AgentHooks(); answers = [];
    vi.mocked(validateTarget).mockReset().mockResolvedValue({});
  });

  it("shows a server request as an approval card with no hold timer and answers it over RPC", async () => {
    hooks.codexRequest(target, command, result => answers.push(result));
    const card = hooks.approval(target)!;
    expect(card).toMatchObject({ toolName: "Bash", request: "Run: touch approved.txt", terminalOnly: false });
    // Answerable long after the 55-second hold of a PermissionRequest callback.
    expect(Date.parse(String(card.expiresAt)) - Date.now()).toBeGreaterThan(60_000);
    await hooks.answer(target, String(card.actionId), "approve");
    expect(answers).toEqual([{ decision: "accept" }]);
    expect(hooks.approval(target)).toBeUndefined();
  });

  it("declines on deny, and grants nothing for a refused permission request", async () => {
    hooks.codexRequest(target, command, result => answers.push(result));
    await hooks.answer(target, String(hooks.approval(target)!.actionId), "deny");
    const permissions: PendingServerRequest = { requestId: 5, method: "item/permissions/requestApproval",
      params: { threadId: target.session, permissions: { network: { enabled: true } } }, threadId: target.session };
    hooks.codexRequest(target, permissions, result => answers.push(result));
    expect(hooks.approval(target)).toMatchObject({ toolName: "Permissions" });
    await hooks.answer(target, String(hooks.approval(target)!.actionId), "deny");
    expect(answers).toEqual([{ decision: "decline" }, { permissions: {}, scope: "turn" }]);
    expect(appServerDecision(permissions, true)).toEqual({ permissions: { network: { enabled: true } }, scope: "turn" });
  });

  it("drops the card when the pane's TUI answered first", async () => {
    hooks.codexRequest(target, command, result => answers.push(result));
    const action = String(hooks.approval(target)!.actionId);
    hooks.codexResolved(target, 4);
    expect(hooks.approval(target)).toBeUndefined();
    await expect(hooks.answer(target, action, "approve")).rejects.toThrow("no longer pending");
    expect(answers).toEqual([]);
  });

  it("keeps a replayed request to one card, answered through the newest connection", async () => {
    const stale: Json[] = [];
    hooks.codexRequest(target, command, result => stale.push(result));
    const action = String(hooks.approval(target)!.actionId);
    hooks.codexRequest(target, command, result => answers.push(result));
    expect(hooks.approval(target)!.actionId).toBe(action);
    await hooks.answer(target, action, "approve");
    expect(stale).toEqual([]);
    expect(answers).toEqual([{ decision: "accept" }]);
    expect(hooks.approval(target)).toBeUndefined();
  });

  it("leaves questions and elicitations to the pane", () => {
    hooks.codexRequest(target, { requestId: 6, method: "item/tool/requestUserInput", params: { questions: [] } }, result => answers.push(result));
    hooks.codexRequest(target, { requestId: 7, method: "mcpServer/elicitation/request", params: {} }, result => answers.push(result));
    expect(hooks.approval(target)).toBeUndefined();
  });

  it("does not answer a parked request when the Hook stops", () => {
    hooks.codexRequest(target, command, result => answers.push(result));
    hooks.close();
    expect(answers).toEqual([]);
  });

  it("summarizes file changes from the item the request names", () => {
    const shown = appServerApproval({ requestId: 1, method: "item/fileChange/requestApproval",
      params: { changes: [{ path: "/tmp/work/a.ts", kind: { type: "update" } }, { path: "/tmp/work/b.ts", kind: { type: "add" } }] } });
    expect(shown).toEqual({ tool: "apply_patch", input: { patch: "*** Update File: /tmp/work/a.ts\n*** Add File: /tmp/work/b.ts" } });
    hooks.codexRequest(target, { requestId: 1, method: "item/fileChange/requestApproval", threadId: target.session,
      params: { changes: [{ path: "/tmp/work/a.ts", kind: { type: "update" } }] } }, () => {});
    expect(hooks.approval(target)).toMatchObject({ request: "Edit: /tmp/work/a.ts" });
  });
});

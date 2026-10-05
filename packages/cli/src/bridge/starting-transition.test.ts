import { AgentHooks } from "./agent-hooks.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const probe = vi.hoisted(() => ({ logs: "" }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  execFile: Object.assign(() => {}, { [Symbol.for("nodejs.util.promisify.custom")]: async (_file: string, args: string[]) => ({ stdout: args.includes("-Fn") ? probe.logs : "" }) }),
}));
import { paneChatState, validateStartingTarget } from "./herdr.js";
import { paneRoute } from "./server-pane-routes.js";
import { setTerminalProvider, type TerminalProvider } from "./terminal.js";
import type { Json, StartingTarget } from "./protocol.js";

const session = "aaaaaaaa-1111-4111-8111-111111111111", other = "bbbbbbbb-1111-4111-8111-111111111111";
let root: string, restore: () => void, pane: Json, pids: number[], typed: number, sequence = 0;
const reported = (value: string) => ({ kind: "id", agent: "codex", value });
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "phren-starting-"));
  vi.stubEnv("PHREN_BRIDGE_HOME", root); vi.stubEnv("CODEX_HOME", root);
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  probe.logs = ""; pids = [100 + ++sequence]; typed = 0;
  pane = { workspace_id: "w1", tab_id: "w1:t1", pane_id: `w1:p${sequence}`, terminal_id: `terminal-${sequence}`, agent: "codex", agent_status: "idle" };
  restore = setTerminalProvider({ snapshot: async () => ({ panes: [{ ...pane }] }), processes: async () => ({ foregroundPids: pids }),
    prompt: async () => { typed++; } } as unknown as TerminalProvider);
});
afterEach(async () => { restore(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
async function starting(): Promise<StartingTarget> {
  const state = await paneChatState("default", pane);
  expect(state.starting).toBe(true);
  return { server: "default", workspace: "w1", tab: "w1:t1", pane: String(pane.pane_id), source: "codex", starting: true, startingToken: String(state.startingToken) };
}
const context = { agentHooks: new AgentHooks(), modelSwitcher: { assertAvailable() {} }, settingsSwitcher: { assertAvailable() {} }, permissionModeSwitcher: { assertAvailable() {} }, sideQuestions: { assertAvailable() {} } } as never;
const send = (target: Json, deliveryId = `delivery-${sequence}`) => paneRoute(context, new URL("http://phren.local/v1/prompt"), { target, text: "hello", deliveryId }, {} as never);

it("delivers a first send across token -> session identity exactly once, including a session-target retry", async () => {
  const target = await starting();
  pane.agent_session = reported(session);
  expect((await paneChatState("default", pane)).startingToken).toBe(target.startingToken);
  expect(await send(target)).toEqual({ ok: true });
  expect(await send(target)).toEqual({ ok: true, replayed: true });
  expect(await send({ ...target, starting: undefined, startingToken: undefined, session })).toEqual({ ok: true, replayed: true });
  expect(typed).toBe(1);
});

it("keeps a startup token stable when helpers join its foreground process group", async () => {
  const target = await starting(); pids.push(9999);
  expect((await paneChatState("default", pane)).startingToken).toBe(target.startingToken);
  await expect(validateStartingTarget(target)).resolves.toMatchObject({ pane_id: target.pane });
});

it.each(["process", "terminal", "pane", "agent", "conversation", "expired"])("rejects an old token after %s changes without typing", async change => {
  const target = await starting();
  if (change === "process") pids = [9999];
  if (change === "terminal") pane.terminal_id = "replacement";
  if (change === "pane") pane.pane_id = "gone";
  if (change === "agent") pane.agent = "claude";
  if (change === "conversation" || change === "expired") {
    pane.agent_session = reported(session);
    await paneChatState("default", pane, { tokenWhenIdentified: false });
    if (change === "conversation") pane.agent_session = reported(other);
    else vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
  }
  await expect(send(target)).rejects.toMatchObject({ status: 409 });
  expect(typed).toBe(0);
});

it("does not turn a token read from an established conversation into first-send permission", async () => {
  pane.agent_session = reported(session);
  const state = await paneChatState("default", pane);
  const target = { server: "default", workspace: "w1", tab: "w1:t1", pane: String(pane.pane_id), source: "codex", starting: true, startingToken: state.startingToken };
  await expect(send(target)).rejects.toMatchObject({ status: 409 }); expect(typed).toBe(0);
});

it("does not grant a transition for ambiguous open logs", async () => {
  probe.logs = `n/tmp/rollout-test-${session}.jsonl\nn/tmp/rollout-test-${other}.jsonl\n`;
  const state = await paneChatState("default", pane);
  expect(state.starting).toBeUndefined();
  pane.agent_session = reported(session);
  const target = { server: "default", workspace: "w1", tab: "w1:t1", pane: String(pane.pane_id), source: "codex", starting: true, startingToken: state.startingToken };
  await expect(send(target)).rejects.toMatchObject({ status: 409 }); expect(typed).toBe(0);
});

it("retires a prior token when a known conversation loses identity in the same process", async () => {
  const target = await starting();
  pane.agent_session = reported(session); await paneChatState("default", pane);
  delete pane.agent_session;
  const current = await paneChatState("default", pane);
  expect(current.startingToken).not.toBe(target.startingToken);
  await expect(send(target)).rejects.toMatchObject({ status: 409 }); expect(typed).toBe(0);
});

it("checks established-conversation reservations before a transitioning send", async () => {
  const target = await starting(); pane.agent_session = reported(session);
  const busy = new Error("model switch in progress");
  const assertAvailable = vi.fn(() => { throw busy; });
  await expect(paneRoute({ modelSwitcher: { assertAvailable } } as never, new URL("http://phren.local/v1/prompt"),
    { target, text: "hello", deliveryId: `busy-send-${sequence}` }, {} as never)).rejects.toBe(busy);
  expect(assertAvailable).toHaveBeenCalledWith(expect.objectContaining({ session })); expect(typed).toBe(0);
});

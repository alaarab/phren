import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Json, type Target, atomicInPrivateDir } from "./protocol.js";
import { snapshot, sharedSnapshot, paneIdentity, validateTarget } from "./herdr.js";
import { closeFinishedWorker, markWorkerClosed } from "./worker-close.js";
import { reportWorker } from "./worker-reports.js";
import { DispatchReturns, observe, workerStates } from "./dispatch-returns.js";
import { dispatchStatus, type Receipt } from "./dispatch.js";
import { noteTurn } from "./turn-records.js";
import { handOff } from "./hand-off.js";
import { recentUncommitted } from "./worker-unfinished.js";
import { setTerminalProvider, type TerminalProvider } from "./terminal.js";

vi.mock("./herdr.js", async original => ({ ...await original<object>(), snapshot: vi.fn(), sharedSnapshot: vi.fn(), paneIdentity: vi.fn(), validateTarget: vi.fn() }));
vi.mock("./schedule-watch.js", async original => ({ ...await original<object>(), readFinalTurn: async () => ({ completed: true, lastAssistant: "Checks passed" }) }));
vi.mock("./hand-off.js", async original => ({ ...await original<object>(), handOff: vi.fn() }));
vi.mock("./worker-unfinished.js", async original => ({ ...await original<object>(), recentUncommitted: vi.fn() }));
const target: Target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "claude", session: "11111111-1111-4111-8111-111111111111" };
const dispatch = "22222222-2222-4222-8222-222222222222";
const prs = [{ url: "https://github.com/alaarab/phren/pull/999", repo: "alaarab/phren", branch: "feat/checks", tests: "12 passed", notes: "Review the behavior" }];
let root: string, pane: Json, panes: Json[], restore: () => void;
const closePane = vi.fn();
const event = (event: string) => noteTurn(target.server, target.pane, { event, terminal: String(pane.terminal_id), source: target.source, session: target.session, dispatch, reply: event === "Stop" ? "Checks passed" : undefined });
const receipt = (): Receipt => ({ id: dispatch, computer: "Desk", project: "phren", harness: "claude", label: "checks", state: "accepted", target, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
const save = (value: Receipt) => atomicInPrivateDir(path.join(root, "dispatches", `${value.id}.json`), value);
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "phren-finish-")); vi.stubEnv("PHREN_BRIDGE_HOME", root);
  pane = { pane_id: target.pane, workspace_id: target.workspace, tab_id: target.tab, terminal_id: "term1", agent: "claude", agent_status: "idle" }; panes = [pane];
  vi.mocked(snapshot).mockImplementation(async () => ({ panes })); vi.mocked(sharedSnapshot).mockImplementation(async () => ({ panes }));
  vi.mocked(paneIdentity).mockResolvedValue(target.session); vi.mocked(validateTarget).mockImplementation(async () => ({ ...pane }));
  closePane.mockReset().mockImplementation(async () => { panes = []; }); restore = setTerminalProvider({ closePane } as unknown as TerminalProvider);
  vi.mocked(handOff).mockReset().mockResolvedValue({ ok: true, delivered: false, queued: true, target });
  vi.mocked(recentUncommitted).mockReset().mockResolvedValue(0);
  await event("UserPromptSubmit"); await event("Stop");
});
afterEach(async () => { restore(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe("finished worker lifecycle", () => {
  it("keeps PR evidence bound to the submitted turn and carries it through the done return", async () => {
    await reportWorker({ origin: { server: target.server, workspace: target.workspace, tab: target.tab, pane: target.pane }, prs });
    const observation = (await workerStates({ targets: [{ ...target, dispatch }] })).workers[0];
    expect(observation).toMatchObject({ state: "done", prs });
    const value = receipt(); observe(value, observation, Date.now()); expect(value.returned).toMatchObject({ state: "done", prs });
    await event("UserPromptSubmit"); await event("Stop");
    expect((await workerStates({ targets: [target] })).workers[0]).not.toHaveProperty("prs");
  });
  it("closes only after reading done, persists closure, and suppresses gone returns", async () => {
    const value = receipt(); observe(value, (await workerStates({ targets: [target] })).workers[0], Date.now()); await save(value);
    const close = vi.fn(current => closeFinishedWorker({ target: current.target, dispatch: current.id, turn: current.closePending.turn }));
    const returns = new DispatchReturns({ peers: async () => [], close });
    await returns.cleanup(); expect(close).not.toHaveBeenCalled();
    expect(await returns.take()).toMatchObject([{ state: "done" }]); expect(closePane).toHaveBeenCalledExactlyOnceWith(target.server, target.pane);
    expect((await dispatchStatus())[0]).toHaveProperty("closedAt");
    const closed = (await workerStates({ targets: [target] })).workers[0]; expect(closed.state).toBe("closed");
    const current = (await dispatchStatus())[0]; observe(current, closed, Date.now()); expect(current.returned!.state).toBe("done");
    await returns.take(); await returns.cleanup(); expect(closePane).toHaveBeenCalledTimes(1);
  });
  it("keeps a genuine gone return after the terminal refuses an automatic close", async () => {
    const value = receipt(); observe(value, (await workerStates({ targets: [target] })).workers[0], Date.now()); await save(value);
    closePane.mockRejectedValueOnce(new Error("close refused"));
    const returns = new DispatchReturns({ peers: async () => [], close: current => closeFinishedWorker({ target, dispatch, turn: current.closePending!.turn }) });
    await returns.take(); panes = [];
    expect((await workerStates({ targets: [target] })).workers[0].state).toBe("gone");
  });
  it("suppresses gone for a deliberate conductor close without requiring a done return", async () => {
    await markWorkerClosed(target, "term1"); panes = [];
    expect((await workerStates({ targets: [target] })).workers[0].state).toBe("closed");
    const value = receipt(); observe(value, { state: "closed" }, Date.now()); expect(value.returned).toBeUndefined();
  });
  it("keeps a worker open if another completed turn appears during the final binding check", async () => {
    const value = receipt(); observe(value, (await workerStates({ targets: [target] })).workers[0], Date.now()); await save(value);
    vi.mocked(validateTarget).mockResolvedValueOnce({ ...pane }).mockImplementationOnce(async () => {
      await event("UserPromptSubmit"); await event("Stop"); return { ...pane };
    });
    const returns = new DispatchReturns({ peers: async () => [], close: current => closeFinishedWorker({ target, dispatch, turn: current.closePending!.turn }) });
    await returns.take(); expect(closePane).not.toHaveBeenCalled();
  });
  it("retains the original integrator target across an offline retry and configuration change", async () => {
    const value = receipt(); observe(value, { state: "done", completed: true, reply: "Checks passed", prs }, Date.now()); await save(value);
    const original = { target: { ...target, pane: "integrator" } };
    await writeFile(path.join(root, "integrator.json"), JSON.stringify(original));
    vi.mocked(handOff).mockRejectedValueOnce(new Error("lost reply"));
    const returns = new DispatchReturns({ peers: async () => [] }); await returns.forwardPrs();
    expect((await dispatchStatus())[0].returned!.integratorDelivery).toMatchObject({ state: "pending", integrator: original });
    await writeFile(path.join(root, "integrator.json"), JSON.stringify({ target: { ...target, pane: "replacement" } }));
    await returns.forwardPrs();
    expect(vi.mocked(handOff).mock.calls[1][0]).toMatchObject({ target: original.target, deliveryId: (vi.mocked(handOff).mock.calls[0][0] as Json).deliveryId });
  });
  it.each(["working", "new turn", "queued message", "opt out"])("preserves a finished pane with %s", async reason => {
    const value = receipt(); observe(value, (await workerStates({ targets: [target] })).workers[0], Date.now());
    if (reason === "working") pane.agent_status = "working";
    if (reason === "new turn") { await event("UserPromptSubmit"); await event("Stop"); }
    if (reason === "opt out") value.closeOnFinish = false;
    await save(value);
    const queue = { whenNoPending: async (_target: Target, close: () => Promise<Json>) => reason === "queued message" ? { ok: true, closed: false } : close() };
    const returns = new DispatchReturns({ peers: async () => [], close: current => closeFinishedWorker({ target, dispatch, turn: current.closePending!.turn }, queue as never) });
    await returns.take(); expect(closePane).not.toHaveBeenCalled();
  });
  it("queues structured PRs to the integrator once and retains uncertain forwarding", async () => {
    const value = receipt(); observe(value, { state: "done", completed: true, reply: "Checks passed", prs }, Date.now()); await save(value);
    await writeFile(path.join(root, "integrator.json"), JSON.stringify({ target: { ...target, pane: "integrator" } }));
    const returns = new DispatchReturns({ peers: async () => [] });
    await returns.forwardPrs(); await new DispatchReturns({ peers: async () => [] }).forwardPrs();
    expect(vi.mocked(handOff).mock.calls.filter(([input]) => !(input as Json).status)).toHaveLength(1);
    expect(vi.mocked(handOff).mock.calls[0][0]).toMatchObject({ deliveryId: expect.stringMatching(/^pr-/), text: expect.stringContaining('"prs":') });
    expect((await dispatchStatus())[0].returned!.integratorDelivery).toHaveProperty("state", "queued");
    value.returned!.at = new Date(Date.now() + 1000).toISOString(); await save(value);
    vi.mocked(handOff).mockResolvedValue({ ok: false, delivered: false, deliveryUncertain: true, target });
    await returns.forwardPrs(); await returns.forwardPrs(); expect(vi.mocked(handOff).mock.calls.filter(([input]) => !(input as Json).status)).toHaveLength(2);
    expect((await dispatchStatus())[0].returned!.integratorDelivery).toHaveProperty("state", "uncertain");
  });
  it("retries a failed close through the persisted pending marker after restart", async () => {
    const value = receipt(); observe(value, { state: "done", completed: true, reply: "Checks passed" }, Date.now()); await save(value);
    const broken = new DispatchReturns({ peers: async () => [], close: async () => { throw new Error("peer offline"); } });
    await broken.take(); expect((await dispatchStatus())[0]).toHaveProperty("closePending");
    const restarted = new DispatchReturns({ peers: async () => [], close: async () => ({ closed: true }) });
    await restarted.cleanup(); expect((await dispatchStatus())[0]).toHaveProperty("closedAt");
  });
  // Review of #283: the close recheck must not close a turn that left work
  // behind, nor one whose checkout git could not read in time.
  it.each([["uncommitted work", 3], ["an unreadable checkout", "unknown"]] as const)("keeps a done worker's pane open over %s", async (_name, files) => {
    pane.cwd = "/work/phren-wt";
    const value = receipt(); observe(value, (await workerStates({ targets: [target] })).workers[0], Date.now()); await save(value);
    expect(value.returned).toMatchObject({ state: "done" });
    expect(recentUncommitted).toHaveBeenCalledWith("/work/phren-wt");
    vi.mocked(recentUncommitted).mockResolvedValue(files);
    expect(await closeFinishedWorker({ target, dispatch, turn: value.returned!.turn })).toEqual({ ok: true, closed: false });
    expect(closePane).not.toHaveBeenCalled();
    // Read clean, the same turn closes.
    vi.mocked(recentUncommitted).mockResolvedValue(0);
    expect(await closeFinishedWorker({ target, dispatch, turn: value.returned!.turn })).toEqual({ ok: true, closed: true });
  });
  it("refuses to close a different completed turn", async () => {
    const wrong = createHash("sha256").update("wrong turn").digest("hex").slice(0, 16);
    expect(await closeFinishedWorker({ target, dispatch, turn: wrong })).toHaveProperty("closed", false); expect(closePane).not.toHaveBeenCalled();
  });
});

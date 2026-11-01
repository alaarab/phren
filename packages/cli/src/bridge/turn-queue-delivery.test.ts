import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppServerRpcError } from "./codex-app-server.js";
import { CodexServerUnavailable, codexServers } from "./codex-servers.js";
import { paneIdentity, snapshot, validateTarget } from "./herdr.js";
import { PromptDeliveries } from "./prompt-deliveries.js";
import { BridgeError, type Json, type Target } from "./protocol.js";
import { paneRouteOnce, type PaneRouteContext } from "./server-pane-routes.js";
import { setTerminalProvider, type TerminalProvider } from "./terminal.js";
import { noteTurn } from "./turn-records.js";
import { TurnQueue } from "./turn-queue.js";
import { turnQueuePaneReader } from "./turn-queue-pane.js";

vi.mock("./herdr.js", async original => ({ ...await original<object>(), paneIdentity: vi.fn(), snapshot: vi.fn(), validateTarget: vi.fn() }));
vi.mock("./transcripts.js", async original => ({ ...await original<object>(), childAgentTree: async () => [] }));
vi.mock("./schedule-watch.js", async original => ({ ...await original<object>(), readFinalTurn: async () => undefined }));

let root: string, target: Target, pane: Json, deliveries: PromptDeliveries, queue: TurnQueue, restore: () => void;
const prompt = vi.fn(), processes = vi.fn();
let heldApproval = false;
const hooks = () => ({ deliveries, approval: () => heldApproval ? { tool: "Bash" } : undefined, terminalPrompt: () => undefined, servedQuestion: () => undefined });
const turn = (event: string) => noteTurn(target.server, target.pane, { event, terminal: String(pane.terminal_id), source: target.source, session: target.session });
const items = () => queue.list(target);

beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".scratch"), { recursive: true });
  root = await mkdtemp(path.join(process.cwd(), ".scratch/turn-queue-delivery-"));
  vi.stubEnv("PHREN_BRIDGE_HOME", root); vi.stubEnv("PHREN_PATH", root);
  heldApproval = false;
  target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "codex", session: "aaaaaaaa-1111-4111-8111-111111111111" };
  pane = { workspace_id: target.workspace, tab_id: target.tab, pane_id: target.pane, terminal_id: "terminal-1", agent: "codex", agent_status: "idle" };
  vi.mocked(snapshot).mockImplementation(async () => ({ panes: [{ ...pane }] }));
  vi.mocked(validateTarget).mockImplementation(async () => ({ ...pane }));
  vi.mocked(paneIdentity).mockImplementation(async () => target.session);
  vi.spyOn(codexServers, "forTarget").mockReturnValue(undefined);
  deliveries = new PromptDeliveries(path.join(root, "deliveries.json"), Date.now, async () => []);
  prompt.mockReset().mockImplementation(async (_server, _pane, text) => { await deliveries.submitted(target, text); });
  processes.mockReset().mockResolvedValue({ foregroundPids: [43210] });
  restore = setTerminalProvider({ prompt, processes, readScreen: async () => "", sendKeys: async () => {} } as unknown as TerminalProvider);
  const ctx = { agentHooks: hooks(), modelSwitcher: { assertAvailable() {} }, settingsSwitcher: { assertAvailable() {} },
    permissionModeSwitcher: { assertAvailable() {} }, sideQuestions: { assertAvailable() {} } } as unknown as PaneRouteContext;
  queue = new TurnQueue(path.join(root, "turn-queue.json"), {
    current: turnQueuePaneReader(ctx.agentHooks),
    holding: (where, exceptId) => deliveries.holding(where, exceptId),
    delivery: (where, id) => deliveries.status(id, where),
    send: async (where, text, deliveryId, typing) => await paneRouteOnce(ctx, new URL("http://phren.local/v1/prompt"),
      { target: where, text, deliveryId, hookQueued: true }, {} as never, typing) as Json,
  });
  await turn("UserPromptSubmit"); await turn("Stop");
});
afterEach(async () => { restore(); await deliveries.flush(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it("holds an eligible Stop behind an ordinary pending delivery, excluding only its own reservation on send", async () => {
  await queue.enqueue(target, "after-ordinary", "Queued words");
  void deliveries.expect(target, "Ordinary words", 1, undefined, "ordinary-send", "terminal-1");
  await queue.tick(); expect(prompt).not.toHaveBeenCalled(); expect(items()[0].state).toBe("queued");
  await deliveries.submitted(target, "Ordinary words");
  await queue.tick();
  expect(prompt).toHaveBeenCalledExactlyOnceWith(target.server, target.pane, "Queued words");
  expect(items()[0].state).toBe("delivered");
});

it("rechecks other delivery reservations created during prompt validation before typing", async () => {
  await queue.enqueue(target, "validation-race", "Queued words");
  vi.mocked(validateTarget).mockImplementationOnce(async () => {
    void deliveries.expect(target, "Racing words", 1, undefined, "racing-delivery", "terminal-1");
    return { ...pane };
  });
  await queue.tick(); expect(prompt).not.toHaveBeenCalled(); expect(items()[0].state).toBe("queued");
  await deliveries.submitted(target, "Racing words"); await queue.tick();
  expect(prompt).toHaveBeenCalledTimes(1); expect(items()[0].state).toBe("delivered");
});

it("sends at successive OpenCode plugin boundaries through the production pane reader", async () => {
  target = { ...target, source: "opencode", session: "ses_queueTest" }; pane.agent = "opencode";
  const folder = path.join(root, ".runtime/sessions"); await mkdir(folder, { recursive: true });
  const stamp = (busyAt: string, idleAt: string, session = target.session) => writeFile(path.join(folder, "opencode-status-43210.json"),
    JSON.stringify({ session, at: idleAt, busyAt, idleAt, status: "idle" }));
  await stamp("2026-11-01T10:00:00Z", "2026-11-01T10:01:00Z", "ses_wrongConversation");
  await queue.enqueue(target, "opencode-first", "First"); await queue.enqueue(target, "opencode-second", "Second");
  await queue.tick(); expect(prompt).not.toHaveBeenCalled(); // a foreign PID stamp cannot speak for this conversation
  await stamp("2026-11-01T10:00:00Z", "2026-11-01T10:01:00Z");
  await queue.tick(); await queue.tick(); expect(prompt).toHaveBeenCalledTimes(1);
  await stamp("2026-11-01T10:02:00Z", "2026-11-01T10:01:00Z");
  await queue.tick(); expect(prompt).toHaveBeenCalledTimes(1); // busy without a newer idle stamp
  await stamp("2026-11-01T10:02:00Z", "2026-11-01T10:03:00Z");
  await queue.tick(); expect(prompt).toHaveBeenCalledTimes(2);
  expect(items().map(item => item.state)).toEqual(["delivered", "delivered"]);
});

it.each(["codex-rpc", "herdr"])("fails a definite %s refusal without blocking the next item", async kind => {
  await queue.enqueue(target, "refused-item", "Refused"); await queue.enqueue(target, "following-item", "Following");
  if (kind === "codex-rpc") {
    vi.mocked(codexServers.forTarget).mockReturnValue({ threadId: target.session } as never);
    vi.spyOn(codexServers, "send").mockRejectedValueOnce(new AppServerRpcError(-32602, "Invalid input", "turn/start"));
  } else prompt.mockRejectedValueOnce(new BridgeError(409, "No agent", { herdrCode: "agent_not_found" }));
  await queue.tick();
  expect(items()[0]).toMatchObject({ state: "failed", reason: "delivery-failed" });
  expect(deliveries.holding(target)).toBe(false);
  vi.mocked(codexServers.forTarget).mockReturnValue(undefined);
  await queue.tick(); expect(items()[1].state).toBe("delivered");
});

it("restores the boundary and queues a retryable startup refusal", async () => {
  await queue.enqueue(target, "startup-refusal", "Try after startup");
  prompt.mockRejectedValueOnce(new BridgeError(409, "Still starting", { herdrCode: "agent_not_ready" }));
  await queue.tick(); expect(items()[0].state).toBe("queued"); expect(deliveries.holding(target)).toBe(false);
  await queue.tick(); expect(items()[0].state).toBe("delivered"); expect(prompt).toHaveBeenCalledTimes(2);
});

it("keeps an uncertain terminal failure unknown and never resends it", async () => {
  await queue.enqueue(target, "uncertain-send", "Possibly sent");
  prompt.mockRejectedValueOnce(new BridgeError(502, "Reply lost"));
  await queue.tick(); await queue.tick();
  expect(items()[0].state).toBe("unknown"); expect(prompt).toHaveBeenCalledTimes(1);
});

it.each(["approval", "delivery", "turn"])("restores queued state and the previous boundary when API unavailability meets a blocked %s fallback", async blocker => {
  // Establish a previous consumed boundary so rollback must restore it,
  // rather than simply remove the current boundary.
  await queue.enqueue(target, "before-fallback", "Previous turn"); await queue.tick();
  await turn("UserPromptSubmit"); await turn("Stop"); prompt.mockClear();
  await queue.enqueue(target, "blocked-fallback", "Wait for safety");
  await queue.enqueue(target, "after-fallback", "Then continue");
  const file = path.join(root, "turn-queue.json");
  const previous = JSON.parse(await readFile(file, "utf8")).boundaries;
  vi.mocked(codexServers.forTarget).mockReturnValue({ threadId: target.session } as never);
  const apiSend = vi.spyOn(codexServers, "send").mockImplementationOnce(async () => {
    if (blocker === "approval") heldApproval = true;
    if (blocker === "delivery") void deliveries.expect(target, "Other words", 1, undefined, "blocking-delivery", "terminal-1");
    if (blocker === "turn") await turn("UserPromptSubmit");
    throw new CodexServerUnavailable("API unavailable before sending");
  });
  await queue.tick();
  expect(apiSend).toHaveBeenCalledTimes(1); expect(prompt).not.toHaveBeenCalled();
  expect(items().map(item => item.state)).toEqual(["delivered", "queued", "queued"]);
  const persisted = JSON.parse(await readFile(file, "utf8"));
  expect(persisted.items[1].state).toBe("queued"); expect(persisted.boundaries).toEqual(previous);
  expect(deliveries.holding(target, "blocking-delivery")).toBe(false);
  vi.mocked(codexServers.forTarget).mockReturnValue(undefined);
  heldApproval = false;
  if (blocker === "delivery") await deliveries.submitted(target, "Other words");
  if (blocker === "turn") await turn("Stop");
  await queue.tick(); await queue.tick();
  expect(prompt).toHaveBeenCalledExactlyOnceWith(target.server, target.pane, "Wait for safety");
  expect(items().map(item => item.state)).toEqual(["delivered", "delivered", "queued"]);
});

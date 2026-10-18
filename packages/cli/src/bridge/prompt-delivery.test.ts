import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hookRequest } from "./client.js";
import { CodexServerUnavailable, codexServers } from "./codex-servers.js";
import { handOff } from "./hand-off.js";
import { paneIdentity, snapshot, validateStartingTarget, validateTarget } from "./herdr.js";
import { BridgeError, type Json, type Target } from "./protocol.js";
import { paneRoute, type PaneRouteContext } from "./server-pane-routes.js";
import { setTerminalProvider, type TerminalProvider } from "./terminal.js";
import { noteTurn } from "./turn-records.js";

vi.mock("./client.js", () => ({ hookRequest: vi.fn() }));
vi.mock("./grants.js", () => ({ findGrant: vi.fn(), grantLabel: vi.fn() }));
vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./herdr.js", async original => ({ ...await original<typeof import("./herdr.js")>(),
  validateTarget: vi.fn(), validateStartingTarget: vi.fn(), snapshot: vi.fn(), paneIdentity: vi.fn() }));

const target: Target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "codex",
  session: "aaaaaaaa-1111-4111-8111-111111111111" };
const text = "Review the parser";
let pane: Json, restore: () => void, sequence = 0, deliveryId: string;
const prompt = vi.fn(), sendKeys = vi.fn(), expectDelivery = vi.fn();
const deliveries = { expect: expectDelivery, queue: vi.fn(), status: vi.fn(() => ({ state: "unknown" })), sameMessage: vi.fn(() => true),
  delivered: vi.fn(), fail: vi.fn(), pending: vi.fn(() => false), awaitLate: vi.fn(async () => "pending") };
const held = { approval: vi.fn(), terminalPrompt: vi.fn(), servedQuestion: vi.fn() };
const readScreen = vi.fn(async () => "");
const context = { agentHooks: { deliveries, ...held }, modelSwitcher: { assertAvailable() {} },
  settingsSwitcher: { assertAvailable() {} }, permissionModeSwitcher: { assertAvailable() {} }, sideQuestions: { assertAvailable() {} } } as unknown as PaneRouteContext;
const hand = (where = target) => handOff({ target: where, text }, { deliveryId });

beforeEach(() => {
  deliveryId = `codex-delivery-${++sequence}`;
  pane = { workspace_id: target.workspace, tab_id: target.tab, pane_id: target.pane,
    terminal_id: "terminal-1", agent: "codex", agent_status: "idle" };
  vi.mocked(validateTarget).mockImplementation(async () => ({ ...pane }));
  vi.mocked(snapshot).mockImplementation(async () => ({ panes: [{ ...pane }] }));
  vi.mocked(paneIdentity).mockResolvedValue(target.session);
  vi.spyOn(codexServers, "forTarget").mockReturnValue(undefined);
  prompt.mockResolvedValue(undefined);
  expectDelivery.mockResolvedValue("pending");
  deliveries.status.mockReturnValue({ state: "unknown" }); deliveries.sameMessage.mockReturnValue(true);
  restore = setTerminalProvider({ prompt, sendKeys, readScreen } as unknown as TerminalProvider);
  vi.mocked(hookRequest).mockImplementation(async (route, body) => {
    if (route !== "/v1/hand-off") return {};
    const result = await paneRoute(context, new URL("http://phren.local/v1/prompt"), body!, {} as never) as Json;
    // The durable outbox treats a transport-only composer queue as uncertain.
    const { state: _, ...reply } = result;
    return reply.queued ? { ...reply, queued: false, deliveryUncertain: true } : reply;
  });
});
afterEach(() => { restore(); vi.restoreAllMocks(); vi.resetAllMocks(); });

describe("hand-off submission confirmation", () => {
  it.each(["idle", "working"])("does not call an accepted paste into a %s Codex pane delivered", async status => {
    pane.agent_status = status;
    expect(await hand()).toEqual({ ok: false, delivered: false, deliveryUncertain: true, target });
    // The same id replays the uncertain result, even if the turn is observed
    // later. No second paste, submit key or automatic retry is safe here.
    expectDelivery.mockResolvedValue("delivered");
    expect(await hand()).toMatchObject({ delivered: false, deliveryUncertain: true });
    expect(prompt).toHaveBeenCalledExactlyOnceWith(target.server, target.pane, text);
    expect(expectDelivery).toHaveBeenCalledExactlyOnceWith(target, text, status === "working" ? 300 : 1_500, expect.any(AbortSignal), deliveryId, "terminal-1");
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("confirms the receiving conversation's submission hook", async () => {
    expectDelivery.mockResolvedValue("delivered");
    expect(await hand()).toEqual({ ok: true, delivered: true, target });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("confirms an owned Codex server's message by Codex's UserPromptSubmit, without typing", async () => {
    const owned = { threadId: target.session } as NonNullable<ReturnType<typeof codexServers.forTarget>>;
    vi.mocked(codexServers.forTarget).mockReturnValue(owned);
    vi.spyOn(codexServers, "send").mockResolvedValue({ turnId: "turn-1" });
    expectDelivery.mockResolvedValue("delivered");
    expect(await hand()).toEqual({ ok: true, delivered: true, target });
    expect(codexServers.send).toHaveBeenCalledExactlyOnceWith(owned, text);
    expect(expectDelivery).toHaveBeenCalledExactlyOnceWith(target, text, 4_000, expect.any(AbortSignal), deliveryId, "terminal-1");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("answers an owned Codex server's message queued until its model takes it, not delivered on the turn id", async () => {
    // Codex 0.160 merges text sent during a turn into it and runs
    // UserPromptSubmit only at the model's next step, after the running tool call.
    const owned = { threadId: target.session, activeTurn: "turn-9" } as NonNullable<ReturnType<typeof codexServers.forTarget>>;
    vi.mocked(codexServers.forTarget).mockReturnValue(owned);
    vi.spyOn(codexServers, "send").mockResolvedValue({ turnId: "turn-9" });
    const send = () => paneRoute(context, new URL("http://phren.local/v1/prompt"), { target, text, deliveryId }, {} as never);
    expect(await send()).toEqual({ ok: true, queued: true, state: "queued", turnId: "turn-9" });
    expect(expectDelivery).toHaveBeenCalledExactlyOnceWith(target, text, 300, expect.any(AbortSignal), deliveryId, "terminal-1");
    expect(deliveries.queue).toHaveBeenCalledExactlyOnceWith(deliveryId, target);
  });

  it("keeps a lost app-server acknowledgement uncertain without a terminal fallback", async () => {
    vi.mocked(codexServers.forTarget).mockReturnValue({ threadId: target.session } as NonNullable<ReturnType<typeof codexServers.forTarget>>);
    vi.spyOn(codexServers, "prompt").mockRejectedValue(new Error("reply lost"));
    expect(await hand()).toMatchObject({ delivered: false, deliveryUncertain: true });
    await hand();
    expect(codexServers.prompt).toHaveBeenCalledTimes(1);
    expect(prompt).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("does not confirm the paste fallback when an owned server is unavailable", async () => {
    vi.mocked(codexServers.forTarget).mockReturnValue({ threadId: target.session } as NonNullable<ReturnType<typeof codexServers.forTarget>>);
    vi.spyOn(codexServers, "prompt").mockRejectedValue(new CodexServerUnavailable("offline"));
    expect(await hand()).toMatchObject({ delivered: false, deliveryUncertain: true });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("keeps a failed post-paste identity check uncertain", async () => {
    vi.mocked(snapshot).mockRejectedValue(new Error("snapshot unavailable"));
    expect(await hand()).toMatchObject({ delivered: false, deliveryUncertain: true });
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("does not retry a transport failure that may have written text", async () => {
    prompt.mockRejectedValue(new BridgeError(502, "reply lost"));
    await expect(hand()).rejects.toThrow("reply lost");
    await expect(hand()).rejects.toThrow("reply lost");
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(sendKeys).not.toHaveBeenCalled();
  });
});

describe("a prompt the terminal refused", () => {
  const send = () => paneRoute(context, new URL("http://phren.local/v1/prompt"), { target, text, deliveryId }, {} as never);
  it("drops its delivery record when Herdr refused it, so it holds nothing", async () => {
    prompt.mockRejectedValue(new BridgeError(409, "Herdr: pane w1:p1 is not an agent", { herdrCode: "agent_not_found" }));
    await expect(send()).rejects.toMatchObject({ status: 409 });
    expect(expectDelivery.mock.calls.map(call => (call[3] as AbortSignal).aborted)).toEqual([true]);
  });
});

describe("an idle Claude pane that turned working after the paste", () => {
  it("waits for its hook instead of pressing Enter again, and answers delivered when it comes", async () => {
    const claude = { ...target, source: "claude" as const };
    pane.agent = "claude";
    vi.mocked(snapshot).mockImplementation(async () => ({ panes: [{ ...pane, agent_status: "working" }] }));
    deliveries.awaitLate.mockResolvedValue("delivered");
    expect(await paneRoute(context, new URL("http://phren.local/v1/prompt"), { target: claude, text, deliveryId }, {} as never))
      .toEqual({ ok: true, delivered: true, state: "delivered" });
    expect(sendKeys).not.toHaveBeenCalled();
  });
});

describe("a hand-off to a Claude lead waiting on its background agents", () => {
  // Live: in "Waiting for 1 background agent to finish" Herdr reads the lead working, and pasted text plus
  // Enter submits at once. The Hook answered every hand-off "busy" until the agents ended, over an hour.
  const claude = { ...target, source: "claude" as const }, turn = { terminal: "terminal-1", source: "claude" as const, session: target.session };
  const send = () => paneRoute(context, new URL("http://phren.local/v1/prompt"), { target: claude, text, deliveryId, hookQueued: true }, {} as never);
  let bridge: string;
  beforeEach(async () => { bridge = await mkdtemp(path.join(tmpdir(), "phren-background-")); vi.stubEnv("PHREN_BRIDGE_HOME", bridge); pane.agent = "claude"; pane.agent_status = "working";
    readScreen.mockResolvedValue("✻ Waiting for 1 background agent to finish\n❯ "); });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(bridge, { recursive: true, force: true }); });

  it("is typed once its turn ended with background work, and confirmed by its hook", async () => {
    await noteTurn("default", target.pane, { event: "UserPromptSubmit", ...turn });
    await expect(send()).rejects.toMatchObject({ details: { code: "hand-off-busy" } });
    expect(prompt).not.toHaveBeenCalled();
    await noteTurn("default", target.pane, { event: "Stop", ...turn, background: 1 });
    expectDelivery.mockResolvedValue("delivered");
    expect(await send()).toEqual({ ok: true, delivered: true, state: "delivered" });
    expect(prompt).toHaveBeenCalledExactlyOnceWith(target.server, target.pane, text);
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("stays busy while that lead may have a dialog open: one the Hook holds, or one on its screen", async () => {
    // A background agent's finish starts a turn with no UserPromptSubmit; Enter would answer its dialog.
    await noteTurn("default", target.pane, { event: "UserPromptSubmit", ...turn });
    await noteTurn("default", target.pane, { event: "Stop", ...turn, background: 1 });
    held.approval.mockReturnValueOnce({ tool: "Bash" });
    await expect(send()).rejects.toMatchObject({ details: { code: "hand-off-busy" } });
    readScreen.mockResolvedValue(" Ready to code?\n ❯ 1. Yes, proceed\n   2. No, keep planning\n\n Esc to cancel");
    await expect(send()).rejects.toMatchObject({ details: { code: "hand-off-busy" } });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("stays busy for a working lead whose last Stop left nothing running", async () => {
    await noteTurn("default", target.pane, { event: "UserPromptSubmit", ...turn });
    await noteTurn("default", target.pane, { event: "Stop", ...turn });
    await expect(send()).rejects.toMatchObject({ details: { code: "hand-off-busy" } });
    expect(prompt).not.toHaveBeenCalled();
  });
});

describe("a hand-off that repeats a Claude pane's own prompt suggestion", () => {
  // Live: Claude draws its guess at the owner's next message dim in the empty input box. Read as plain
  // text it looks like an unsent owner message (Enter does not submit it), and a conductor relayed
  // three such guesses to their panes by hand-off as the owner's words.
  const claude = { ...target, source: "claude" as const };
  const suggested = readFileSync(new URL("./fixtures/claude/2.1.284/next-suggestion-herdr.ansi", import.meta.url), "utf8");
  const send = (words: string, hookQueued = true) => paneRoute(context, new URL("http://phren.local/v1/prompt"), { target: claude, text: words, deliveryId: `${deliveryId}-${++sequence}`, ...(hookQueued ? { hookQueued } : {}) }, {} as never);
  beforeEach(() => { pane.agent = "claude"; readScreen.mockResolvedValue(suggested); expectDelivery.mockResolvedValue("delivered"); });

  it("is refused before anything is typed", async () => {
    await expect(send("merged 313 and 314")).rejects.toMatchObject({ status: 409, details: { code: "prompt-suggestion" } });
    await expect(send("  Merged 313   and 314 ")).rejects.toMatchObject({ details: { code: "prompt-suggestion" } });
    expect(prompt).not.toHaveBeenCalled();
    expect(expectDelivery).not.toHaveBeenCalled();
  });

  it("does not stop other words, a phone message, or a pane whose screen cannot be read", async () => {
    expect(await send("check the release notes")).toMatchObject({ delivered: true });
    // The owner choosing the suggestion on the phone sends it as their own message.
    expect(await send("merged 313 and 314", false)).toMatchObject({ delivered: true });
    readScreen.mockRejectedValue(new Error("unreadable"));
    expect(await send("merged 313 and 314")).toMatchObject({ delivered: true });
    expect(prompt).toHaveBeenCalledTimes(3);
  });
});

describe("a queued message its own hook takes during the identity probe", () => {
  const send = () => paneRoute(context, new URL("http://phren.local/v1/prompt"), { target, text, deliveryId }, {} as never);

  it("is answered delivered, by its delivery id", async () => {
    // Unknown when the send arrives; taken while the Hook probes the pane.
    deliveries.status.mockReturnValueOnce({ state: "unknown" }).mockReturnValue({ state: "delivered" });
    expect(await send()).toEqual({ ok: true, delivered: true, state: "delivered" });
    expect(deliveries.status).toHaveBeenCalledWith(deliveryId, target);
    expect(deliveries.queue).not.toHaveBeenCalled();
  });

  it("is otherwise queued under its id", async () => {
    expect(await send()).toEqual({ ok: true, queued: true, state: "queued" });
    expect(deliveries.queue).toHaveBeenCalledExactlyOnceWith(deliveryId, target);
  });

  it("is still queued, and marked uncertain for older phones, when the identity probe fails", async () => {
    vi.mocked(paneIdentity).mockResolvedValue(undefined);
    expect(await send()).toEqual({ ok: true, deliveryUncertain: true, state: "queued" });
    expect(deliveries.queue).toHaveBeenCalledExactlyOnceWith(deliveryId, target);
  });
});

describe("a retried phone message, by its delivery id", () => {
  const send = (extra: Json = {}) => paneRoute(context, new URL("http://phren.local/v1/prompt"), { target, text, deliveryId, ...extra }, {} as never);

  it("answers a queued or delivered one with its state now and types nothing, even after a Hook restart", async () => {
    deliveries.status.mockReturnValue({ state: "queued" });
    expect(await send()).toEqual({ ok: true, queued: true, state: "queued", replayed: true });
    deliveries.status.mockReturnValue({ state: "delivered" });
    expect(await send()).toEqual({ ok: true, delivered: true, state: "delivered", replayed: true });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("types a failed one again under the same id", async () => {
    expect(await send()).toEqual({ ok: true, queued: true, state: "queued" });
    deliveries.status.mockReturnValueOnce({ state: "failed", reason: "The agent finished its turn without taking the message." });
    expect(await send()).toEqual({ ok: true, queued: true, state: "queued" });
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(expectDelivery.mock.calls.map(call => call[4])).toEqual([deliveryId, deliveryId]);
  });

  it("refuses the id for other words", async () => {
    deliveries.status.mockReturnValue({ state: "queued" });
    deliveries.sameMessage.mockReturnValue(false);
    await expect(send({ text: "Something else" })).rejects.toMatchObject({ status: 409 });
    expect(prompt).not.toHaveBeenCalled();
  });
});

describe("startup hand-off", () => {
  const notReady = () => new BridgeError(409, "Herdr: agent w1:p1 is not an active named agent", { herdrCode: "agent_not_ready" });

  it("waits for a fresh Claude session to become a named agent, then submits once", async () => {
    const claude = { ...target, source: "claude" as const };
    pane.agent = "claude";
    prompt.mockRejectedValueOnce(notReady()).mockRejectedValueOnce(notReady()).mockResolvedValue(undefined);
    expectDelivery.mockResolvedValue("delivered");
    expect(await hand(claude)).toEqual({ ok: true, delivered: true, target: claude });
    expect(prompt).toHaveBeenCalledTimes(3);
    expect(vi.mocked(validateTarget).mock.calls).toEqual([[claude, false, true], [claude, true, true], [claude, true, true]]);
    // Refused attempts must not consume the successful attempt's hook.
    expect(expectDelivery.mock.calls.map(call => (call[3] as AbortSignal).aborted)).toEqual([true, true, false]);
    await hand(claude);
    expect(prompt).toHaveBeenCalledTimes(3);
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("keeps an accepted but unconfirmed retry uncertain, with no more writes", async () => {
    prompt.mockRejectedValueOnce(notReady()).mockResolvedValue(undefined);
    expect(await hand()).toMatchObject({ delivered: false, deliveryUncertain: true });
    await hand();
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it.each(["conversation", "input screen", "terminal", "reservation"])("stops when the %s changes during startup", async change => {
    prompt.mockRejectedValueOnce(notReady());
    const refused = new BridgeError(409, `Changed ${change}`);
    if (change === "terminal") {
      vi.mocked(validateTarget).mockResolvedValueOnce({ ...pane }).mockResolvedValueOnce({ ...pane, terminal_id: "new-terminal" });
    } else if (change === "reservation") {
      const available = vi.spyOn(context.modelSwitcher, "assertAvailable");
      available.mockImplementationOnce(() => {}).mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw refused; });
    } else vi.mocked(validateTarget).mockResolvedValueOnce({ ...pane }).mockRejectedValueOnce(refused);
    await expect(hand()).rejects.toMatchObject({ status: 409 });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("retains the delivery guard after an ambiguous write and never retries it", async () => {
    prompt.mockRejectedValueOnce(notReady()).mockRejectedValue(new BridgeError(504, "reply lost"));
    await expect(hand()).rejects.toThrow("reply lost");
    await expect(hand()).rejects.toThrow("reply lost");
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(expectDelivery.mock.calls.map(call => (call[3] as AbortSignal).aborted)).toEqual([true, false]);
  });

  it("also revalidates a transcript-less starting target before retrying", async () => {
    const { session: _session, ...place } = target;
    const starting = { ...place, starting: true, startingToken: "a".repeat(64) };
    vi.mocked(validateStartingTarget).mockResolvedValueOnce({ ...pane })
      .mockRejectedValueOnce(new BridgeError(409, "The starting agent changed"));
    prompt.mockRejectedValueOnce(notReady());
    await expect(paneRoute(context, new URL("http://phren.local/v1/prompt"), { target: starting, text }, {} as never))
      .rejects.toMatchObject({ status: 409 });
    expect(validateStartingTarget).toHaveBeenCalledTimes(2);
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});

vi.mock("./terminal.js", async original => ({ ...await original<object>(), terminalPaneFromEnv: async () => undefined }));

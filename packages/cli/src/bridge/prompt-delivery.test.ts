import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hookRequest } from "./client.js";
import { CodexServerUnavailable, codexServers } from "./codex-servers.js";
import { handOff } from "./hand-off.js";
import { paneIdentity, snapshot, validateStartingTarget, validateTarget } from "./herdr.js";
import { BridgeError, type Json, type Target } from "./protocol.js";
import { paneRoute, type PaneRouteContext } from "./server-pane-routes.js";
import { setTerminalProvider, type TerminalProvider } from "./terminal.js";

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
const context = { agentHooks: { expectDelivery, trackDelivery: vi.fn() }, modelSwitcher: { assertAvailable() {} },
  settingsSwitcher: { assertAvailable() {} }, sideQuestions: { assertAvailable() {} } } as unknown as PaneRouteContext;
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
  restore = setTerminalProvider({ prompt, sendKeys } as unknown as TerminalProvider);
  vi.mocked(hookRequest).mockImplementation(async (route, body) => {
    if (route !== "/v1/hand-off") return {};
    const result = await paneRoute(context, new URL("http://phren.local/v1/prompt"), body!, {} as never) as Json;
    // The durable outbox treats a transport-only composer queue as uncertain.
    return result.queued ? { ...result, queued: false, deliveryUncertain: true } : result;
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
    expect(expectDelivery).toHaveBeenCalledExactlyOnceWith(target, text, status === "working" ? 300 : 1_500, expect.any(AbortSignal));
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("confirms the receiving conversation's submission hook", async () => {
    expectDelivery.mockResolvedValue("delivered");
    expect(await hand()).toEqual({ ok: true, delivered: true, target });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("confirms an owned Codex server's turn acknowledgement without typing", async () => {
    const owned = { threadId: target.session } as NonNullable<ReturnType<typeof codexServers.forTarget>>;
    vi.mocked(codexServers.forTarget).mockReturnValue(owned);
    vi.spyOn(codexServers, "prompt").mockResolvedValue({ turnId: "turn-1" });
    expect(await hand()).toEqual({ ok: true, delivered: true, target });
    expect(codexServers.prompt).toHaveBeenCalledExactlyOnceWith(owned, text);
    expect(prompt).not.toHaveBeenCalled();
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

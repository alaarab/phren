import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paneIdentity, snapshot, validateStartingTarget, validateTarget } from "./herdr.js";
import { PromptDeliveries } from "./prompt-deliveries.js";
import { type Json, type Target } from "./protocol.js";
import { paneRoute, type PaneRouteContext } from "./server-pane-routes.js";
import { setTerminalProvider, type TerminalProvider } from "./terminal.js";

vi.mock("./herdr.js", async original => ({ ...await original<typeof import("./herdr.js")>(),
  snapshot: vi.fn(), paneIdentity: vi.fn(), validateStartingTarget: vi.fn(), validateTarget: vi.fn() }));
const target: Target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "claude",
  session: "aaaaaaaa-1111-4111-8111-111111111111" };
const text = "Review the parser";
let id: string, sequence = 0;
const recorded = readFileSync(new URL("./fixtures/claude/2.1.284/owner-typing-tmux.ansi", import.meta.url), "utf8");
const input = (value: string) => recorded.replace("❯\u00a0x", `❯\u00a0${value}`);
let pane: Json, store: PromptDeliveries, context: PaneRouteContext, restore: () => void;
const prompt = vi.fn(), sendKeys = vi.fn(), readScreen = vi.fn(), question = vi.fn(), approval = vi.fn(), terminalPrompt = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  id = `phone-follow-up-${++sequence}`;
  pane = { workspace_id: target.workspace, tab_id: target.tab, pane_id: target.pane,
    terminal_id: "terminal-1", agent: "claude", agent_status: "working" };
  store = new PromptDeliveries(undefined, Date.now, async () => [], async () => 0);
  context = { agentHooks: { deliveries: store, approval, terminalPrompt, servedQuestion: question },
    modelSwitcher: { assertAvailable() {} }, settingsSwitcher: { assertAvailable() {} },
    permissionModeSwitcher: { assertAvailable() {} }, sideQuestions: { assertAvailable() {} } } as unknown as PaneRouteContext;
  vi.mocked(snapshot).mockImplementation(async () => ({ panes: [{ ...pane }] }));
  vi.mocked(validateTarget).mockImplementation(async () => ({ ...pane }));
  vi.mocked(paneIdentity).mockResolvedValue(target.session);
  readScreen.mockResolvedValue(input(text));
  restore = setTerminalProvider({ prompt, sendKeys, readScreen } as unknown as TerminalProvider);
});
afterEach(() => { restore(); vi.clearAllTimers(); vi.useRealTimers(); vi.resetAllMocks(); });
async function send() {
  const reply = paneRoute(context, new URL("http://phren.local/v1/prompt"), { target, text, deliveryId: id }, {} as never);
  await vi.advanceTimersByTimeAsync(1_500);
  expect(await reply).toMatchObject({ queued: true });
  expect(prompt).toHaveBeenCalledExactlyOnceWith(target.server, target.pane, text);
}

describe("queued phone delivery recovery", () => {
  it.each(["/login", "", "another draft", `${text} extra`, `${text} `, `\x1b[2m${text}\x1b[0m`])("does not submit changed or ambiguous input %j", async value => {
    await send(); pane.agent_status = "idle"; readScreen.mockResolvedValue(input(value));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(sendKeys).not.toHaveBeenCalled();
    expect(store.status(id, target)).toMatchObject({ state: "failed", reason: expect.any(String) });
  });
  it.each(["conversation", "terminal", "question", "approval", "terminal prompt", "blocked", "waiting", "unknown", "snapshot failure", "screen failure"])("stops when %s changes", async change => {
    await send(); pane.agent_status = "idle";
    if (change === "conversation") vi.mocked(paneIdentity).mockResolvedValue("bbbbbbbb-1111-4111-8111-111111111111");
    else if (change === "terminal") pane.terminal_id = "terminal-2";
    else if (change === "question") question.mockReturnValue({ question: "Continue?" });
    else if (change === "approval") approval.mockReturnValue({ tool: "Bash" });
    else if (change === "terminal prompt") terminalPrompt.mockReturnValue({ title: "Login" });
    else if (change === "snapshot failure") vi.mocked(snapshot).mockRejectedValue(new Error("unavailable"));
    else if (change === "screen failure") readScreen.mockRejectedValue(new Error("unavailable"));
    else pane.agent_status = change;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(sendKeys).not.toHaveBeenCalled();
    expect(store.status(id, target)).toMatchObject({ state: "failed", reason: expect.any(String) });
  });
  it("never submits an owner replacement made after the matching screen was read", async () => {
    await send(); pane.agent_status = "idle";
    let current = input(text);
    readScreen.mockImplementation(async () => {
      const observed = current;
      // The read response can already be stale when the Hook receives it.
      await Promise.resolve();
      current = input("/login");
      return observed;
    });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(current).toBe(input("/login"));
    expect(sendKeys).not.toHaveBeenCalled();
    expect(store.status(id, target)).toMatchObject({ state: "failed", reason: expect.any(String) });
  });
  it("reports unchanged visible text for manual submission when atomic submission is unavailable", async () => {
    await send(); pane.agent_status = "done";
    await vi.advanceTimersByTimeAsync(40_000);
    expect(sendKeys).not.toHaveBeenCalled();
    expect(store.status(id, target)).toMatchObject({ state: "failed", reason: expect.stringContaining("cannot be safely resubmitted") });
  });
  it("does not recover a settled delivery even while identical text is still pending", async () => {
    await send(); pane.agent_status = "idle";
    const another = store.expect(target, text, 1, undefined, `${id}-other`, "terminal-1");
    await vi.advanceTimersByTimeAsync(1); await another;
    store.queue(`${id}-other`, target);
    readScreen.mockImplementation(async () => { await store.submitted(target, text); return input(text); });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(sendKeys).not.toHaveBeenCalled();
    expect(store.status(id, target).state).toBe("delivered");
    expect(store.status(`${id}-other`, target).state).toBe("queued");
  });
  it.each(["status", "conversation", "question"])("never types when %s changes while reading the matching input", async change => {
    await send(); pane.agent_status = "idle";
    readScreen.mockImplementation(async () => {
      if (change === "status") pane.agent_status = "blocked";
      if (change === "conversation") vi.mocked(paneIdentity).mockResolvedValue("bbbbbbbb-1111-4111-8111-111111111111");
      if (change === "question") question.mockReturnValue({ question: "Continue?" });
      return input(text);
    });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(sendKeys).not.toHaveBeenCalled();
    expect(store.status(id, target)).toMatchObject({ state: "failed", reason: expect.any(String) });
  });
  it("confirms a submission hook during the finished window without typing", async () => {
    await send(); pane.agent_status = "idle";
    await vi.advanceTimersByTimeAsync(20_000);
    await store.submitted(target, text);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(sendKeys).not.toHaveBeenCalled();
    expect(store.status(id, target).state).toBe("delivered");
  });
  it("accepts a late submission after recovery stopped on login", async () => {
    await send(); pane.agent_status = "idle"; readScreen.mockResolvedValue(input("/login"));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(store.status(id, target).state).toBe("failed");
    await store.submitted(target, text);
    expect(store.status(id, target).state).toBe("delivered");
    expect(sendKeys).not.toHaveBeenCalled();
  });
  it.each(["wrapped", "multiline", "collapsed"])("leaves a %s long paste for manual verification without expanding or submitting it", async shape => {
    // Keep the recorded tmux frame and prompt separator, substituting only
    // the composer body to exercise text not available as one visible row.
    const words = shape === "wrapped" ? "Review the parser and explain every change" : "Review the parser\nand explain every change";
    const shown = shape === "collapsed" ? "[Pasted text #1 +2 lines]"
      : shape === "wrapped" ? "Review the parser and\n  explain every change" : words.replace("\n", "\n  ");
    const reply = paneRoute(context, new URL("http://phren.local/v1/prompt"), { target, text: words, deliveryId: id }, {} as never);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await reply).toMatchObject({ queued: true });
    pane.agent_status = "idle"; readScreen.mockResolvedValue(input(shown));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(store.status(id, target)).toMatchObject({ state: "failed", reason: expect.stringContaining("full message cannot be verified") });
    expect(sendKeys).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledExactlyOnceWith(target.server, target.pane, words);
    await store.submitted(target, words);
    expect(store.status(id, target).state).toBe("delivered");
  });
  it("starts its bounded observation window after a legitimate long turn finishes", async () => {
    await send(); await vi.advanceTimersByTimeAsync(120_000);
    expect(store.status(id, target).state).toBe("queued");
    pane.agent_status = "idle";
    await vi.advanceTimersByTimeAsync(29_000);
    expect(store.status(id, target).state).toBe("queued");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sendKeys).not.toHaveBeenCalled();
    expect(store.status(id, target)).toMatchObject({ state: "failed", reason: expect.any(String) });
  });
});

describe("immediate idle delivery recovery", () => {
  it.each(["idle", "done", "blocked", "waiting", "unknown"])("never answers login when the refreshed status is %s", async status => {
    pane.agent_status = "idle";
    prompt.mockImplementation(async () => { pane.agent_status = status; readScreen.mockResolvedValue(input("/login")); });
    const reply = paneRoute(context, new URL("http://phren.local/v1/prompt"), { target, text, deliveryId: id }, {} as never);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await reply).toMatchObject({ deliveryUncertain: true, state: "failed", reason: expect.any(String) });
    expect(prompt).toHaveBeenCalledExactlyOnceWith(target.server, target.pane, text);
    expect(sendKeys).not.toHaveBeenCalled();
  });
});

it("observes an unacknowledged first prompt without adding a recovery Enter", async () => {
  pane.agent_status = "idle";
  vi.mocked(validateStartingTarget).mockResolvedValue({ ...pane });
  const { session: _session, ...place } = target;
  const starting = { ...place, starting: true, startingToken: "a".repeat(64) };
  const reply = paneRoute(context, new URL("http://phren.local/v1/prompt"), { target: starting, text, deliveryId: id }, {} as never);
  await vi.advanceTimersByTimeAsync(40_000);
  expect(await reply).toMatchObject({ deliveryUncertain: true, unsubmitted: true });
  expect(prompt).toHaveBeenCalledExactlyOnceWith(target.server, target.pane, text);
  expect(sendKeys).not.toHaveBeenCalled();
});

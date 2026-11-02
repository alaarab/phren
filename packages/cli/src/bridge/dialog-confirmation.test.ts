import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => { process.env.PHREN_DIALOG_THROTTLE_MS = "60000"; });
import { AgentHooks } from "./agent-hooks.js";
import { rpc } from "./herdr.js";
import { dialogStatus, notePaneStatus, resetPaneStatus, settleBlockedPane } from "./pane-status.js";
import type { Target } from "./protocol.js";
vi.mock("./herdr.js", async original => ({ ...await original<typeof import("./herdr.js")>(), rpc: vi.fn() }));
const target: Target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "claude", session: "aaaaaaaa-1111-4111-8111-111111111111" };
const screen = "Do you want to proceed?\n❯ 1. Yes, proceed\n  2. No, keep planning\nEsc to cancel";
let hooks: AgentHooks;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); hooks = new AgentHooks(); vi.mocked(rpc).mockReset(); });
afterEach(() => { hooks.close(); resetPaneStatus(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("confirmation independent of a 60-second polling throttle", () => {
  it("publishes the card after a 300ms second read, coalescing concurrent callers", async () => {
    vi.mocked(rpc).mockResolvedValue({ read: { text: screen } });
    const first = hooks.syncTerminalDialog(target, true), second = hooks.syncTerminalDialog(target, true);
    await vi.advanceTimersByTimeAsync(299);
    expect(hooks.confirmedTerminalDialog(target)).toBe(false);
    expect(hooks.terminalPrompt(target)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);
    expect(hooks.confirmedTerminalDialog(target)).toBe(true);
    expect(hooks.terminalPrompt(target)?.choice).toMatchObject({ title: "Do you want to proceed?" });
    expect(rpc).toHaveBeenCalledTimes(2);
  });
  it("confirms tmux status on the same short schedule", async () => {
    const base = notePaneStatus("tmux", "p1", "terminal", "working");
    const read = vi.fn(async () => screen);
    const first = dialogStatus("tmux", "p1", "terminal", "claude", base, read);
    const second = dialogStatus("tmux", "p1", "terminal", "claude", base, read);
    await vi.advanceTimersByTimeAsync(299);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await first).toMatchObject({ status: "blocked" });
    expect(await second).toMatchObject({ status: "blocked" });
    expect(read).toHaveBeenCalledTimes(2);
  });
  it.each(["answer", "Stop"])("invalidates an in-flight tmux confirmation on %s", async event => {
    const base = notePaneStatus("tmux", "p1", "terminal", "working");
    let finish!: (value: string) => void;
    const read = vi.fn().mockResolvedValueOnce(screen).mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; }));
    const reading = dialogStatus("tmux", "p1", "terminal", "claude", base, read);
    await vi.advanceTimersByTimeAsync(300);
    if (event === "answer") settleBlockedPane("tmux", "p1", 0);
    else notePaneStatus("tmux", "p1", "terminal", "idle");
    finish(screen);
    await vi.advanceTimersByTimeAsync(1);
    expect(await reading).toMatchObject({ status: event === "answer" ? "working" : "idle" });
  });
  it("bounds a stalled second read and never publishes its late result", async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(rpc).mockResolvedValueOnce({ read: { text: screen } }).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const reading = hooks.syncTerminalDialog(target, true);
    await vi.advanceTimersByTimeAsync(700);
    await reading;
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(hooks.terminalPrompt(target)).toBeUndefined();
    finish({ read: { text: screen } });
    await vi.advanceTimersByTimeAsync(1);
    expect(hooks.confirmedTerminalDialog(target)).toBe(false);
    expect(hooks.terminalPrompt(target)).toBeUndefined();
  });
});

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { snapshot } from "./herdr.js";
import { TURN_ENDED_WITHOUT_IT } from "./prompt-deliveries.js";
import type { Json, Target } from "./protocol.js";
import { leaveClaudeSubagentView, retryAfterSubagentView } from "./server-pane-routes.js";
import { setTerminalProvider, type TerminalProvider } from "./terminal.js";

vi.mock("./herdr.js", async original => ({ ...await original<typeof import("./herdr.js")>(), snapshot: vi.fn() }));

// The owner's report (2026-10-21, Hub on omarchy): Claude Code showed a subagent's view, its input
// reading "Message @general-purpose…", so a phone message went to that subagent and failed when
// the turn ended ("The agent finished its turn without taking the message.").
const recorded = readFileSync(new URL("./fixtures/claude/2.1.284/next-suggestion-herdr.ansi", import.meta.url), "utf8");
const subagentView = recorded.replace("merged 313 and 314", "Message @general-purpose…");
const mainView = readFileSync(new URL("./fixtures/claude/2.1.284/empty-prompt-herdr.ansi", import.meta.url), "utf8");

const target: Target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "claude",
  session: "aaaaaaaa-1111-4111-8111-111111111111" };
const prompt = vi.fn(), sendKeys = vi.fn();
let restore: () => void;
let screens: string[];
const paneAnsi = vi.fn(async () => screens.length > 1 ? screens.shift()! : screens[0]);

beforeEach(() => {
  screens = [mainView];
  restore = setTerminalProvider({ prompt, sendKeys } as unknown as TerminalProvider);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => { restore(); vi.restoreAllMocks(); vi.resetAllMocks(); });

describe("a Claude pane showing a subagent's view", () => {
  it("is left with Escape before typing, and only then", async () => {
    screens = [subagentView, mainView];
    expect(await leaveClaudeSubagentView({ paneAnsi }, target, 0)).toBe(true);
    expect(sendKeys).toHaveBeenCalledTimes(1);
    expect(sendKeys).toHaveBeenCalledWith("default", "w1:p1", ["esc"]);
  });

  it("never presses Escape in the main view, where it would interrupt the turn", async () => {
    screens = [mainView];
    expect(await leaveClaudeSubagentView({ paneAnsi }, target, 0)).toBe(false);
    expect(sendKeys).not.toHaveBeenCalled();
    // Nor in a Codex pane, nor when the screen can't be read.
    expect(await leaveClaudeSubagentView({ paneAnsi }, { ...target, source: "codex" }, 0)).toBe(false);
    expect(await leaveClaudeSubagentView({ paneAnsi: async () => { throw new Error("gone"); } }, target, 0)).toBe(false);
    expect(await leaveClaudeSubagentView({} as never, target, 0)).toBe(false);
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("presses Escape at most twice when the view stays", async () => {
    screens = [subagentView];
    expect(await leaveClaudeSubagentView({ paneAnsi }, target, 0)).toBe(true);
    expect(sendKeys).toHaveBeenCalledTimes(2);
  });
});

describe("a phone message the turn ended without, with a subagent's view on screen", () => {
  const pane: Json = { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", terminal_id: "terminal-1", agent: "claude", agent_status: "idle" };
  const hooks = (status: () => Json, screen?: string) => {
    const expect = vi.fn(async () => "delivered");
    return { paneAnsi: screen === undefined ? paneAnsi : async () => screen,
      deliveries: { status: vi.fn(status), expect, awaitLate: vi.fn(async () => "pending") } };
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 30));

  it("leaves the view and types it again, once, under the same id", async () => {
    vi.mocked(snapshot).mockResolvedValue({ panes: [{ ...pane }] } as never);
    screens = [subagentView, mainView];
    const agentHooks = hooks(() => ({ state: "failed", reason: TURN_ENDED_WITHOUT_IT }));
    retryAfterSubagentView(agentHooks as never, target, "terminal-1", "Go for it", "delivery-1", 1, 600_000, 0);
    await settle();
    expect(sendKeys).toHaveBeenCalledWith("default", "w1:p1", ["esc"]);
    expect(agentHooks.deliveries.expect).toHaveBeenCalledWith(target, "Go for it", 1_500, undefined, "delivery-1", "terminal-1");
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith("default", "w1:p1", "Go for it");
  });

  it("types nothing again in the main view, for another failure, or once it was taken", async () => {
    vi.mocked(snapshot).mockResolvedValue({ panes: [{ ...pane }] } as never);
    const failed = () => ({ state: "failed", reason: TURN_ENDED_WITHOUT_IT });
    retryAfterSubagentView(hooks(failed, mainView) as never, target, "terminal-1", "Go", "d-2", 1, 600_000, 0);
    retryAfterSubagentView(hooks(() => ({ state: "failed", reason: "The agent's pane closed before it took the message." }), subagentView) as never,
      target, "terminal-1", "Go", "d-3", 1, 600_000, 0);
    retryAfterSubagentView(hooks(() => ({ state: "delivered" }), subagentView) as never, target, "terminal-1", "Go", "d-4", 1, 600_000, 0);
    // A different terminal in the pane is another agent: never retyped there.
    retryAfterSubagentView(hooks(failed, subagentView) as never, target, "terminal-2", "Go", "d-5", 1, 600_000, 0);
    await settle();
    expect(prompt).not.toHaveBeenCalled();
  });
});

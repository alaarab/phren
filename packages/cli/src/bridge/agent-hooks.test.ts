import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentHooks } from "./agent-hooks.js";
import { rpc, validateTarget } from "./herdr.js";
import type { Target } from "./protocol.js";

vi.mock("./herdr.js", async importOriginal => ({
  ...await importOriginal<typeof import("./herdr.js")>(), rpc: vi.fn(), validateTarget: vi.fn(),
}));

const target: Target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1",
  source: "codex", session: "aaaaaaaa-1111-4111-8111-111111111111" };

describe("verified terminal menu navigation", () => {
  let hooks: AgentHooks, highlight: number | undefined, ignored: number, loseHighlight: boolean;
  let title: string, labels: string[], shortcuts: boolean;
  const sent = () => vi.mocked(rpc).mock.calls.filter(call => call[1] === "agent.send_keys").map(call => call[2]?.keys);

  beforeEach(() => {
    hooks = new AgentHooks(); highlight = 0; ignored = 0; loseHighlight = false; shortcuts = false;
    title = "Choose permissions"; labels = ["Read only", "Ask for approval", "Full access"];
    vi.mocked(validateTarget).mockReset().mockResolvedValue({});
    vi.mocked(rpc).mockReset().mockImplementation(async (_server, method, params) => {
      if (method === "agent.read") return { read: { text: title + "\n" + labels.map((label, index) =>
        `${index === highlight ? "›" : " "} ${index + 1}. ${label}${shortcuts ? ` (${index + 1})` : ""}`).join("\n") } };
      if (method === "agent.send_keys") {
        if (ignored > 0) ignored--;
        else for (const key of params?.keys as string[]) {
          if (highlight !== undefined) highlight = Math.max(0, Math.min(2, highlight + (key === "down" ? 1 : -1)));
        }
        if (loseHighlight) highlight = undefined;
        return { ok: true };
      }
      throw new Error(`Unexpected RPC ${method}`);
    });
  });

  it.each([
    { from: 0, to: "3", arrows: [["down", "down"]] },
    { from: 2, to: "3", arrows: [] },
    { from: 2, to: "1", arrows: [["up", "up"]] },
  ])("moves from $from to option $to and only then permits Enter", async ({ from, to, arrows }) => {
    highlight = from;
    await hooks.syncTerminalDialog(target, true);
    expect(await hooks.dialogAnswerKeys(target, [to])).toEqual(["Enter"]);
    expect(highlight).toBe(Number(to) - 1);
    expect(sent()).toEqual(arrows);
    expect(vi.mocked(rpc).mock.calls.at(-1)?.[1]).toBe("agent.read");
  });

  it("calculates movement from the fresh cursor and retries a missed move once", async () => {
    await hooks.syncTerminalDialog(target, true);
    highlight = 1; ignored = 1;
    expect(await hooks.dialogAnswerKeys(target, ["3"])).toEqual(["Enter"]);
    expect(sent()).toEqual([["down"], ["down"]]);
    expect(highlight).toBe(2);
  });

  it.each(["stuck", "lost", "changed", "missing"])("refuses Enter for a %s selection", async mode => {
    await hooks.syncTerminalDialog(target, true);
    ignored = mode === "stuck" ? 2 : 0;
    loseHighlight = mode === "lost";
    if (mode === "changed") labels[2] = "A different option";
    if (mode === "missing") highlight = undefined;
    await expect(hooks.dialogAnswerKeys(target, ["3"])).rejects.toThrow("Open terminal");
    expect(sent()).toEqual(mode === "stuck" ? [["down", "down"], ["down", "down"]]
      : mode === "lost" ? [["down", "down"]] : []);
    expect(hooks.terminalPrompt(target)?.choice).toBeDefined();
  });

  it("publishes no choice without a readable cursor", async () => {
    highlight = undefined;
    await hooks.syncTerminalDialog(target, true);
    expect(hooks.terminalPrompt(target)).toBeUndefined();
    expect(sent()).toEqual([]);
  });

  it("refuses cursor movement when the pane has changed sessions", async () => {
    await hooks.syncTerminalDialog(target, true);
    vi.mocked(validateTarget).mockRejectedValue(new Error("Session changed"));
    await expect(hooks.dialogAnswerKeys(target, ["3"])).rejects.toThrow("Session changed");
    expect(sent()).toEqual([]);
  });

  it("refuses confirmation when the pane changes sessions during cursor movement", async () => {
    await hooks.syncTerminalDialog(target, true);
    vi.mocked(validateTarget).mockResolvedValueOnce({}).mockRejectedValue(new Error("Session changed"));
    await expect(hooks.dialogAnswerKeys(target, ["3"])).rejects.toThrow("Session changed");
    expect(sent()).toEqual([["down", "down"]]);
    expect(validateTarget).toHaveBeenLastCalledWith(target, false, true);
  });

  it("revalidates a shortcut confirmation after waiting for the permissions menu", async () => {
    title = "Enable full access?"; shortcuts = true;
    hooks.menuOpened(target, "/permissions");
    vi.mocked(validateTarget).mockRejectedValue(new Error("Session changed"));
    await expect(hooks.walkMenuConfirmation(target)).rejects.toThrow("Session changed");
    expect(sent()).toEqual([]);
  });

  it("keeps explicit digit shortcuts and their Enter unchanged", async () => {
    shortcuts = true; highlight = undefined;
    await hooks.syncTerminalDialog(target, true);
    expect(await hooks.dialogAnswerKeys(target, ["3"])).toEqual(["3", "Enter"]);
    expect(sent()).toEqual([]);
  });

  it("refuses unknown or batched option identifiers in a keyless menu", async () => {
    await hooks.syncTerminalDialog(target, true);
    await expect(hooks.dialogAnswerKeys(target, ["9"])).rejects.toThrow("Open terminal");
    await expect(hooks.dialogAnswerKeys(target, ["1", "3"])).rejects.toThrow("one terminal option");
    expect(sent()).toEqual([]);
  });
});

describe("terminal dialogs reach a phone with phren closed", () => {
  const dialog = "Would you like to run the following command?\n\n  $ rm -rf build\n\n› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)";
  let hooks: AgentHooks, notify: ReturnType<typeof vi.fn>, screen: string;
  const pane = { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: "codex", agent_status: "blocked" };
  const resolve = async () => target;
  const keys = () => vi.mocked(rpc).mock.calls.filter(call => call[1] === "agent.send_keys").map(call => call[2]?.keys);

  beforeEach(() => {
    hooks = new AgentHooks(); screen = dialog;
    notify = vi.fn(async () => true);
    (hooks as unknown as { push: unknown }).push = { available: true, notify, status: { configured: true } };
    vi.mocked(validateTarget).mockReset().mockResolvedValue({});
    vi.mocked(rpc).mockReset().mockImplementation(async (_server, method) => {
      if (method === "agent.read") return { read: { text: screen } };
      if (method === "agent.send_keys") return { ok: true };
      throw new Error(`Unexpected RPC ${method}`);
    });
  });

  it("pushes a waiting pane's dialog once, and Approve from the notification types its yes row", async () => {
    await hooks.observeWaitingPanes("default", [pane], resolve);
    await hooks.observeWaitingPanes("default", [pane], resolve);
    expect(notify).toHaveBeenCalledTimes(1);
    const sentPush = notify.mock.calls[0][0] as { binding: string; provider: string; title: string; message: string };
    expect(sentPush.provider).toBe("codex");
    expect(sentPush.title).toBe("Codex needs your approval");
    expect(sentPush.message).toContain("rm -rf build");
    await hooks.answerPush(sentPush.binding, "approve");
    expect(keys()).toEqual([["y"]]);
    await expect(hooks.answerPush(sentPush.binding, "approve")).rejects.toThrow(/no longer pending/);
  });

  it("Deny types the dialog's no row", async () => {
    await hooks.observeWaitingPanes("default", [pane], resolve);
    await hooks.answerPush((notify.mock.calls[0][0] as { binding: string }).binding, "deny");
    expect(keys()).toEqual([["esc"]]);
  });

  it("drops the push when the pane stops waiting", async () => {
    await hooks.observeWaitingPanes("default", [pane], resolve);
    const binding = (notify.mock.calls[0][0] as { binding: string }).binding;
    await hooks.observeWaitingPanes("default", [{ ...pane, agent_status: "working" }], resolve);
    await expect(hooks.answerPush(binding, "approve")).rejects.toThrow(/no longer pending/);
    expect(keys()).toEqual([]);
  });

  it("sends nothing while no phone is registered for push", async () => {
    (hooks as unknown as { push: unknown }).push = { available: false, notify, status: { configured: false } };
    await hooks.observeWaitingPanes("default", [pane], resolve);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("a permission left in the terminal after its hook let go", () => {
  const claude: Target = { ...target, source: "claude" };
  const screen = " Tool use\n\n   phren - Add Task Tool: (MCP)\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend";
  const pane = { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: "claude", agent_status: "blocked" };
  let hooks: AgentHooks;

  beforeEach(() => {
    hooks = new AgentHooks();
    (hooks as unknown as { push: unknown }).push = { available: false, notify: vi.fn(), status: { configured: false } };
    vi.mocked(validateTarget).mockReset().mockResolvedValue({});
    vi.mocked(rpc).mockReset().mockImplementation(async (_server, method) => {
      if (method === "agent.read") return { read: { text: screen } };
      throw new Error(`Unexpected RPC ${method}`);
    });
    (hooks as unknown as { rememberTerminalPrompt(target: Target, body: unknown): void })
      .rememberTerminalPrompt(claude, { tool: "mcp__phren__add_task", input: { project: "global", item: ["Check"] } });
  });

  it("keeps the request's details, answers with the pane's rows and marks the tab as needing permission", async () => {
    expect(hooks.pendingPanes("default", { panes: [pane] }).has("w1:p1")).toBe(false);
    await hooks.observeWaitingPanes("default", [pane], async () => claude);
    const prompt = hooks.terminalPrompt(claude);
    expect(prompt?.toolName).toBe("mcp__phren__add_task");
    expect(prompt?.choice).toMatchObject({ title: "Do you want to proceed?", options: [{ label: "Yes", key: "1" }, { label: "No", key: "2" }, { key: "Escape" }] });
    // Claude takes the digit alone; an Enter could approve the next ask.
    expect(await hooks.dialogAnswerKeys(claude, ["1"])).toEqual(["1"]);
    expect(hooks.pendingPanes("default", { panes: [pane] }).has("w1:p1")).toBe(true);
    expect(hooks.pendingPanes("default", { panes: [{ ...pane, agent_status: "working" }] }).size).toBe(0);
  });
});

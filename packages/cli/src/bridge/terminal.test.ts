import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentHooks } from "./agent-hooks.js";
import { rpc, validateTarget } from "./herdr.js";
import { readPaneText } from "./pane-text.js";
import type { Target } from "./protocol.js";
import { setTerminalProvider, terminalProvider, type ScreenRead, type TerminalProvider } from "./terminal.js";
import { herdrPanes, herdrTerminal } from "./terminal-herdr.js";

vi.mock("./herdr.js", async importOriginal => ({
  ...await importOriginal<typeof import("./herdr.js")>(), rpc: vi.fn(), validateTarget: vi.fn(),
}));

const target: Target = { server: "work", workspace: "w1", tab: "w1:t1", pane: "%3",
  source: "codex", session: "aaaaaaaa-1111-4111-8111-111111111111" };

/** A multiplexer that knows nothing about agents: a screen and a key log. */
function fakeTerminal(screen: () => string): TerminalProvider & { keys: string[][]; reads: ScreenRead[] } {
  const keys: string[][] = [], reads: ScreenRead[] = [];
  const refuse = async () => { throw new Error("not used"); };
  return { kind: "fake", keys, reads, ping: async () => {}, listPanes: async () => [],
    processes: async () => ({ foregroundPids: [] }),
    readScreen: async (_server, _pane, read) => { reads.push(read); return screen(); },
    sendKeys: async (_server, _pane, sent) => { keys.push(sent); },
    prompt: refuse, create: refuse, startAgent: refuse, focusPane: refuse, groupAction: refuse };
}

describe("the Hook through a terminal provider", () => {
  let restore: () => void;
  beforeEach(() => { vi.mocked(rpc).mockReset().mockRejectedValue(new Error("Herdr must not be called")); vi.mocked(validateTarget).mockReset().mockResolvedValue({}); });
  afterEach(() => restore?.());

  it("walks a terminal menu with reads and keys from the provider, never Herdr", async () => {
    let highlight = 0;
    const labels = ["Read only", "Ask for approval", "Full access"];
    const fake = fakeTerminal(() => "Choose permissions\n" + labels.map((label, index) => `${index === highlight ? "›" : " "} ${index + 1}. ${label}`).join("\n"));
    fake.sendKeys = async (_server, _pane, sent) => { fake.keys.push(sent); for (const key of sent) highlight += key === "down" ? 1 : -1; };
    restore = setTerminalProvider(fake);
    expect(terminalProvider()).toBe(fake);
    const hooks = new AgentHooks();
    await hooks.syncTerminalDialog(target, true);
    expect(await hooks.dialogAnswerKeys(target, ["3"])).toEqual(["Enter"]);
    expect(fake.keys).toEqual([["down", "down"]]);
    expect(fake.reads.every(read => read.scope === "agent" && read.source === "visible")).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("reads optional pane text as empty when the provider fails, and passes the read through", async () => {
    const fake = fakeTerminal(() => { throw new Error("gone"); });
    restore = setTerminalProvider(fake);
    expect(await readPaneText("work", "%3", { scope: "pane", source: "recent", lines: 40, format: "ansi", what: "Test read" })).toBe("");
    expect(fake.reads).toEqual([{ scope: "pane", source: "recent", lines: 40, format: "ansi" }]);
    restore();
    expect(terminalProvider()).toBe(herdrTerminal);
  });
});

describe("the Herdr provider", () => {
  beforeEach(() => { vi.mocked(rpc).mockReset().mockResolvedValue({}); });

  it("sends exactly the Herdr requests the Hook sent before the provider existed", async () => {
    vi.mocked(rpc).mockImplementation(async (_server, method) => method === "agent.read" ? { read: { text: "screen" } }
      : method === "pane.process_info" ? { process_info: { shell_pid: 10, foreground_processes: [{ pid: 12 }, { pid: "x" }, { pid: 11 }] } } : {});
    const signal = new AbortController().signal;
    expect(await herdrTerminal.readScreen("s", "p", { scope: "agent", source: "visible", lines: 40, timeoutMs: 2_000 })).toBe("screen");
    await herdrTerminal.readScreen("s", "p", { scope: "pane", source: "recent", lines: 40, stripAnsi: false, format: "ansi" });
    await herdrTerminal.sendKeys("s", "p", ["esc"]);
    await herdrTerminal.prompt("s", "p", "hi");
    await herdrTerminal.prompt("s", "p", "hi", signal);
    expect(await herdrTerminal.processes("s", "p")).toEqual({ shellPid: 10, foregroundPids: [12, 11] });
    await herdrTerminal.create("s", { workspace: "w", label: "L", cwd: "/tmp" });
    await herdrTerminal.create("s", { label: "L", cwd: "/tmp" });
    await herdrTerminal.startAgent("s", "p", { name: "n", kind: "claude", args: [], timeoutMs: 1_000 });
    await herdrTerminal.focusPane("s", "p");
    await herdrTerminal.groupAction("s", "rename", { workspace: "w", tab: "t" }, "New");
    await herdrTerminal.groupAction("s", "close", { workspace: "w" });
    await herdrTerminal.ping("s");
    expect(vi.mocked(rpc).mock.calls).toStrictEqual([
      ["s", "agent.read", { target: "p", source: "visible", lines: 40, strip_ansi: true }, undefined, 2_000],
      ["s", "pane.read", { pane_id: "p", source: "recent", lines: 40, strip_ansi: false, format: "ansi" }, undefined, undefined],
      ["s", "agent.send_keys", { target: "p", keys: ["esc"] }],
      ["s", "agent.prompt", { target: "p", text: "hi" }],
      ["s", "agent.prompt", { target: "p", text: "hi" }, signal],
      ["s", "pane.process_info", { pane_id: "p" }],
      ["s", "tab.create", { workspace_id: "w", label: "L", cwd: "/tmp", focus: false, env: {} }],
      ["s", "workspace.create", { workspace_id: undefined, label: "L", cwd: "/tmp", focus: false, env: {} }],
      ["s", "agent.start", { name: "n", kind: "claude", pane_id: "p", timeout_ms: 1_000 }, undefined, 6_000],
      ["s", "pane.focus", { pane_id: "p" }],
      ["s", "tab.rename", { tab_id: "t", label: "New" }],
      ["s", "workspace.close", { workspace_id: "w" }],
      ["s", "ping"],
    ]);
  });

  it("lists panes with Herdr's agent report as hints, and none for a plain shell", () => {
    const s = { panes: [
      { pane_id: "p1", tab_id: "t1", workspace_id: "w1", agent: "claude", agent_status: "idle", foreground_cwd: "/repo", cwd: "/", terminal_title_stripped: "Claude",
        agent_session: { kind: "id", agent: "claude", value: "aaaaaaaa-1111-4111-8111-111111111111" } },
      // A report naming another agent is not this pane's conversation.
      { pane_id: "p2", tab_id: "t1", workspace_id: "w1", agent: "codex", agent_session: { kind: "id", agent: "claude", value: "x" } },
      { pane_id: "p3", tab_id: "t1", workspace_id: "w1", cwd: "/home", label: "shell" },
      { pane_id: 4, tab_id: "t1", workspace_id: "w1" },
    ] };
    expect(herdrPanes("default", s)).toEqual([
      { server: "default", workspace: "w1", tab: "t1", pane: "p1", cwd: "/repo", title: "Claude", label: undefined,
        hints: { agent: "claude", status: "idle", session: "aaaaaaaa-1111-4111-8111-111111111111" } },
      { server: "default", workspace: "w1", tab: "t1", pane: "p2", cwd: undefined, title: undefined, label: undefined,
        hints: { agent: "codex", status: undefined, session: undefined } },
      { server: "default", workspace: "w1", tab: "t1", pane: "p3", cwd: "/home", title: undefined, label: "shell" },
    ]);
  });
});

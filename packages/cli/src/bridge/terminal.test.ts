import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentHooks } from "./agent-hooks.js";
import { rpc, validateTarget } from "./herdr.js";
import { readPaneText } from "./pane-text.js";
import type { Target } from "./protocol.js";
import { routedTerminal, setTerminalProvider, terminalProvider, type ScreenRead, type TerminalProvider } from "./terminal.js";
import { herdrPanes, herdrTerminal, phrenCommandLine } from "./terminal-herdr.js";
import { BridgeError } from "./protocol.js";

vi.mock("./herdr.js", async importOriginal => ({
  ...await importOriginal<typeof import("./herdr.js")>(), rpc: vi.fn(), validateTarget: vi.fn(),
}));

const target: Target = { server: "work", workspace: "w1", tab: "w1:t1", pane: "%3",
  source: "codex", session: "aaaaaaaa-1111-4111-8111-111111111111" };

/** A multiplexer that knows nothing about agents: a screen and a key log. */
function fakeTerminal(screen: () => string): TerminalProvider & { keys: string[][]; reads: ScreenRead[] } {
  const keys: string[][] = [], reads: ScreenRead[] = [];
  const refuse = async () => { throw new Error("not used"); };
  return { kind: "fake", keys, reads, ping: async () => {}, snapshot: async () => ({}), listPanes: async () => [],
    processes: async () => ({ foregroundPids: [] }),
    readScreen: async (_server, _pane, read) => { reads.push(read); return screen(); },
    sendKeys: async (_server, _pane, sent) => { keys.push(sent); },
    prompt: refuse, create: refuse, startAgent: refuse, focusPane: refuse, renamePane: refuse, groupAction: refuse };
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
    expect(terminalProvider()).toBe(routedTerminal);
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
    await herdrTerminal.create("s", { label: "L", cwd: "/tmp", env: { PHREN_DISPATCH_ID: "dispatch-1" } });
    await herdrTerminal.startAgent("s", "p", { name: "n", kind: "claude", args: [], timeoutMs: 1_000 });
    await herdrTerminal.focusPane("s", "p");
    await herdrTerminal.renamePane("s", "p", "Named");
    await herdrTerminal.groupAction("s", "rename", { workspace: "w", tab: "t" }, "New");
    await herdrTerminal.groupAction("s", "close", { workspace: "w" });
    await herdrTerminal.ping("s");
    await herdrTerminal.snapshot("s");
    expect(vi.mocked(rpc).mock.calls).toStrictEqual([
      ["s", "agent.read", { target: "p", source: "visible", lines: 40, strip_ansi: true }, undefined, 2_000],
      ["s", "pane.read", { pane_id: "p", source: "recent", lines: 40, strip_ansi: false, format: "ansi" }, undefined, undefined],
      ["s", "agent.send_keys", { target: "p", keys: ["esc"] }],
      ["s", "agent.prompt", { target: "p", text: "hi" }],
      ["s", "agent.prompt", { target: "p", text: "hi" }, signal],
      ["s", "pane.process_info", { pane_id: "p" }],
      ["s", "tab.create", { workspace_id: "w", label: "L", cwd: "/tmp", focus: false, env: {} }],
      ["s", "workspace.create", { workspace_id: undefined, label: "L", cwd: "/tmp", focus: false, env: { PHREN_DISPATCH_ID: "dispatch-1" } }],
      ["s", "agent.start", { name: "n", kind: "claude", pane_id: "p", timeout_ms: 1_000 }, undefined, 6_000],
      ["s", "pane.focus", { pane_id: "p" }],
      ["s", "pane.rename", { pane_id: "p", label: "Named" }],
      ["s", "tab.rename", { tab_id: "t", label: "New" }],
      ["s", "workspace.close", { workspace_id: "w" }],
      ["s", "ping"],
      ["s", "session.snapshot"],
    ]);
  });

  it("types phren agent at the pane's shell, waits for it, then reports and names it", async () => {
    let polls = 0;
    vi.mocked(rpc).mockImplementation(async (_server, method) => {
      if (method !== "pane.process_info") return {};
      // The shell holds the foreground before the command and for one poll after it.
      const agent = polls++ >= 2;
      return { process_info: { shell_pid: 10, foreground_process_group_id: agent ? 20 : 10,
        foreground_processes: [agent ? { pid: 20, cmdline: "node /opt/homebrew/bin/phren agent -i --model it's" } : { pid: 10, cmdline: "-zsh" }] } };
    });
    await herdrTerminal.startAgent("s", "w1:p1", { name: "worker", kind: "phren", args: ["agent", "-i", "--model", "it's"], timeoutMs: 5_000 });
    const calls = vi.mocked(rpc).mock.calls.filter(call => call[1] !== "pane.process_info");
    expect(calls).toStrictEqual([
      ["s", "pane.send_text", { pane_id: "w1:p1", text: `phren agent -i --model 'it'\\''s'; herdr pane release-agent "$HERDR_PANE_ID" --source phren-hook --agent phren >/dev/null 2>&1` }],
      ["s", "pane.send_keys", { pane_id: "w1:p1", keys: ["Enter"] }],
      ["s", "pane.report_agent", { pane_id: "w1:p1", source: "phren-hook", agent: "phren", state: "idle" }],
      ["s", "agent.rename", { target: "w1:p1", name: "worker" }],
    ]);
    expect(vi.mocked(rpc).mock.calls.some(call => call[1] === "agent.start")).toBe(false);
  });

  it("refuses a busy pane for phren agent the way Herdr does, so the launch waits for the shell", async () => {
    vi.mocked(rpc).mockImplementation(async () => ({ process_info: { shell_pid: 10, foreground_process_group_id: 30, foreground_processes: [{ pid: 30, cmdline: "zsh -l" }] } }));
    const refused = await herdrTerminal.startAgent("s", "p", { name: "n", kind: "phren", args: ["agent", "-i"], timeoutMs: 5_000 }).catch(error => error);
    expect(refused).toBeInstanceOf(BridgeError);
    expect(refused.details).toEqual({ herdrCode: "agent_pane_busy" });
    expect(vi.mocked(rpc).mock.calls.map(call => call[1])).toEqual(["pane.process_info"]);
  });

  it("quotes only the words that need it", () => {
    expect(phrenCommandLine(["agent", "-i", "--model", "openrouter/deepseek/v4:free"])).toMatch(/^phren agent -i --model openrouter\/deepseek\/v4:free; /);
    expect(phrenCommandLine(["agent", "--model", "a b; rm -rf ~"])).toMatch(/^phren agent --model 'a b; rm -rf ~'; /);
  });

  it("prompts and sends keys to a reported phren pane through the pane, never another agent", async () => {
    const unnamed = new BridgeError(409, "Herdr: agent p is not an active named agent", { herdrCode: "agent_not_ready" });
    let agent = "phren";
    vi.mocked(rpc).mockImplementation(async (_server, method) => {
      if (method === "agent.prompt" || method === "agent.send_keys") throw unnamed;
      return method === "pane.get" ? { pane: { pane_id: "p", agent } } : {};
    });
    await herdrTerminal.prompt("s", "p", "line one\nline two");
    await herdrTerminal.sendKeys("s", "p", ["esc"]);
    expect(vi.mocked(rpc).mock.calls.filter(call => call[1].startsWith("pane.send"))).toStrictEqual([
      ["s", "pane.send_text", { pane_id: "p", text: "\x1b[200~line one\nline two\x1b[201~" }, undefined],
      ["s", "pane.send_keys", { pane_id: "p", keys: ["Enter"] }, undefined],
      ["s", "pane.send_keys", { pane_id: "p", keys: ["esc"] }],
    ]);
    // Any other pane keeps Herdr's refusal.
    agent = "claude";
    await expect(herdrTerminal.prompt("s", "p", "hi")).rejects.toBe(unnamed);
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

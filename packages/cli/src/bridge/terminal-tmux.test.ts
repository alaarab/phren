import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
// Identity reads the open files of a pane's processes with lsof; the test
// answers for it.
const state = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(),
  execFile: Object.assign(() => {}, { [Symbol.for("nodejs.util.promisify.custom")]: state.exec }),
}));
import { agentFromCommand, fromTmuxId, parsePanes, sendKeysCalls, setTmuxDeps, tmuxKey, tmuxPaneFromEnv, tmuxServerName, tmuxServers,
  tmuxSnapshot, tmuxSocketName, tmuxTerminal, toTmuxId } from "./terminal-tmux.js";
import { notePaneStatus, paneStatus, resetPaneStatus, settleBlockedPane } from "./pane-status.js";
import { terminalKind } from "./terminal.js";
import { paneChatState, paneIdentity, resetSharedHerdrState, servers, validateTarget } from "./herdr.js";
import { bindingPath } from "./agent-hook-stores.js";
import type { Target } from "./protocol.js";

const SESSION = "aaaaaaaa-1111-4111-8111-111111111111";
const row = (values: Record<string, string>) => ["session_id", "session_name", "session_attached", "session_activity", "window_id", "window_name",
  "window_active", "pane_id", "pane_pid", "pane_tty", "pane_active", "pane_current_path", "pane_current_command", "@phren_agent", "pane_title"]
  .map(field => values[field] ?? "").join("\t");

/** A tmux server with one attached session: Claude in one window, a shell in another. */
const PANES = [
  row({ session_id: "$1", session_name: "work", session_attached: "1", session_activity: "200", window_id: "@1", window_name: "claude", window_active: "1",
    pane_id: "%1", pane_pid: "500", pane_tty: "/dev/ttys001", pane_active: "1", pane_current_path: "/repo", pane_current_command: "2.1.3", pane_title: "✳ Fix the tests" }),
  row({ session_id: "$1", session_name: "work", session_attached: "1", session_activity: "200", window_id: "@2", window_name: "zsh", window_active: "0",
    pane_id: "%2", pane_pid: "600", pane_tty: "/dev/ttys002", pane_active: "1", pane_current_path: "/home", pane_current_command: "zsh" }),
  "garbage line",
].join("\n");
const PS = [
  "  500   500   510 ttys001  -zsh",
  "  510   510   510 ttys001  /Users/me/.local/share/claude/versions/2.1.3 --effort high",
  "  511   510   510 ttys001  /bin/sh -c git status",
  "  600   600   600 ttys002  -zsh",
  "  700   700   700 ttys009  vim",
].join("\n");

function fakeTmux(overrides: { panes?: string; ps?: string; fail?: (args: string[]) => Error | undefined } = {}) {
  const calls: { socket: string; args: string[]; input?: string }[] = [];
  const restore = setTmuxDeps({
    binary: () => "/usr/bin/tmux",
    version: async () => "tmux 3.4\n",
    processes: async () => overrides.ps ?? PS,
    sleep: async () => {},
    run: async (socket, args, options = {}) => {
      calls.push({ socket, args, ...(options.input !== undefined ? { input: options.input } : {}) });
      const failure = overrides.fail?.(args);
      if (failure) throw failure;
      if (args[0] === "list-panes") return overrides.panes ?? PANES;
      if (args[0] === "display-message") return "$1\t@2\n";
      return "";
    },
  });
  return { calls, restore };
}

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; resetPaneStatus(); resetSharedHerdrState(); vi.unstubAllEnvs(); });

describe("tmux names and ids", () => {
  it("maps Hook server names to tmux sockets and back", () => {
    expect(tmuxSocketName("tmux")).toBe("default");
    expect(tmuxSocketName("tmux-phren")).toBe("phren");
    expect(tmuxSocketName("default")).toBeUndefined();
    expect(tmuxSocketName("tmuxer")).toBeUndefined();
    expect(tmuxServerName("default")).toBe("tmux");
    expect(tmuxServerName("phren")).toBe("tmux-phren");
    expect(tmuxServerName("bad name")).toBeUndefined();
    expect(fromTmuxId("$3")).toBe("s3"); expect(fromTmuxId("@5")).toBe("w5"); expect(fromTmuxId("%12")).toBe("p12");
    expect(fromTmuxId("%x")).toBeUndefined();
    expect(toTmuxId("p12", "p")).toBe("%12");
    expect(() => toTmuxId("w5", "p")).toThrow(/changed/);
    expect(() => toTmuxId("p1; kill-server", "p")).toThrow(/changed/);
  });

  it("names the agent from a pane's command line", () => {
    expect(agentFromCommand("claude --effort high")).toBe("claude");
    expect(agentFromCommand("/Users/me/.local/share/claude/versions/2.1.3")).toBe("claude");
    expect(agentFromCommand("node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js")).toBe("claude");
    expect(agentFromCommand("node /opt/bin/codex --model x")).toBe("codex");
    expect(agentFromCommand("/usr/lib/node_modules/@openai/codex/vendor/codex/codex")).toBe("codex");
    expect(agentFromCommand("/home/me/.opencode/bin/opencode")).toBe("opencode");
    expect(agentFromCommand("node /usr/lib/node_modules/@github/copilot/index.js")).toBe("copilot");
    expect(agentFromCommand("phren-agent")).toBe("phren");
    expect(agentFromCommand("-zsh")).toBeUndefined();
    expect(agentFromCommand("vim claude.md")).toBeUndefined();
  });

  it("skips list-panes rows that are not whole", () => {
    expect(parsePanes(PANES).map(r => r.pane_id)).toEqual(["%1", "%2"]);
  });
});

describe("the tmux snapshot", () => {
  it("has the Hook's snapshot shape, with the agent found from the foreground processes", async () => {
    ({ restore } = fakeTmux());
    const s = await tmuxSnapshot("tmux");
    expect(s.workspaces).toEqual([{ workspace_id: "s1", label: "work" }]);
    expect(s.tabs).toEqual([{ tab_id: "w1", workspace_id: "s1", label: "claude", agent_status: "unknown" }, { tab_id: "w2", workspace_id: "s1", label: "zsh" }]);
    expect(s.panes).toEqual([
      { pane_id: "p1", tab_id: "w1", workspace_id: "s1", terminal_id: "p1:500", cwd: "/repo", foreground_cwd: "/repo", title: "✳ Fix the tests",
        agent: "claude", agent_status: "unknown" },
      { pane_id: "p2", tab_id: "w2", workspace_id: "s1", terminal_id: "p2:600", cwd: "/home", foreground_cwd: "/home", title: undefined },
    ]);
    expect([s.focused_workspace_id, s.focused_tab_id, s.focused_pane_id]).toEqual(["s1", "w1", "p1"]);
  });

  it("takes the agent's status from its lifecycle events, per terminal", async () => {
    ({ restore } = fakeTmux());
    notePaneStatus("tmux", "p1", "p1:500", "working");
    let s = await tmuxSnapshot("tmux");
    expect((s.panes as { agent_status?: string }[])[0].agent_status).toBe("working");
    expect((s.tabs as { agent_status?: string }[])[0].agent_status).toBe("working");
    // A new shell in the same pane is a different terminal.
    notePaneStatus("tmux", "p1", "p1:499", "blocked");
    s = await tmuxSnapshot("tmux");
    expect((s.panes as { agent_status?: string }[])[0].agent_status).toBe("unknown");
  });

  it("answers an empty hidden server before its first launch, and refuses a stopped default one", async () => {
    const { BridgeError } = await import("./protocol.js");
    ({ restore } = fakeTmux({ fail: args => args[0] === "list-panes" ? new BridgeError(503, "tmux is not running on this computer.", { code: "not_running" }) : undefined }));
    expect(await tmuxSnapshot("tmux-phren")).toEqual({ workspaces: [], tabs: [], panes: [], agents: [] });
    await expect(tmuxSnapshot("tmux")).rejects.toThrow(/not running/);
  });
});

describe("the tmux provider", () => {
  it("maps the Hook's key names to tmux keys, literal characters with -l", () => {
    expect(tmuxKey("enter")).toBe("Enter"); expect(tmuxKey("esc")).toBe("Escape"); expect(tmuxKey("alt+Up")).toBe("M-Up");
    expect(tmuxKey("ctrl+c")).toBe("C-c"); expect(tmuxKey("y")).toBeUndefined();
    expect(() => tmuxKey("launch-missiles")).toThrow(/not supported/);
    expect(sendKeysCalls("%1", ["esc", "down", "down", "2", "enter"])).toEqual([
      ["send-keys", "-t", "%1", "Escape", "Down", "Down"], ["send-keys", "-t", "%1", "-l", "--", "2"], ["send-keys", "-t", "%1", "Enter"]]);
    expect(sendKeysCalls("%1", ["h", "i", "space", "-", "x"])).toEqual([
      ["send-keys", "-t", "%1", "-l", "--", "hi"], ["send-keys", "-t", "%1", "Space"], ["send-keys", "-t", "%1", "-l", "--", "-x"]]);
  });

  it("pastes a prompt through a buffer on stdin, then presses Enter", async () => {
    const fake = fakeTmux(); restore = fake.restore;
    const text = "line one\n$(rm -rf ~) `id` ; kill-server";
    await tmuxTerminal.prompt("tmux", "p1", text);
    expect(fake.calls.map(c => c.args[0])).toEqual(["load-buffer", "paste-buffer", "send-keys"]);
    const [load, paste, enter] = fake.calls;
    expect(load.socket).toBe("default");
    expect(load.args.slice(0, 2)).toEqual(["load-buffer", "-b"]); expect(load.args.at(-1)).toBe("-"); expect(load.input).toBe(text);
    expect(paste.args).toEqual(["paste-buffer", "-d", "-p", "-r", "-b", load.args[2], "-t", "%1"]);
    expect(enter.args).toEqual(["send-keys", "-t", "%1", "Enter"]);
    // The text never appears in an argument.
    expect(fake.calls.some(c => c.args.some(a => a.includes("rm -rf")))).toBe(false);
  });

  it("reads the screen with capture-pane, styles and scrollback on request", async () => {
    const fake = setTmuxDeps({ binary: () => "/usr/bin/tmux", run: async () => "one\ntwo\nthree\n\n   \n" });
    restore = fake;
    expect(await tmuxTerminal.readScreen("tmux", "p1", { scope: "agent", source: "visible", lines: 2 })).toBe("two\nthree");
    const calls: string[][] = [];
    restore(); restore = setTmuxDeps({ binary: () => "/usr/bin/tmux", run: async (_s, args) => { calls.push(args); return "x"; } });
    await tmuxTerminal.readScreen("tmux", "p1", { scope: "pane", source: "recent", lines: 40, format: "ansi" });
    expect(calls).toEqual([["capture-pane", "-p", "-t", "%1", "-e", "-S", "-40"]]);
  });

  it("opens a session or a window for a launch", async () => {
    const listed: string[][] = [];
    restore = setTmuxDeps({ binary: () => "/usr/bin/tmux", run: async (_s, args) => { listed.push(args); return args[0] === "list-sessions" ? "phren: fix\nphren: fix-2\n" : ""; } });
    await tmuxTerminal.create("tmux-phren", { label: "phren: fix", cwd: "/repo" });
    await tmuxTerminal.create("tmux-phren", { workspace: "s4", label: "second", cwd: "/repo" });
    expect(listed).toEqual([
      ["list-sessions", "-F", "#{session_name}"],
      ["new-session", "-d", "-s", "phren_ fix", "-x", "200", "-y", "50", "-c", "/repo", "-n", "phren: fix"],
      ["new-window", "-d", "-t", "$4:", "-c", "/repo", "-n", "second"],
    ]);
  });

  it("starts an agent as the pane's program under a login shell, arguments never in script text", async () => {
    let started = false;
    const calls: string[][] = [];
    restore = setTmuxDeps({ binary: () => "/usr/bin/tmux", version: async () => "tmux 3.3a", sleep: async () => { started = true; },
      processes: async () => started ? PS : PS.replace("/Users/me/.local/share/claude/versions/2.1.3 --effort high", "-zsh"),
      run: async (_s, args) => { calls.push(args); return args[0] === "list-panes" ? PANES : ""; } });
    vi.stubEnv("SHELL", "/bin/sh");
    await tmuxTerminal.startAgent("tmux-phren", "p1", { name: "fix-tests", kind: "claude", args: ["--model", "opus; rm -rf ~"], timeoutMs: 5_000 });
    expect(calls).toContainEqual(["set-option", "-p", "-t", "%1", "@phren_agent", "fix-tests"]);
    const respawn = calls.find(c => c[0] === "respawn-pane")!;
    expect(respawn).toEqual(["respawn-pane", "-k", "-t", "%1", "-c", "/repo", "--", "/bin/sh", "-l", "-c", 'shell="$1"; shift; "$@"; exec "$shell" -l',
      "phren", "/bin/sh", "claude", "--model", "opus; rm -rf ~"]);
    expect(started).toBe(true);
  });

  it("refuses to start an agent on tmux before 3.0", async () => {
    restore = setTmuxDeps({ binary: () => "/usr/bin/tmux", version: async () => "tmux 2.9a", run: async () => PANES });
    await expect(tmuxTerminal.startAgent("tmux-phren", "p1", { name: "a", kind: "claude", args: [], timeoutMs: 1_000 })).rejects.toThrow(/tmux 3.0/);
  });

  it("finds its own pane from the variables tmux sets", async () => {
    const fake = fakeTmux(); restore = fake.restore;
    expect(await tmuxPaneFromEnv({ TMUX: "/private/tmp/tmux-501/default,123,0", TMUX_PANE: "%7" })).toEqual({ server: "tmux", workspace: "s1", tab: "w2", pane: "p7" });
    expect(await tmuxPaneFromEnv({ TMUX: "/private/tmp/tmux-501/phren,123,0", TMUX_PANE: "%7" })).toMatchObject({ server: "tmux-phren" });
    expect(await tmuxPaneFromEnv({ TMUX_PANE: "%7" })).toBeUndefined();
    expect(fake.calls[0]).toEqual({ socket: "default", args: ["display-message", "-p", "-t", "%7", "#{session_id}\t#{window_id}"] });
  });
});

describe("choosing the terminal", () => {
  let home: string;
  beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), "phren-tmux-")); vi.stubEnv("PHREN_HERDR_HOME", home); vi.stubEnv("PHREN_BRIDGE_HOME", path.join(home, "bridge")); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  it("routes tmux names to tmux unless Herdr has a session by that name", async () => {
    expect(terminalKind("default")).toBe("herdr");
    expect(terminalKind("work")).toBe("herdr");
    expect(terminalKind("tmux")).toBe("tmux");
    expect(terminalKind("tmux-phren")).toBe("tmux");
    await mkdir(path.join(home, "sessions", "tmux-phren"), { recursive: true });
    await writeFile(path.join(home, "sessions", "tmux-phren", "herdr.sock"), "");
    expect(terminalKind("tmux-phren")).toBe("herdr");
  });

  it("lists tmux servers only while no Herdr server answers, under the phone's session kind", async () => {
    ({ restore } = fakeTmux());
    expect(await tmuxServers()).toEqual([
      { id: "tmux:tmux", kind: "herdr", terminal: "tmux", session: "tmux", running: true },
      { id: "tmux:tmux-phren", kind: "herdr", terminal: "tmux", session: "tmux-phren", running: true },
    ]);
    expect(await servers()).toEqual(await tmuxServers());
    restore();
    restore = setTmuxDeps({ binary: () => undefined });
    expect(await servers()).toEqual([]);
  });
});

describe("identity and status without Herdr's hints", () => {
  let home: string;
  const target: Target = { server: "tmux", workspace: "s1", tab: "w1", pane: "p1", source: "claude", session: SESSION };
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "phren-tmux-id-"));
    vi.stubEnv("PHREN_HERDR_HOME", home); vi.stubEnv("PHREN_BRIDGE_HOME", path.join(home, "bridge"));
    state.exec.mockReset().mockResolvedValue({ stdout: "" });
  });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  it("binds a Claude pane from its hook record and gates sends on the hook-reported status", async () => {
    ({ restore } = fakeTmux());
    const file = bindingPath("tmux", "p1");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ terminal: "p1:500", source: "claude", session: SESSION, pids: [510, 511], workspace: "s1", tab: "w1",
      event: "UserPromptSubmit", at: new Date().toISOString() }));
    // The binding file's last event is the status after a Hook restart.
    expect(await paneStatus("tmux", "p1", "p1:500")).toMatchObject({ status: "working" });
    const pane = await validateTarget(target, true);
    expect(pane).toMatchObject({ agent: "claude", agent_status: "working", terminal_id: "p1:500" });
    expect(await paneIdentity("tmux", pane)).toBe(SESSION);
    notePaneStatus("tmux", "p1", "p1:500", "blocked");
    await expect(validateTarget(target, true)).rejects.toThrow(/needs input in the terminal/);
    // Answered in the terminal: the dialog reader settles it once it is old enough.
    settleBlockedPane("tmux", "p1", 0);
    expect(await validateTarget(target, true)).toMatchObject({ agent_status: "working" });
  });

  it("identifies Claude from the transcript its process holds open", async () => {
    ({ restore } = fakeTmux());
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    state.exec.mockImplementation(async (_file: string, args: string[]) => ({ stdout: args.includes("510") ? `p510\nn/Users/me/.claude/projects/-repo/${SESSION}.jsonl\n` : "" }));
    const s = await tmuxSnapshot("tmux");
    const pane = (s.panes as Record<string, unknown>[])[0];
    expect(await paneIdentity("tmux", pane, true)).toBe(SESSION);
    vi.restoreAllMocks();
  });

  it("offers a starting token for a new Claude pane with no conversation yet", async () => {
    ({ restore } = fakeTmux({ ps: PS.replace(/51(\d)/g, "52$1") }));
    const s = await tmuxSnapshot("tmux");
    const state = await paneChatState("tmux", (s.panes as Record<string, unknown>[])[0]);
    expect(state.sessionId).toBeUndefined();
    expect(state.startingToken).toMatch(/^[a-f0-9]{64}$/);
    expect(state.starting).toBe(true);
  });
});

// Status on tmux beyond Claude's and Codex's lifecycle events: OpenCode's
// plugin record, Copilot's session log, phren-agent's events, and terminal
// dialogs without a hook behind them. Plus the tmux follow-ups around them:
// socket discovery, the pane a process runs in, health and the canary's server.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { copilotProcessStatus, copilotStatusFromEvents, opencodeProcessStatus } from "./harness-status.js";
import { dialogStatus, notePaneStatus, resetPaneStatus, screenDialog, settleBlockedPane } from "./pane-status.js";
import { resetTmuxBinary, setTmuxDeps, tmuxHealth, tmuxServers, tmuxSnapshot, tmuxSocketsIn } from "./terminal-tmux.js";
import { terminalPaneFromEnv } from "./terminal.js";
import { canaryServer } from "./canary.js";
import { describeTerminal, terminalHealth } from "./health.js";
import { resetSharedHerdrState } from "./herdr.js";

const CLAUDE_DIALOG = " Bash command\n\n   rm -rf build\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend";
const CODEX_DIALOG = "Would you like to run the following command?\n\n  $ rm -rf build\n\n› 1. Yes, proceed (y)\n  2. Yes, and don't ask again for this command (p)\n  3. No, and tell Codex what to do differently (esc)\n\n  Press enter to confirm or esc to cancel";
const OPENCODE_DIALOG = [
  "  ┃  △ Permission required",
  "  ┃    ← Access external directory ~/apps",
  "  ┃",
  "  ┃   \x1b[48;2;245;167;66mAllow once\x1b[0m\x1b[48;2;30;30;30m   Allow always   \x1b[48;2;30;30;30mReject\x1b[0m",
].join("\n");
const row = (values: Record<string, string>) => ["session_id", "session_name", "session_attached", "session_activity", "window_id", "window_name",
  "window_active", "pane_id", "pane_pid", "pane_tty", "pane_active", "pane_current_path", "pane_current_command", "@phren_agent", "pane_title"]
  .map(field => values[field] ?? "").join("\t");
const pane = (id: string, tty: string, command: string) => row({ session_id: "$1", session_name: "work", session_attached: "1", session_activity: "1",
  window_id: `@${id}`, window_name: command, window_active: "1", pane_id: `%${id}`, pane_pid: `${id}00`, pane_tty: `/dev/${tty}`, pane_active: "1",
  pane_current_path: "/repo", pane_current_command: command });

function fakeTmux(options: { panes?: string; ps?: string; screens?: Record<string, string>; sockets?: string[]; answering?: string[] } = {}) {
  const calls: { socket: string; args: string[] }[] = [];
  const restore = setTmuxDeps({
    binary: () => "/usr/bin/tmux",
    version: async () => "tmux 3.4\n",
    processes: async () => options.ps ?? "",
    sockets: async () => options.sockets ?? [],
    sleep: async () => {},
    run: async (socket, args) => {
      calls.push({ socket, args });
      if (args[0] === "list-sessions") {
        if (options.answering && !options.answering.includes(socket)) {
          const { BridgeError } = await import("./protocol.js");
          throw new BridgeError(503, "tmux is not running on this computer.", { code: "not_running" });
        }
        return "$1\n";
      }
      if (args[0] === "list-panes") return options.panes ?? "";
      if (args[0] === "capture-pane") return options.screens?.[args[args.indexOf("-t") + 1]] ?? "";
      if (args[0] === "display-message") return "$1\t@2\n";
      return "";
    },
  });
  return { calls, restore };
}

let restore: (() => void) | undefined;
let home: string;
beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), "phren-tmux-status-")); });
afterEach(async () => {
  restore?.(); restore = undefined; resetPaneStatus(); resetSharedHerdrState(); resetTmuxBinary();
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

describe("dialogs on a working pane's screen", () => {
  it("recognises each harness's own dialog, and not a numbered list in its output", () => {
    expect(screenDialog("claude", CLAUDE_DIALOG)).toBe(true);
    expect(screenDialog("claude", "Here is the plan:\n1. Read the tests\n2. Fix the bug\n")).toBe(false);
    expect(screenDialog("codex", CODEX_DIALOG)).toBe(true);
    expect(screenDialog("codex", "• Working (5s • esc to interrupt)\n\n› Ask Codex to do anything")).toBe(false);
    expect(screenDialog("opencode", OPENCODE_DIALOG)).toBe(true);
    expect(screenDialog("opencode", "1. one\n2. two\nEsc to cancel")).toBe(false);
    expect(screenDialog("phren", CLAUDE_DIALOG)).toBe(true);
  });

  it("marks a working pane blocked while its dialog shows, reading at most once per window", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let screen = CLAUDE_DIALOG;
    const read = vi.fn(async () => screen);
    const base = notePaneStatus("tmux", "p1", "p1:1", "working");
    const first = await dialogStatus("tmux", "p1", "p1:1", "claude", base, read);
    expect(first).toMatchObject({ status: "blocked" });
    expect(first!.seq).toBeGreaterThan(base.seq);
    // Within the window the screen is not read again.
    now += 1_000;
    screen = "done";
    expect(await dialogStatus("tmux", "p1", "p1:1", "claude", base, read)).toMatchObject({ status: "blocked" });
    expect(read).toHaveBeenCalledTimes(1);
    // The dialog went away: working again, with a newer sequence.
    now += 3_000;
    const after = await dialogStatus("tmux", "p1", "p1:1", "claude", base, read);
    expect(after).toMatchObject({ status: "working" });
    expect(after!.seq).toBeGreaterThan(first!.seq);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("never reads an idle pane, and clears when the phone answers", async () => {
    let now = 2_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const read = vi.fn(async () => CODEX_DIALOG);
    const idle = notePaneStatus("tmux", "p2", "p2:1", "idle");
    expect(await dialogStatus("tmux", "p2", "p2:1", "codex", idle, read)).toEqual(idle);
    expect(await dialogStatus("tmux", "p2", "p2:1", "codex", undefined, read)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    const working = notePaneStatus("tmux", "p2", "p2:1", "working");
    expect(await dialogStatus("tmux", "p2", "p2:1", "codex", working, read)).toMatchObject({ status: "blocked" });
    // Answered from the phone: settled at once, and not read again for a window.
    settleBlockedPane("tmux", "p2", 0);
    now += 1_000;
    expect(await dialogStatus("tmux", "p2", "p2:1", "codex", working, read)).toMatchObject({ status: "working" });
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("OpenCode's status from phren's plugin", () => {
  it("records working, blocked and idle by PID from OpenCode's events", async () => {
    vi.stubEnv("PHREN_PATH", home);
    vi.stubEnv("PHREN_FANOUT_JOB", "");
    const url = new URL("../../plugins/opencode/phren-transcript.js", import.meta.url);
    const { PhrenTranscriptPlugin } = await import(url.href) as { PhrenTranscriptPlugin: () => Promise<Record<string, (input: unknown, output?: unknown) => Promise<void>>> };
    const handlers = await PhrenTranscriptPlugin();
    const file = path.join(home, ".runtime", "sessions", `opencode-status-${process.pid}.json`);
    const status = async () => JSON.parse(await readFile(file, "utf8")).status as string;
    const event = (type: string, properties: Record<string, unknown>) => handlers.event({ event: { type, properties } });

    await handlers["chat.message"]({ sessionID: "ses_main1" }, { message: { id: "msg_1", role: "user" }, parts: [] });
    expect(await status()).toBe("working");
    await event("permission.updated", { id: "per_1", sessionID: "ses_main1", type: "bash" });
    expect(await status()).toBe("blocked");
    // Still busy while the ask waits: blocked holds.
    await event("session.status", { sessionID: "ses_main1", status: { type: "busy" } });
    expect(await status()).toBe("blocked");
    await event("permission.replied", { sessionID: "ses_main1", permissionID: "per_1", response: "once" });
    expect(await status()).toBe("working");
    // A subagent going idle is not the pane going idle.
    await event("session.created", { info: { id: "ses_child2", parentID: "ses_main1" } });
    await event("session.idle", { sessionID: "ses_child2" });
    expect(await status()).toBe("working");
    await event("session.idle", { sessionID: "ses_main1" });
    expect(await status()).toBe("idle");
    expect(await opencodeProcessStatus([process.pid], home)).toBe("idle");
  });

  it("takes the newest record among a pane's processes", async () => {
    const folder = path.join(home, ".runtime", "sessions");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "opencode-status-11.json"), JSON.stringify({ status: "idle", at: "2026-09-01T00:00:00Z" }));
    await writeFile(path.join(folder, "opencode-status-12.json"), JSON.stringify({ status: "working", at: "2026-09-02T00:00:00Z" }));
    await writeFile(path.join(folder, "opencode-status-13.json"), JSON.stringify({ status: "exploded", at: "2026-09-03T00:00:00Z" }));
    expect(await opencodeProcessStatus([11, 12, 13], home)).toBe("working");
    expect(await opencodeProcessStatus([11], home)).toBe("idle");
    expect(await opencodeProcessStatus([99], home)).toBeUndefined();
  });
});

describe("Copilot's status from its session log", () => {
  const fixture = readFileSync(new URL("./fixtures/copilot/1.0.87/events.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean);
  const upTo = (type: string, nth = 1) => {
    let seen = 0;
    const index = fixture.findIndex(line => JSON.parse(line).type === type && ++seen === nth);
    return fixture.slice(0, index + 1);
  };

  it("follows a prompt through its model calls, a permission and the final answer", () => {
    expect(copilotStatusFromEvents(fixture.slice(0, 1))).toBe("idle");
    expect(copilotStatusFromEvents(upTo("user.message", 2))).toBe("working");
    // A turn that ends without the final answer is one model call of several.
    expect(copilotStatusFromEvents(upTo("assistant.turn_end", 2))).toBe("working");
    expect(copilotStatusFromEvents(upTo("permission.requested"))).toBe("blocked");
    expect(copilotStatusFromEvents(upTo("permission.completed"))).toBe("working");
    expect(copilotStatusFromEvents(fixture)).toBe("idle");
    expect(copilotStatusFromEvents([...upTo("user.message", 2), JSON.stringify({ type: "abort", data: {} })])).toBe("idle");
    expect(copilotStatusFromEvents(["not json", ""])).toBeUndefined();
  });

  it("reads the log of the conversation the process shows", async () => {
    const session = "00000000-0000-4000-8000-000000000187";
    await mkdir(path.join(home, "logs"), { recursive: true });
    await writeFile(path.join(home, "logs", "process-1-4242.log"), `2026-09-22T19:00:00.000Z [INFO] Registering foreground session: ${session}\n`);
    await mkdir(path.join(home, "session-state", session), { recursive: true });
    const log = path.join(home, "session-state", session, "events.jsonl");
    await writeFile(log, upTo("permission.requested").join("\n") + "\n");
    expect(await copilotProcessStatus([4242], home)).toBe("blocked");
    await writeFile(log, fixture.join("\n") + "\n");
    expect(await copilotProcessStatus([4242], home)).toBe("idle");
    expect(await copilotProcessStatus([1], home)).toBeUndefined();
  });
});

describe("the tmux snapshot's status for every harness", () => {
  const PANES = [pane("1", "ttys001", "opencode"), pane("2", "ttys002", "node"), pane("3", "ttys003", "codex"), pane("4", "ttys004", "node")].join("\n");
  const PS = [
    "  110   110   110 ttys001  opencode",
    "  210   210   210 ttys002  node /usr/lib/node_modules/@github/copilot/index.js",
    "  310   310   310 ttys003  codex",
    "  410   410   410 ttys004  node /usr/local/bin/phren-agent",
  ].join("\n");

  it("OpenCode from its plugin, Copilot and phren-agent idle without records, Codex blocked by its dialog", async () => {
    vi.stubEnv("PHREN_PATH", home);
    vi.stubEnv("COPILOT_HOME", path.join(home, "copilot"));
    vi.stubEnv("PHREN_BRIDGE_HOME", path.join(home, "bridge"));
    const folder = path.join(home, ".runtime", "sessions");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "opencode-status-110.json"), JSON.stringify({ status: "working", at: new Date().toISOString() }));
    notePaneStatus("tmux", "p3", "p3:300", "working");
    const fake = fakeTmux({ panes: PANES, ps: PS, screens: { "%3": CODEX_DIALOG } });
    restore = fake.restore;
    const s = await tmuxSnapshot("tmux");
    const statuses = Object.fromEntries((s.panes as { pane_id: string; agent?: string; agent_status?: string }[]).map(p => [p.pane_id, [p.agent, p.agent_status]]));
    expect(statuses).toEqual({ p1: ["opencode", "working"], p2: ["copilot", "idle"], p3: ["codex", "blocked"], p4: ["phren", "idle"] });
    // Only the working panes' screens were read.
    expect(fake.calls.filter(call => call.args[0] === "capture-pane").map(call => call.args[call.args.indexOf("-t") + 1]).sort()).toEqual(["%1", "%3"]);
    // phren-agent reports turns through its lifecycle events.
    notePaneStatus("tmux", "p4", "p4:400", "working");
    expect(((await tmuxSnapshot("tmux")).panes as { agent_status?: string }[])[3].agent_status).toBe("working");
  });
});

describe("tmux sockets, the pane a process runs in, health and the canary", () => {
  it("lists every socket that answers, not only default and phren", async () => {
    ({ restore } = fakeTmux({ sockets: ["default", "work", "phren", "stale"], answering: ["default", "work"] }));
    expect((await tmuxServers()).map(server => server.session)).toEqual(["tmux", "tmux-work", "tmux-phren"]);
  });

  it("finds this user's sockets in a tmux folder", async () => {
    const folder = path.join(home, "tmux-sockets");
    await mkdir(folder);
    const server = createServer();
    await new Promise<void>(resolve => server.listen(path.join(folder, "work"), resolve));
    try {
      await writeFile(path.join(folder, "not-a-socket"), "");
      expect(await tmuxSocketsIn(folder)).toEqual(["work"]);
      expect(await tmuxSocketsIn(path.join(home, "missing"))).toEqual([]);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });

  it("names the pane from Herdr's variables inside Herdr, else from tmux's", async () => {
    const fake = fakeTmux(); restore = fake.restore;
    vi.stubEnv("PHREN_HERDR_HOME", home);
    expect(await terminalPaneFromEnv({ HERDR_ENV: "1", HERDR_SOCKET_PATH: path.join(home, "herdr.sock"), HERDR_WORKSPACE_ID: "w1", HERDR_TAB_ID: "t1", HERDR_PANE_ID: "p1",
      TMUX: "/tmp/tmux-501/default,1,0", TMUX_PANE: "%7" })).toEqual({ server: "default", workspace: "w1", tab: "t1", pane: "p1" });
    expect(await terminalPaneFromEnv({ TMUX: "/tmp/tmux-501/default,1,0", TMUX_PANE: "%7" })).toEqual({ server: "tmux", workspace: "s1", tab: "w2", pane: "p7" });
    expect(await terminalPaneFromEnv({})).toBeUndefined();
  });

  it("reports tmux's version, the owner's servers and the hidden server", async () => {
    vi.stubEnv("PHREN_TMUX", "");
    vi.stubEnv("PHREN_HERDR_HOME", home);
    ({ restore } = fakeTmux({ sockets: ["default"], answering: ["default"] }));
    expect(await tmuxHealth()).toEqual({ state: "ok", version: "3.4", launches: true, servers: ["tmux"], hidden: { running: false } });
    const terminal = await terminalHealth();
    expect(terminal).toMatchObject({ provider: "tmux", servers: [{ name: "tmux", provider: "tmux" }, { name: "tmux-phren", provider: "tmux" }] });
    expect(describeTerminal(terminal)).toBe("tmux (tmux, tmux-phren); tmux 3.4, hidden server not started");
    vi.stubEnv("PHREN_TMUX", "off");
    expect(await tmuxHealth()).toEqual({ state: "off" });
    restore(); restore = setTmuxDeps({ binary: () => undefined });
    vi.stubEnv("PHREN_TMUX", "");
    expect(await tmuxHealth()).toEqual({ state: "missing" });
    expect(describeTerminal(await terminalHealth())).toBe("none: Herdr is not running; tmux not installed");
  });

  it("starts the canary's conductor in tmux's hidden server on a computer without Herdr", async () => {
    vi.stubEnv("PHREN_HERDR_HOME", home);
    ({ restore } = fakeTmux({ answering: ["default"] }));
    expect(await canaryServer()).toBe("tmux-phren");
    restore(); restore = setTmuxDeps({ binary: () => undefined });
    expect(await canaryServer()).toBeUndefined();
  });
});

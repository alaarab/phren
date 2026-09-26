// The tmux provider against a real tmux, on a private socket. Skipped when
// this computer has no tmux.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { request } from "node:http";
import { AgentHooks } from "./agent-hooks.js";
import { localSocket } from "./agent-hook-stores.js";
import { paneIdentity, snapshot, validateTarget, workspaceSnapshot } from "./herdr.js";
import { objects } from "./protocol.js";
import type { ApprovalPushService } from "./push.js";
import { launchSession } from "./server-launch.js";
import { resetTmuxBinary, tmuxBinary, tmuxHealth, tmuxPaneFromEnv, tmuxServers, tmuxSnapshot, tmuxTerminal, toTmuxId } from "./terminal-tmux.js";

const saved = process.env.PHREN_TMUX;
delete process.env.PHREN_TMUX;
resetTmuxBinary();
const binary = tmuxBinary();
if (saved !== undefined) process.env.PHREN_TMUX = saved;
const server = `tmux-phren-test-${process.pid}`;

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

describe.skipIf(!binary || process.platform === "win32")("tmux provider on a real tmux", () => {
  let folder: string;
  const env = { PHREN_TMUX: process.env.PHREN_TMUX, SHELL: process.env.SHELL, PATH: process.env.PATH,
    PHREN_BRIDGE_HOME: process.env.PHREN_BRIDGE_HOME, PHREN_HERDR_HOME: process.env.PHREN_HERDR_HOME, PHREN_PATH: process.env.PHREN_PATH };
  beforeAll(async () => {
    delete process.env.PHREN_TMUX;
    resetTmuxBinary();
    folder = await realpath(await mkdtemp(path.join(tmpdir(), "phren-tmux-it-")));
    // The Hook's own files, Herdr's (none) and the store stay in the test folder.
    process.env.PHREN_BRIDGE_HOME = path.join(folder, "bridge");
    process.env.PHREN_HERDR_HOME = path.join(folder, "herdr");
    process.env.PHREN_PATH = path.join(folder, "store");
    await mkdir(process.env.PHREN_BRIDGE_HOME, { recursive: true, mode: 0o700 });
    // A stand-in for Claude Code: a Node script named claude that echoes what it is sent.
    // "DIALOG" draws Claude's permission dialog, as its auto-mode fallback
    // does with no hook behind it; "CLEAR" clears the screen.
    await writeFile(path.join(folder, "claude"), `#!${process.execPath}\nconst rl = require("node:readline").createInterface({ input: process.stdin });\n`
      + `const dialog = ${JSON.stringify(CLAUDE_DIALOG)};\nprocess.stdout.write("fake claude ready\\n");\n`
      + `rl.on("line", line => process.stdout.write(line === "DIALOG" ? dialog : line === "CLEAR" ? "\\x1b[2J\\x1b[H" : "got: " + line + "\\n"));\n`);
    await chmod(path.join(folder, "claude"), 0o755);
    process.env.SHELL = "/bin/sh";
    process.env.PATH = `${folder}${path.delimiter}${process.env.PATH}`;
  });
  afterAll(async () => {
    try { execFileSync(binary!, ["-L", server.slice("tmux-".length), "kill-server"], { stdio: "ignore" }); } catch { /* already gone */ }
    for (const [name, value] of Object.entries(env)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    resetTmuxBinary();
    await rm(folder, { recursive: true, force: true });
  });

  it("opens a session, reads a shell back, types into it and starts an agent there", async () => {
    await tmuxTerminal.create(server, { label: "it work", cwd: folder });
    const first = await until(() => tmuxSnapshot(server), s => objects(s.panes).length === 1);
    expect(objects(first.workspaces).map(w => w.label)).toEqual(["it work"]);
    const pane = String(objects(first.panes)[0].pane_id);
    expect(objects(first.panes)[0]).toMatchObject({ workspace_id: expect.stringMatching(/^s\d+$/), tab_id: expect.stringMatching(/^w\d+$/), cwd: folder });

    await tmuxTerminal.sendKeys(server, pane, [..."echo hello-$((6*7))", "enter"]);
    const screen = await until(() => tmuxTerminal.readScreen(server, pane, { scope: "pane", source: "visible", lines: 50 }), text => text.includes("hello-42"));
    expect(screen).toContain("hello-42");
    expect((await tmuxTerminal.processes(server, pane)).foregroundPids.length).toBeGreaterThan(0);

    await tmuxTerminal.startAgent(server, pane, { name: "it-agent", kind: "claude", args: ["--effort", "high; echo injected"], timeoutMs: 15_000 });
    const started = objects((await tmuxSnapshot(server)).panes).find(p => p.pane_id === pane)!;
    expect(started).toMatchObject({ agent: "claude", agent_status: "unknown", agent_name: "it-agent" });
    await until(() => tmuxTerminal.readScreen(server, pane, { scope: "agent", source: "visible", lines: 50 }), text => text.includes("fake claude ready"));

    await tmuxTerminal.prompt(server, pane, "a prompt with $(id) and `quotes`");
    const echoed = await until(() => tmuxTerminal.readScreen(server, pane, { scope: "agent", source: "recent", lines: 200 }), text => text.includes("got: a prompt"));
    expect(echoed).toContain("got: a prompt with $(id) and `quotes`");
    expect(echoed).not.toContain("injected");

    await tmuxTerminal.create(server, { workspace: String(first.workspaces && objects(first.workspaces)[0].workspace_id), label: "second", cwd: folder });
    const two = await until(() => tmuxSnapshot(server), s => objects(s.tabs).length === 2);
    const second = objects(two.tabs).find(t => t.label === "second")!;
    await tmuxTerminal.groupAction(server, "close", { tab: String(second.tab_id) });
    expect(objects((await until(() => tmuxSnapshot(server), s => objects(s.tabs).length === 1)).tabs)).toHaveLength(1);
  }, 60_000);

  it("launches Claude from the phone, then binds and follows it through Claude's lifecycle hooks", async () => {
    const launched = await launchSession(server, { cwd: folder, label: "phone launch", kind: "claude" });
    expect(launched).toMatchObject({ ok: true, agent: "claude", agentStatus: "unknown", target: { server, source: "claude", starting: true } });
    const place = { server, workspace: String(launched.workspaceId), tab: String(launched.tabId), pane: String(launched.paneId) };
    const overview = workspaceSnapshot(await snapshot(server));
    expect(objects(overview.groups).find(g => g.label === "phone launch")).toMatchObject({ children: [{ label: "phone launch", agent: "claude", agentStatus: "unknown" }] });

    // What Claude's hook process finds from the variables tmux gives it.
    const socket = execFileSync(binary!, ["-L", server.slice("tmux-".length), "display-message", "-p", "-t", toTmuxId(place.pane, "p"), "#{socket_path}"]).toString().trim();
    expect(await tmuxPaneFromEnv({ TMUX: `${socket},1,0`, TMUX_PANE: toTmuxId(place.pane, "p") })).toEqual(place);

    const hooks = new AgentHooks({ available: false, start: async () => {}, status: { configured: false } } as unknown as ApprovalPushService);
    await hooks.start();
    try {
      const target = { ...place, source: "claude" as const, session: SESSION };
      await hook({ target, event: "SessionStart" });
      expect(await paneIdentity(server, (await validateTarget(target, true)))).toBe(SESSION);
      await hook({ target, event: "UserPromptSubmit", prompt: "hi" });
      expect(await validateTarget(target)).toMatchObject({ agent_status: "working" });
      // A dialog drawn while working, with no PermissionRequest behind it,
      // blocks the pane until it is gone.
      const status = async () => objects((await tmuxSnapshot(server)).panes).find(p => p.pane_id === place.pane)?.agent_status;
      await tmuxTerminal.prompt(server, place.pane, "DIALOG");
      expect(await until(status, value => value === "blocked", 12_000)).toBe("blocked");
      await tmuxTerminal.prompt(server, place.pane, "CLEAR");
      expect(await until(status, value => value === "working", 12_000)).toBe("working");
      await hook({ target, event: "Stop" });
      expect(workspaceSnapshot(await snapshot(server)).groups).toContainEqual(expect.objectContaining({ label: "phone launch",
        children: [expect.objectContaining({ agent: "claude", agentStatus: "idle" })] }));
    } finally { hooks.close(); }
  }, 60_000);

  it("finds this test's socket among the owner's servers and reports tmux's health", async () => {
    expect((await tmuxServers()).map(entry => entry.session)).toContain(server);
    const health = await tmuxHealth();
    expect(health).toMatchObject({ state: "ok", launches: true, hidden: { running: expect.any(Boolean) } });
    expect(health.version).toMatch(/^\d+\.\d+/);
    expect(health.servers).toContain(server);
  }, 30_000);
});

const CLAUDE_DIALOG = " Bash command\n\n   rm -rf build\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend\n";
const SESSION = "bbbbbbbb-2222-4222-8222-222222222222";
/** Claude's hook process: one lifecycle event posted to the Hook's agent socket. */
function hook(body: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: localSocket(), path: "/hook", method: "POST" }, res => {
      let text = ""; res.on("data", chunk => { text += chunk; }); res.on("end", () => res.statusCode === 200 ? resolve(text) : reject(new Error(`hook ${res.statusCode}`)));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

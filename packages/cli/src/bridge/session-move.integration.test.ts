// A session move on a real tmux, on a private socket, with stand-ins for
// Claude Code and Codex: the hand-off request typed into the pane, the
// agent's own /exit, and Codex started in the same pane with the hand-off as
// its brief. Skipped when this computer has no tmux.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { paneIdentity, snapshot } from "./herdr.js";
import { objects, type Json } from "./protocol.js";
import { launchSession } from "./server-launch.js";
import { readMove, SessionMover } from "./session-move.js";
import { resetTmuxBinary, tmuxBinary, tmuxTerminal } from "./terminal-tmux.js";
import { privateTmuxServer, testSocketName } from "./tmux-test-server.js";

const saved = process.env.PHREN_TMUX;
delete process.env.PHREN_TMUX;
resetTmuxBinary();
const binary = tmuxBinary();
if (saved !== undefined) process.env.PHREN_TMUX = saved;
const socket = testSocketName("move");
const server = `tmux-${socket}`;
const SESSION = "00000003-1111-4111-8111-111111111111";
const NEXT = "00000004-2222-4222-8222-222222222222";

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

describe.skipIf(!binary || process.platform === "win32")("moving a session on a real tmux", () => {
  let folder: string, repo: string, transcript: string;
  let tmuxServer: { stop: () => void } | undefined;
  const names = ["PHREN_TMUX", "SHELL", "PATH", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "HISTFILE", "PHREN_BRIDGE_HOME", "PHREN_HERDR_HOME", "PHREN_PATH", "PHREN_CODEX_APP_SERVER", "PHREN_LAUNCH_CHECK"];
  const env = Object.fromEntries(names.map(name => [name, process.env[name]]));
  beforeAll(async () => {
    tmuxServer = privateTmuxServer(binary!, socket);
    delete process.env.PHREN_TMUX;
    resetTmuxBinary();
    folder = await realpath(await mkdtemp(path.join(tmpdir(), "phren-move-it-")));
    process.env.PHREN_BRIDGE_HOME = path.join(folder, "bridge");
    process.env.PHREN_HERDR_HOME = path.join(folder, "herdr");
    process.env.PHREN_PATH = path.join(folder, "store");
    await mkdir(process.env.PHREN_BRIDGE_HOME, { recursive: true, mode: 0o700 });
    // A throwaway home, so the agents' login shell finds no real claude or codex.
    const home = path.join(folder, "home");
    await mkdir(path.join(home, ".config"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(home, ".local", "share"), { recursive: true, mode: 0o700 });
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    process.env.HISTFILE = "/dev/null";
    process.env.PHREN_CODEX_APP_SERVER = "off";
    process.env.PHREN_LAUNCH_CHECK = "off";
    // The checkout, with work in progress the move must leave alone.
    repo = path.join(folder, "repo");
    await mkdir(repo);
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    git("init", "-q", "-b", "fix/parser");
    await writeFile(path.join(repo, "parser.ts"), "export const a = 1;\n");
    git("add", "."); git("commit", "-q", "-m", "Start parser fix");
    await writeFile(path.join(repo, "parser.ts"), "export const a = 2;\n");
    // Stand-in Claude: answers the hand-off request in its transcript, and exits on /exit.
    transcript = path.join(folder, "transcript.jsonl");
    await writeFile(path.join(folder, "claude"), `#!${process.execPath}\nconst fs = require("node:fs");\n`
      + `const rl = require("node:readline").createInterface({ input: process.stdin });\nprocess.stdout.write("fake claude ready\\n");\n`
      + `rl.on("line", line => {\n  if (line.trim() === "/exit") process.exit(0);\n`
      + `  const m = /=== PHREN HANDOFF (\\w+) BEGIN ===/.exec(line);\n  if (!m) return;\n`
      + `  const row = (type, text) => JSON.stringify({ type, message: { role: type, content: type === "user" ? text : [{ type: "text", text }] } }) + "\\n";\n`
      + `  fs.appendFileSync(${JSON.stringify(transcript)}, row("user", line) + row("assistant", "=== PHREN HANDOFF " + m[1] + " BEGIN ===\\n## Goal\\nFix the parser.\\n=== PHREN HANDOFF " + m[1] + " END ==="));\n});\n`);
    // Stand-in Codex: records the arguments it started with.
    await writeFile(path.join(folder, "codex"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(path.join(folder, "codex-args.json"))}, JSON.stringify(process.argv.slice(2)));\n`
      + `process.stdout.write("fake codex ready\\n");\nrequire("node:readline").createInterface({ input: process.stdin }).on("line", () => {});\n`);
    await chmod(path.join(folder, "claude"), 0o755);
    await chmod(path.join(folder, "codex"), 0o755);
    process.env.SHELL = "/bin/sh";
    process.env.PATH = `${folder}${path.delimiter}${process.env.PATH}`;
  });
  afterAll(async () => {
    tmuxServer?.stop();
    for (const [name, value] of Object.entries(env)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    resetTmuxBinary();
    await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  });

  it("asks Claude for its hand-off, lets it exit and starts Codex in the same pane with it", async () => {
    // A first session starts the private tmux server.
    await tmuxTerminal.create(server, { label: "base", cwd: repo });
    const launched = await launchSession(server, { cwd: repo, label: "parser fix", kind: "claude" });
    const place = { server, workspace: String(launched.workspaceId), tab: String(launched.tabId), pane: String(launched.paneId) };
    await until(() => tmuxTerminal.readScreen(server, place.pane, { scope: "pane", source: "visible", lines: 50 }), text => text.includes("fake claude ready"));

    const mover = new SessionMover({
      snapshot: value => snapshot(value),
      // The stand-ins send no lifecycle hooks, so their conversations are named here.
      identity: async (value, pane) => await paneIdentity(value, pane).catch(() => undefined) ?? (pane.agent === "codex" ? NEXT : SESSION),
      terminal: tmuxTerminal,
      deliver: async (target, text) => { await tmuxTerminal.prompt(target.server, target.pane, text); return { ok: true, delivered: true }; },
      launch: (value, data, options) => launchSession(value, data, { trustFolder: true, ...options }),
      inventory: async () => undefined,
      transcript: async () => (await readFile(transcript, "utf8").catch(() => "")).split("\n"),
      envAtStart: () => true,
      pollMs: 200,
      exitMs: 10_000,
    });
    const started = await mover.start({ target: { ...place, source: "claude", session: SESSION }, to: { harness: "codex", model: "gpt-5.5" }, handoffTimeoutMs: 30_000 });
    await mover.settled(server, place.pane);
    const record = (await readMove(started.id))!;

    expect(record).toMatchObject({ state: "moved", exit: "clean", placement: "same-pane", handoff: { source: "agent" },
      target: { pane: place.pane, source: "codex", session: NEXT } });
    const pane = objects((await snapshot(server)).panes).find(row => row.pane_id === place.pane) as Json;
    expect(pane.agent).toBe("codex");
    const handoff = await readFile(record.handoff!.path, "utf8");
    expect(handoff).toContain("## Goal\nFix the parser.");
    expect(handoff).toContain("M parser.ts");
    // Codex got the hand-off as its first prompt, by its brief file.
    const args = JSON.parse(await until(() => readFile(path.join(folder, "codex-args.json"), "utf8").catch(() => ""), text => !!text)) as string[];
    expect(args).toEqual(expect.arrayContaining(["--model", "gpt-5.5", `Read and follow the brief in ${path.join(path.dirname(record.handoff!.path), "brief.md")}`]));
    expect(await readFile(path.join(path.dirname(record.handoff!.path), "brief.md"), "utf8")).toContain("Fix the parser.");
    // The work in progress is still there, uncommitted.
    expect(execFileSync("git", ["-C", repo, "status", "--porcelain"]).toString()).toContain(" M parser.ts");
  }, 90_000);
});

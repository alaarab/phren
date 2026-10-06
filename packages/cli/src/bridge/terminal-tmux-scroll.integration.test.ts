// Phone swipes on a tmux server with tmux's defaults (`mouse off`), against a
// real tmux on a private socket. Skipped when this computer has no tmux.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { workspaceAction } from "./server-launch.js";
import { fromTmuxId, resetTmuxBinary, tmuxBinary, tmuxScroll } from "./terminal-tmux.js";
import { privateTmuxServer, testSocketName } from "./tmux-test-server.js";

const saved = process.env.PHREN_TMUX;
delete process.env.PHREN_TMUX;
resetTmuxBinary();
const binary = tmuxBinary();
if (saved !== undefined) process.env.PHREN_TMUX = saved;
const socket = testSocketName("scroll");
const server = `tmux-${socket}`;

const tmux = (...args: string[]) => execFileSync(binary!, ["-L", socket, ...args]).toString().trim();
const format = (pane: string, text: string) => tmux("display-message", "-p", "-t", pane, text);

async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, ms = 5_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

describe.skipIf(!binary || process.platform === "win32")("tmux scrolling for the phone on a real tmux", () => {
  let folder: string;
  let tmuxServer: { stop: () => void } | undefined;
  /** A window running `command`, and its tmux pane id (%n). */
  const window = async (name: string, command: string) => {
    tmux("new-window", "-d", "-t", "main", "-n", name, command);
    const pane = tmux("display-message", "-p", "-t", `main:${name}`, "#{pane_id}");
    return pane;
  };
  /** A stand-in for an agent tracking the mouse: alternate screen, the given
   * mouse modes, and every byte it reads appended to `log`. */
  const mouseApp = async (log: string, modes: string) => {
    const file = path.join(folder, `${path.basename(log)}.js`);
    await writeFile(file, `const fs = require("node:fs");\nprocess.stdin.setRawMode(true);\n`
      + `process.stdout.write("\\x1b[?1049h${modes}ready");\n`
      + `process.stdin.on("data", data => fs.appendFileSync(${JSON.stringify(log)}, data));\n`);
    await writeFile(log, "");
    return `${process.execPath} ${file}`;
  };

  beforeAll(async () => {
    // Torn down even when a test fails, times out or the run is killed.
    tmuxServer = privateTmuxServer(binary!, socket);
    delete process.env.PHREN_TMUX;
    resetTmuxBinary();
    folder = await realpath(await mkdtemp(path.join(tmpdir(), "phren-tmux-scroll-")));
    await chmod(folder, 0o700);
    // -f /dev/null: tmux's own defaults, whatever the owner's config says.
    execFileSync(binary!, ["-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", "main", "-x", "100", "-y", "30", "sh"]);
    expect(tmux("show-options", "-gv", "mouse")).toBe("off");
  });
  afterAll(async () => {
    tmuxServer?.stop();
    if (saved === undefined) delete process.env.PHREN_TMUX; else process.env.PHREN_TMUX = saved;
    resetTmuxBinary();
    await rm(folder, { recursive: true, force: true });
  });

  it("scrolls a shell's history in copy mode and returns to live output at the bottom", async () => {
    const pane = await window("shell", "seq 1 500; exec cat");
    await until(() => format(pane, "#{history_size}"), size => Number(size) > 400);
    const id = fromTmuxId(pane)!;

    expect(await tmuxScroll(server, id, 5)).toEqual({ history: true });
    expect(format(pane, "#{pane_mode} #{scroll_position}")).toBe("copy-mode 5");
    expect(await tmuxScroll(server, id, 3)).toEqual({ history: true });
    expect(format(pane, "#{scroll_position}")).toBe("8");
    // Scrolling back past the bottom leaves copy mode on its own (-e).
    expect(await tmuxScroll(server, id, -20)).toEqual({ history: false });
    expect(format(pane, "#{pane_in_mode}")).toBe("0");
    // Down at the live screen is a no-op, never copy mode.
    expect(await tmuxScroll(server, id, -3)).toEqual({ history: false });
    expect(format(pane, "#{pane_in_mode}")).toBe("0");
  });

  it("returns to live output before typing, so keys reach the pane and not copy mode", async () => {
    const pane = await window("typing", "seq 1 300; exec cat");
    await until(() => format(pane, "#{history_size}"), size => Number(size) > 200);
    const id = fromTmuxId(pane)!;
    expect(await tmuxScroll(server, id, 10)).toEqual({ history: true });
    expect(await tmuxScroll(server, id, 0)).toEqual({ history: false });
    expect(format(pane, "#{pane_in_mode}")).toBe("0");
    tmux("send-keys", "-t", pane, "-l", "typed-after-scroll");
    tmux("send-keys", "-t", pane, "Enter");
    expect(await until(() => tmux("capture-pane", "-p", "-t", pane), text => text.includes("typed-after-scroll"))).toContain("typed-after-scroll");
    // Leaving live output that is already live changes nothing.
    expect(await tmuxScroll(server, id, 0)).toEqual({ history: false });
  });

  it("sends wheel events to an app tracking the mouse, in its SGR encoding", async () => {
    const log = path.join(folder, "sgr.log");
    const pane = await window("sgr", await mouseApp(log, "\\x1b[?1000h\\x1b[?1006h"));
    await until(() => format(pane, "#{mouse_any_flag}#{mouse_sgr_flag}"), flags => flags === "11");
    const id = fromTmuxId(pane)!;
    expect(await tmuxScroll(server, id, 3)).toEqual({ history: false });
    expect(await tmuxScroll(server, id, -2)).toEqual({ history: false });
    const up = "\x1b[<64;50;15M", down = "\x1b[<65;50;15M";
    expect(await until(() => readFile(log, "utf8"), text => text.length >= 5 * up.length)).toBe(up.repeat(3) + down.repeat(2));
    // The app scrolls its own history; tmux never enters copy mode over it.
    expect(format(pane, "#{pane_in_mode}")).toBe("0");
  });

  it("sends X10 wheel events to an app that did not ask for SGR", async () => {
    const log = path.join(folder, "x10.log");
    const pane = await window("x10", await mouseApp(log, "\\x1b[?1000h"));
    await until(() => format(pane, "#{mouse_any_flag}#{mouse_sgr_flag}"), flags => flags === "10");
    await tmuxScroll(server, fromTmuxId(pane)!, 2);
    const up = `\x1b[M${String.fromCharCode(32 + 64, 32 + 50, 32 + 15)}`;
    expect(await until(() => readFile(log, "utf8"), text => text.length >= 2 * up.length)).toBe(up.repeat(2));
  });

  it("leaves another tmux mode alone", async () => {
    const pane = await window("clock", "exec cat");
    tmux("clock-mode", "-t", pane);
    expect(await tmuxScroll(server, fromTmuxId(pane)!, 4)).toEqual({ history: false });
    expect(format(pane, "#{pane_mode}")).toBe("clock-mode");
  });

  it("serves the phone's scroll action for tmux only, with bounded lines", async () => {
    const pane = await window("route", "seq 1 200; exec cat");
    await until(() => format(pane, "#{history_size}"), size => Number(size) > 100);
    const paneId = fromTmuxId(pane)!;
    expect(await workspaceAction(server, "scroll", { paneId, lines: 4 })).toEqual({ ok: true, history: true });
    expect(await workspaceAction(server, "scroll", { paneId, lines: 0 })).toEqual({ ok: true, history: false });
    await expect(workspaceAction(server, "scroll", { paneId, lines: 500 })).rejects.toThrow();
    await expect(workspaceAction(server, "scroll", { paneId, lines: 1.5 })).rejects.toThrow();
    await expect(workspaceAction(server, "scroll", { paneId: "w1", lines: 1 })).rejects.toThrow(/tmux pane changed/);
    await expect(workspaceAction(server, "scroll", { paneId: "p999999", lines: 1 })).rejects.toThrow(/tmux/);
    // With no pane named, the attached client's pane; none is attached here.
    await expect(workspaceAction(server, "scroll", { lines: 1 })).rejects.toThrow("No terminal is attached to this tmux server.");
    await expect(workspaceAction("default", "scroll", { paneId, lines: 1 })).rejects.toThrow("Herdr scrolls in the terminal itself.");
  });
});

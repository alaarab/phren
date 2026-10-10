// pty-bridge: attach a local or remote multiplexer to a node-pty terminal.
import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import * as pty from "node-pty";
import { sshArgs } from "./hosts.js";
import type { AttachTerminal, Computer, TerminalSession } from "./contract.js";

// No leading dot or dash: the name is an argv entry for tmux or herdr.
const SERVER_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const require = createRequire(import.meta.url);
let helperChecked = false;

/** node-pty 1.1.0 prebuilds ship spawn-helper without +x under pnpm; fix once. */
function ensureSpawnHelper(): void {
  if (helperChecked) return;
  helperChecked = true;
  try {
    const pkg = require.resolve("node-pty/package.json");
    const helper = join(dirname(pkg), "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
    if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
  } catch {
    // Best effort: an unwritable or absent helper fails later with a clear spawn error.
  }
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Child env: always TERM, the desktop's own control variables stripped. */
function childEnv(local: boolean): { [key: string]: string | undefined } {
  const env: { [key: string]: string | undefined } = { ...process.env, TERM: "xterm-256color" };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PHREN_DESKTOP_")) delete env[key];
  }
  if (!local) return env;
  for (const key of Object.keys(env)) {
    if (key === "TMUX" || key === "TMUX_PANE" || key.startsWith("HERDR_")) delete env[key];
  }
  return env;
}

function spawnPty(file: string, args: string[], cols: number, rows: number, local: boolean): pty.IPty {
  ensureSpawnHelper();
  return pty.spawn(file, args, {
    name: "xterm-256color",
    cols: clamp(cols, 2, 500),
    rows: clamp(rows, 2, 200),
    cwd: os.homedir(),
    env: childEnv(local),
  });
}

function localCommand(server: string): { file: string; args: string[] } {
  if (server === "tmux") return { file: "tmux", args: ["attach"] };
  if (server.startsWith("tmux-")) return { file: "tmux", args: ["-L", server.slice("tmux-".length), "attach"] };
  return { file: "herdr", args: ["session", "attach", server] };
}

function wrap(p: pty.IPty): TerminalSession {
  return {
    write: (data) => p.write(data),
    resize: (cols, rows) => p.resize(clamp(cols, 2, 500), clamp(rows, 2, 200)),
    onData: (listener) => {
      p.onData(listener);
    },
    onExit: (listener) => {
      p.onExit(({ exitCode }) => listener(exitCode));
    },
    kill: () => {
      try {
        p.kill();
      } catch {
        // Already exited.
      }
    },
  };
}

/** Herdr pane ids ("w5Y:p1") and tmux pane ids ("%12"). */
const PANE_RE = /^[A-Za-z0-9_][A-Za-z0-9_:%.-]{0,99}$/;

/** The terminal a local Herdr pane runs, from `herdr pane get`. */
function localPaneTerminal(server: string, pane: string): string {
  const out = execFileSync("herdr", ["--session", server, "pane", "get", pane], { encoding: "utf8", timeout: 5_000, env: childEnv(true) });
  const id = (JSON.parse(out) as { result?: { pane?: { terminal_id?: unknown } } }).result?.pane?.terminal_id;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error("That pane is not open anymore.");
  return id;
}

/** A login shell in a project folder: `phren-hook v1 shell` remotely, the owner's shell locally. */
export function attachShell(c: Computer, folder: string, cols: number, rows: number): TerminalSession {
  if (typeof folder !== "string" || !folder.startsWith("/") || folder.length > 4096 || /[\x00-\x1f\x7f]/.test(folder)) throw new Error("invalid folder");
  if (!c.local) {
    const encoded = Buffer.from(folder, "utf8").toString("base64url");
    return wrap(spawnPty("ssh", sshArgs(c, `phren-hook v1 shell ${encoded}`, { tty: true }), cols, rows, false));
  }
  const shell = process.env.SHELL && process.env.SHELL.startsWith("/") ? process.env.SHELL : "/bin/zsh";
  ensureSpawnHelper();
  return wrap(pty.spawn(shell, ["-l"], { name: "xterm-256color", cols: clamp(cols, 2, 500), rows: clamp(rows, 2, 200), cwd: folder, env: childEnv(true) }));
}

/** A whole Herdr or tmux server, or with `pane`, one Herdr pane's own terminal (the console view). */
export const attachTerminal: AttachTerminal = (c: Computer, server: string, cols: number, rows: number, pane?: string): TerminalSession => {
  if (!SERVER_RE.test(server)) throw new Error(`invalid server name: ${server}`);
  if (pane !== undefined && !PANE_RE.test(pane)) throw new Error(`invalid pane: ${pane}`);
  if (!c.local) {
    const command = pane === undefined ? `phren-hook v1 terminal ${server}` : `phren-hook v1 pane ${server} ${pane}`;
    return wrap(spawnPty("ssh", sshArgs(c, command, { tty: true }), cols, rows, false));
  }
  if (pane !== undefined) {
    if (server === "tmux" || server.startsWith("tmux-")) throw new Error("A single pane's console needs Herdr.");
    return wrap(spawnPty("herdr", ["--session", server, "terminal", "attach", localPaneTerminal(server, pane)], cols, rows, true));
  }
  const { file, args } = localCommand(server);
  return wrap(spawnPty(file, args, cols, rows, true));
};

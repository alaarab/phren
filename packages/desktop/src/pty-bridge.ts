// pty-bridge: attach a local or remote multiplexer to a node-pty terminal.
import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import * as pty from "node-pty";
import { sideChannelPool, type AcquiredChannel } from "./channel-pool.js";
import { masterKey, sshArgs } from "./hosts.js";
import type { AttachTerminal, Computer, TerminalSession } from "./contract.js";

// No leading dot or dash: the name is an argv entry for tmux or herdr.
const SERVER_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const require = createRequire(import.meta.url);
let helperChecked = false;
/** Queued this long for an SSH channel, a terminal says so. */
const WAIT_NOTICE_MS = 2_000;
/** Input held for a terminal that has not started yet. */
const MAX_PENDING_BYTES = 1024 * 1024;

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

/** A remote ssh terminal that holds one pooled channel for its life, like a
 * chat pipe, so terminals share the computer's master slots. The session is
 * returned at once; the pty starts when the pool grants a channel, with input,
 * resizes and listeners held until then. The channel is released exactly once:
 * on exit, on kill (including before the pty started), or on a spawn failure. */
function pooledSession(c: Computer, command: string, cols: number, rows: number): TerminalSession {
  const controller = new AbortController();
  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<(code: number) => void> = [];
  const pending: Array<(p: pty.IPty) => void> = [];
  let channel: AcquiredChannel | undefined;
  let released = false;
  let ended = false;
  let p: pty.IPty | undefined;
  const release = (): void => {
    if (released) return;
    released = true;
    channel?.release();
  };
  const end = (code: number): void => {
    if (ended) return;
    ended = true;
    release();
    for (const listener of exitListeners) listener(code);
  };
  const say = (text: string): void => { for (const listener of dataListeners) listener(`\r\n${text}\r\n`); };
  let pendingBytes = 0;
  let dropped = false;
  let size = { cols, rows };
  // Tell the user while queued: a terminal that shows nothing looks hung.
  const waitingNotice = setTimeout(() => say(`Waiting for a free SSH channel to ${c.name}…`), WAIT_NOTICE_MS);
  sideChannelPool.acquire(masterKey(c), { signal: controller.signal }).then((acquired) => {
    clearTimeout(waitingNotice);
    channel = acquired;
    if (ended) { release(); return; }
    try {
      p = spawnPty("ssh", sshArgs(c, command, { tty: true, slot: acquired.slot }), size.cols, size.rows, false);
    } catch {
      end(1);
      return;
    }
    p.onData((data) => { for (const listener of dataListeners) listener(data); });
    p.onExit(({ exitCode }) => end(exitCode));
    if (dropped) say("Input typed while waiting for an SSH channel was too large and was dropped.");
    for (const action of pending.splice(0)) action(p);
  }, () => {
    clearTimeout(waitingNotice);
    if (!ended) say(`No free SSH channel to ${c.name}; close a terminal or preview.`);
    end(1);
  });
  return {
    write: (data) => {
      if (p) { p.write(data); return; }
      if (ended) return;
      // Bound what is held before the pty starts.
      if (pendingBytes + data.length > MAX_PENDING_BYTES) { dropped = true; return; }
      pendingBytes += data.length;
      pending.push((live) => live.write(data));
    },
    resize: (w, h) => {
      const next = { cols: clamp(w, 2, 500), rows: clamp(h, 2, 200) };
      if (p) p.resize(next.cols, next.rows);
      else size = next;
    },
    onData: (listener) => { dataListeners.push(listener); },
    onExit: (listener) => { exitListeners.push(listener); },
    kill: () => {
      clearTimeout(waitingNotice);
      controller.abort();
      try {
        p?.kill();
      } catch {
        // Already exited.
      }
      if (!p) end(0);
      else release();
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
    return pooledSession(c, `phren-hook v1 shell ${encoded}`, cols, rows);
  }
  const shell = process.env.SHELL && process.env.SHELL.startsWith("/") ? process.env.SHELL : "/bin/zsh";
  ensureSpawnHelper();
  return wrap(pty.spawn(shell, ["-l"], { name: "xterm-256color", cols: clamp(cols, 2, 500), rows: clamp(rows, 2, 200), cwd: folder, env: childEnv(true) }));
}

/** A whole Herdr or tmux server, or with `pane`, that pane's terminal (the console view). */
export const attachTerminal: AttachTerminal = (c: Computer, server: string, cols: number, rows: number, pane?: string): TerminalSession => {
  if (!SERVER_RE.test(server)) throw new Error(`invalid server name: ${server}`);
  if (pane !== undefined && !PANE_RE.test(pane)) throw new Error(`invalid pane: ${pane}`);
  if (!c.local) {
    const command = pane === undefined ? `phren-hook v1 terminal ${server}` : `phren-hook v1 pane ${server} ${pane}`;
    return pooledSession(c, command, cols, rows);
  }
  if (pane !== undefined) {
    if (server === "tmux" || server.startsWith("tmux-")) {
      if (!/^p\d{1,9}$/.test(pane)) throw new Error("Invalid tmux pane.");
      const socket = server === "tmux" ? [] : ["-L", server.slice("tmux-".length)];
      // Resolve the pane's session and window too, so attach never chooses the
      // default session or a similarly named target. Hook ids p42 mean %42.
      const target = execFileSync("tmux", [...socket, "display-message", "-p", "-t", `%${pane.slice(1)}`, "#{session_id}:#{window_id}.#{pane_id}"], { encoding: "utf8", timeout: 5_000, env: childEnv(true) }).trim();
      const resolved = /^(\$\d+):(@\d+)\.(%\d+)$/.exec(target);
      if (!resolved || resolved[3] !== `%${pane.slice(1)}`) throw new Error("That pane is not open anymore.");
      // attach-session takes a session. Select its window and pane explicitly
      // in the same tmux command queue rather than passing a pane as a session.
      return wrap(spawnPty("tmux", [...socket, "attach-session", "-t", resolved[1], ";", "select-window", "-t", `${resolved[1]}:${resolved[2]}`, ";", "select-pane", "-t", target], cols, rows, true));
    }
    return wrap(spawnPty("herdr", ["--session", server, "terminal", "attach", localPaneTerminal(server, pane)], cols, rows, true));
  }
  const { file, args } = localCommand(server);
  return wrap(spawnPty(file, args, cols, rows, true));
};

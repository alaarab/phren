// pty-bridge: attach a local or remote multiplexer to a node-pty terminal.
import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import os from "node:os";
import * as pty from "node-pty";
import { sshArgs } from "./hosts.js";
import type { AttachTerminal, Computer, TerminalSession } from "./contract.js";

const SERVER_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
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

/** Child env: always TERM, optionally stripped of nesting hints for local attaches. */
function childEnv(local: boolean): { [key: string]: string | undefined } {
  const env: { [key: string]: string | undefined } = { ...process.env, TERM: "xterm-256color" };
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

export const attachTerminal: AttachTerminal = (c: Computer, server: string, cols: number, rows: number): TerminalSession => {
  if (!c.local) {
    if (!SERVER_RE.test(server)) throw new Error(`invalid server name: ${server}`);
    return wrap(spawnPty("ssh", sshArgs(c, `phren-hook v1 terminal ${server}`, { tty: true }), cols, rows, false));
  }
  const { file, args } = localCommand(server);
  return wrap(spawnPty(file, args, cols, rows, true));
};

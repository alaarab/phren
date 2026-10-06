// A tmux test server outlives no run: the watchdog takes it down once its
// owner is killed outright, and the sweep clears what killed runs left.
// Against a real tmux; skipped without one.
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { resetTmuxBinary, tmuxBinary, tmuxSocketFolders } from "./terminal-tmux.js";
import { startWatchdog, sweepTestServers } from "./tmux-test-server.js";

const saved = process.env.PHREN_TMUX;
delete process.env.PHREN_TMUX;
resetTmuxBinary();
const binary = tmuxBinary();
if (saved !== undefined) process.env.PHREN_TMUX = saved;
resetTmuxBinary();

const running = (socket: string) => { try { execFileSync(binary!, ["-L", socket, "has-session"], { stdio: "ignore" }); return true; } catch { return false; } };
const socketFile = (socket: string) => path.join(tmuxSocketFolders()[0]!, socket);

async function until(done: () => boolean, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  return done();
}

describe.skipIf(!binary || process.platform === "win32")("tmux test servers on a real tmux", () => {
  let owner: ChildProcess | undefined, socket = "";
  /** A server on a test socket owned by a stand-in test worker. */
  const ownedServer = (kind: string) => {
    owner = spawn("sleep", ["60"], { stdio: "ignore" });
    socket = `phren-${kind}-test-${owner.pid}`;
    execFileSync(binary!, ["-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", "it work", "sh"]);
    expect(running(socket)).toBe(true);
    return owner;
  };
  const killed = (child: ChildProcess) => new Promise(resolve => { child.once("exit", resolve); child.kill("SIGKILL"); });
  afterEach(() => {
    owner?.kill("SIGKILL");
    try { execFileSync(binary!, ["-L", socket, "kill-server"], { stdio: "ignore" }); } catch { /* gone */ }
  });

  it("kills the server and removes its socket once the worker that owns it is killed", async () => {
    const worker = ownedServer("watchdog");
    startWatchdog(worker.pid!, binary!, socket);
    await new Promise(resolve => setTimeout(resolve, 1_500));
    expect(running(socket)).toBe(true);
    await killed(worker);
    expect(await until(() => !running(socket) && !existsSync(socketFile(socket)))).toBe(true);
  }, 20_000);

  it("sweeps servers left by dead workers and leaves a live worker's alone", async () => {
    const live = ownedServer("live");
    const liveSocket = socket;
    const dead = spawn("sleep", ["60"], { stdio: "ignore" });
    const deadSocket = `phren-scroll-test-${dead.pid}`;
    execFileSync(binary!, ["-L", deadSocket, "-f", "/dev/null", "new-session", "-d", "-s", "phone launch", "sh"]);
    await killed(dead);
    try {
      expect(sweepTestServers(binary)).toContain(deadSocket);
      expect(running(deadSocket) || existsSync(socketFile(deadSocket))).toBe(false);
      expect(running(liveSocket)).toBe(true);
    } finally {
      try { execFileSync(binary!, ["-L", deadSocket, "kill-server"], { stdio: "ignore" }); } catch { /* gone */ }
    }
    expect(live.pid).toBeGreaterThan(0);
  }, 20_000);
});

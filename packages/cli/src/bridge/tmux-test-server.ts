// A real tmux server on a private socket for an integration test, torn down
// however the run ends: afterAll, the worker's exit or a signal, or (when the
// worker is killed outright, as a timed-out or interrupted run can be) a
// watchdog that outlives it. A leaked server shows on the phone as sessions
// nobody can close, and its socket piles up in the tmux folder.
import { execFileSync, spawn } from "node:child_process";
import { readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { tmuxSocketFolders } from "./terminal-tmux.js";

/** A test socket's name ends with the pid of the process that owns it. */
const TEST_SOCKET = /^phren-(?:[a-z]+-)*test(?:-[a-z]+)*-(\d+)$/;

/** The test socket for this process: `phren-<kind>-test-<pid>`. */
export function testSocketName(kind?: string): string {
  return `phren-${kind ? `${kind}-` : ""}test-${process.pid}`;
}

function removeServer(binary: string, socket: string): void {
  try { execFileSync(binary, ["-L", socket, "kill-server"], { stdio: "ignore", timeout: 5_000 }); } catch { /* already gone */ }
  // tmux can leave the socket file behind when the server is killed.
  for (const dir of tmuxSocketFolders()) { try { unlinkSync(path.join(dir, socket)); } catch { /* none */ } }
}

const WATCHDOG = `pid=$1; tmux=$2; sock=$3; shift 3
while kill -0 "$pid" 2>/dev/null; do sleep 1; done
"$tmux" -L "$sock" kill-server 2>/dev/null
rm -f "$@"`;

/** A detached shell that kills the server on `socket` and removes its socket
 * files once `pid` is gone. Answers its own pid. */
export function startWatchdog(pid: number, binary: string, socket: string): number | undefined {
  const files = tmuxSocketFolders().map(dir => path.join(dir, socket));
  const child = spawn("/bin/sh", ["-c", WATCHDOG, "phren-tmux-watchdog", String(pid), binary, socket, ...files], { detached: true, stdio: "ignore" });
  child.unref();
  return child.pid;
}

/** Registers the teardown of the server on `socket` before the test starts it.
 * `stop` is idempotent and synchronous, so the exit hook can call it too. */
export function privateTmuxServer(binary: string, socket: string): { stop: () => void } {
  let stopped = false;
  const watchdog = startWatchdog(process.pid, binary, socket);
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const onSignal = (signal: NodeJS.Signals) => {
    stop();
    // Nobody else handles it: die of it as the worker would have.
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  };
  function stop(): void {
    if (stopped) return;
    stopped = true;
    process.removeListener("exit", stop);
    for (const signal of signals) process.removeListener(signal, onSignal);
    removeServer(binary, socket);
    if (watchdog) { try { process.kill(watchdog); } catch { /* already gone */ } }
  }
  process.once("exit", stop);
  for (const signal of signals) process.once(signal, onSignal);
  return { stop };
}

/** Kills the servers and removes the sockets earlier test runs left behind:
 * test sockets whose owning process is gone. */
export function sweepTestServers(binary = "tmux"): string[] {
  const swept: string[] = [];
  for (const dir of tmuxSocketFolders()) {
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const pid = Number(TEST_SOCKET.exec(name)?.[1]);
      if (!pid || pid === process.pid || alive(pid)) continue;
      removeServer(binary, name);
      swept.push(name);
    }
  }
  return swept;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

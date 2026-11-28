import { execFile, type ChildProcess, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const probes = new Set<() => void>();
let stopping = false;

function track<T extends ChildProcess>(child: T, kill: (child: T) => void): T {
  if (!child.pid) return child;
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null) kill(child);
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
  };
  probes.add(stop);
  child.once("close", () => probes.delete(stop));
  return child;
}

const forceKill = (child: ChildProcess) => { child.kill("SIGKILL"); };

// Only use this for probes started in their own process group.
export function killProbeGroup(child: ChildProcess): void {
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* Fall back to the direct child. */ }
  }
  forceKill(child);
}

// Only short-lived checks opt in. Pane and worker launchers own their process lifetimes.
export function startProbe<T extends ChildProcess>(start: () => T, kill: (child: T) => void = forceKill): T {
  if (stopping) throw new Error("The Hook is shutting down.");
  return track(start(), kill);
}

type Output<T> = { stdout: T; stderr: T };
type ProbeOptions = ExecFileOptions & { input?: string };
export function execProbe(file: string, args: readonly string[], options: ProbeOptions & { encoding: "buffer" }): Promise<Output<Buffer>>;
export function execProbe(file: string, args: readonly string[], options: ProbeOptions & { encoding?: BufferEncoding }): Promise<Output<string>>;
export async function execProbe(file: string, args: readonly string[], { input, ...options }: ProbeOptions & { encoding?: BufferEncoding | "buffer" }): Promise<Output<string | Buffer>> {
  if (stopping) throw new Error("The Hook is shutting down.");
  const result = exec(file, args, options);
  if (result.child) track(result.child, forceKill);
  if (input !== undefined && result.child?.stdin) {
    // A command can exit before reading stdin, for example when authentication fails.
    result.child.stdin.on("error", () => {});
    result.child.stdin.end(input);
  }
  return result;
}

export function stopProbes(): void {
  stopping = true;
  for (const stop of probes) stop();
  probes.clear();
}

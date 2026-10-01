import { execFileSync } from "child_process";
import * as fs from "fs";

export interface SandboxDeps {
  /** Run one command; throws on failure. */
  run: (file: string, args: string[], env: NodeJS.ProcessEnv) => void;
  /** `ps` rows: pid and full command line. */
  processes: () => { pid: number; command: string }[];
  kill: (pid: number) => void;
}

const real: SandboxDeps = {
  run: (file, args, env) => { execFileSync(file, args, { env, stdio: "ignore", timeout: 15_000 }); },
  processes: () => {
    try {
      return execFileSync("ps", ["-Aww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 8_388_608 }).split("\n").flatMap(line => {
        const match = /^\s*(\d+)\s+(.*)$/.exec(line);
        return match ? [{ pid: Number(match[1]), command: match[2] }] : [];
      });
    } catch { return []; }
  },
  kill: pid => { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } },
};

/** Codex 0.158 leaves a detached `app-server --managed-daemon` (and its
 * `pid-update-loop`) per HOME, reparented to init. Stop whatever a run left
 * under `home`, then delete it. `codex app-server daemon stop` is the
 * graceful path; processes whose command line names the home are the net. */
export function removeSandboxHome(home: string, deps: SandboxDeps = real): void {
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: undefined };
  try { deps.run("codex", ["app-server", "daemon", "stop"], env); } catch { /* no codex, or no daemon */ }
  for (const { pid, command } of deps.processes()) {
    if (pid !== process.pid && command.includes(home) && /app-server|pid-update-loop/.test(command)) deps.kill(pid);
  }
  fs.rmSync(home, { recursive: true, force: true });
}

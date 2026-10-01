import { describe, expect, it } from "vitest";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { createShellTool, killForegroundCommands, OUTPUT_HEAD_CHARS, OUTPUT_TAIL_CHARS, removeSpillFiles } from "../tools/shell.js";

const posix = process.platform !== "win32";
const shellModule = fileURLToPath(new URL("../tools/shell.ts", import.meta.url));

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(check: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function readPid(file: string): number | null {
  try {
    const pid = Number(fs.readFileSync(file, "utf-8").trim());
    return pid > 0 ? pid : null;
  } catch { return null; }
}

/** A script that starts a foreground command whose grandchild writes its pid, then ends the way `how` says. */
function agentScript(pidFile: string, how: "exit" | "signal"): string {
  return `
    import { createShellTool } from ${JSON.stringify(shellModule)};
    import * as fs from "fs";
    void createShellTool().execute({ command: "sleep 30 & echo $! > ${pidFile}; wait" });
    const timer = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(pidFile)}) || !fs.readFileSync(${JSON.stringify(pidFile)}, "utf-8").trim()) return;
      clearInterval(timer);
      ${how === "exit" ? "process.exit(0);" : "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"}
    }, 20);
  `;
}

describe.skipIf(!posix)("foreground commands end with the agent", () => {
  it("killForegroundCommands kills a running command's whole process group", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phren-fg-"));
    const pidFile = path.join(dir, "pid");
    const running = createShellTool().execute({ command: `sleep 30 & echo $! > ${pidFile}; wait` });
    await waitFor(() => readPid(pidFile) !== null);
    const grandchild = readPid(pidFile)!;
    expect(alive(grandchild)).toBe(true);

    killForegroundCommands();
    const result = await running;
    expect(result.is_error).toBe(true);
    expect(result.output).toMatch(/Killed by SIGKILL/);
    await waitFor(() => !alive(grandchild));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  for (const how of ["exit", "SIGHUP", "SIGTERM"] as const) {
    it(`a command still running when the agent ends (${how}) is killed`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phren-fg-"));
      const pidFile = path.join(dir, "pid");
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", agentScript(pidFile, how === "exit" ? "exit" : "signal")], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on("exit", (code, signal) => resolve({ code, signal }));
      });
      if (how !== "exit") {
        await new Promise<void>((resolve) => child.stdout!.on("data", (d: Buffer) => { if (d.toString().includes("ready")) resolve(); }));
        child.kill(how);
      }
      const ended = await exited;
      if (how === "exit") expect(ended.code).toBe(0);
      else expect(ended.signal).toBe(how); // the default exit still happens
      const grandchild = readPid(pidFile)!;
      expect(grandchild).toBeGreaterThan(0);
      await waitFor(() => !alive(grandchild));
      fs.rmSync(dir, { recursive: true, force: true });
    }, 20_000);
  }
});

describe.skipIf(!posix)("full-output files", () => {
  it("are removed by removeSpillFiles (run at exit)", async () => {
    const result = await createShellTool().execute({ command: "seq 1 40000" });
    const file = /is in (\S+?\.log)/.exec(result.output)![1];
    expect(fs.existsSync(file)).toBe(true);
    removeSpillFiles();
    expect(fs.existsSync(file)).toBe(false);
    // Head and tail still came back to the model.
    expect(result.output.length).toBeLessThan(OUTPUT_HEAD_CHARS + OUTPUT_TAIL_CHARS + 500);
  });
});

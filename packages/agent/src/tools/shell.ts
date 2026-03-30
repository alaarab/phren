import { execFileSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { AgentTool } from "./types.js";
import { checkShellSafety, scrubEnv } from "../permissions/shell-safety.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 100_000;

// Background task tracking
const backgroundTasks = new Map<string, { pid: number; outputFile: string; done: boolean; exitCode: number | null }>();
let nextBgId = 1;

export const shellTool: AgentTool = {
  name: "shell",
  description: "Run a shell command and return stdout + stderr. Use run_in_background for long-running commands (builds, test suites, dev servers). Use description to explain what the command does.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute." },
      description: { type: "string", description: "Human-readable description of what this command does (shown to user)." },
      cwd: { type: "string", description: "Working directory. Defaults to process cwd." },
      timeout: { type: "number", description: "Timeout in ms. Default: 30000, max: 120000." },
      run_in_background: { type: "boolean", description: "If true, run in background and return a task_id. Use task_output to get results later." },
    },
    required: ["command"],
  },
  async execute(input) {
    const command = input.command as string;
    const cwd = (input.cwd as string) || process.cwd();
    const timeout = Math.min(MAX_TIMEOUT_MS, (input.timeout as number) || DEFAULT_TIMEOUT_MS);
    const description = input.description as string | undefined;
    const runInBackground = input.run_in_background as boolean;

    const safety = checkShellSafety(command);
    if (!safety.safe && safety.severity === "block") {
      return { output: `Blocked: ${safety.reason}`, is_error: true };
    }

    const isWindows = process.platform === "win32";
    const shell = isWindows ? "cmd" : "bash";
    const shellArgs = isWindows ? ["/c", command] : ["-c", command];

    // Background execution
    if (runInBackground) {
      const taskId = `bg-${nextBgId++}`;
      const outputFile = path.join(os.tmpdir(), `phren-bg-${taskId}.log`);
      const fd = fs.openSync(outputFile, "w");

      const child = spawn(shell, shellArgs, {
        cwd,
        stdio: ["ignore", fd, fd],
        env: scrubEnv(),
        detached: true,
      });

      const task = { pid: child.pid!, outputFile, done: false, exitCode: null as number | null };
      backgroundTasks.set(taskId, task);

      child.on("exit", (code) => {
        task.done = true;
        task.exitCode = code;
        fs.closeSync(fd);
      });

      child.unref();

      const desc = description ? ` (${description})` : "";
      return { output: `Background task ${taskId} started${desc}. PID: ${child.pid}. Use task_output to get results.` };
    }

    // Foreground execution
    try {
      const output = execFileSync(shell, shellArgs, {
        cwd,
        encoding: "utf-8",
        timeout,
        maxBuffer: MAX_OUTPUT_BYTES,
        stdio: ["ignore", "pipe", "pipe"],
        env: scrubEnv(),
      });
      return { output: output.trim() || "(no output)" };
    } catch (err: unknown) {
      if (err && typeof err === "object" && "stdout" in err) {
        const e = err as { stdout?: string; stderr?: string; status?: number };
        const combined = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();
        return { output: `Exit code ${e.status ?? 1}\n${combined}`, is_error: true };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { output: msg, is_error: true };
    }
  },
};

// Task output and stop tools
export const taskOutputTool: AgentTool = {
  name: "task_output",
  description: "Get output from a background shell task. Set block=true to wait for completion.",
  input_schema: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Background task ID (e.g. 'bg-1')." },
      block: { type: "boolean", description: "If true, wait for the task to complete before returning. Default: false." },
      timeout: { type: "number", description: "Max ms to wait when blocking. Default: 60000." },
    },
    required: ["task_id"],
  },
  async execute(input) {
    const taskId = input.task_id as string;
    const block = input.block as boolean;
    const timeout = (input.timeout as number) || 60_000;
    const task = backgroundTasks.get(taskId);

    if (!task) {
      const available = [...backgroundTasks.keys()].join(", ") || "none";
      return { output: `Task "${taskId}" not found. Available: ${available}`, is_error: true };
    }

    if (block && !task.done) {
      const start = Date.now();
      while (!task.done && Date.now() - start < timeout) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    const status = task.done ? `completed (exit ${task.exitCode})` : "running";
    let output = "";
    try { output = fs.readFileSync(task.outputFile, "utf-8"); } catch { /* no output yet */ }

    if (output.length > MAX_OUTPUT_BYTES) {
      output = output.slice(-MAX_OUTPUT_BYTES) + "\n... (truncated, showing last 100KB)";
    }

    return { output: `[${status}]\n${output.trim() || "(no output yet)"}` };
  },
};

export const taskStopTool: AgentTool = {
  name: "task_stop",
  description: "Stop a background shell task.",
  input_schema: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Background task ID to stop." },
    },
    required: ["task_id"],
  },
  async execute(input) {
    const taskId = input.task_id as string;
    const task = backgroundTasks.get(taskId);
    if (!task) return { output: `Task "${taskId}" not found.`, is_error: true };
    if (task.done) return { output: `Task "${taskId}" already finished.` };

    try { process.kill(task.pid, "SIGTERM"); } catch { /* already dead */ }
    task.done = true;
    task.exitCode = -1;
    return { output: `Task "${taskId}" stopped.` };
  },
};

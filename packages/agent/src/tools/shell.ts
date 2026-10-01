import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { AgentTool } from "./types.js";
import type { PermissionConfig } from "../permissions/types.js";
import { checkShellSafety, scrubEnv } from "../permissions/shell-safety.js";
import { wrapWithSandbox, classifySandboxDenial, SandboxRequiredError } from "../permissions/kernel-sandbox.js";

/** A positive whole number of ms from the environment, else the fallback. */
function envMs(key: string, fallback: number): number {
  const value = Number(process.env[key]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Foreground limits. A real test suite or build often needs minutes, and
 * weaker models handle background polling badly, so the cap is 10 minutes
 * (as in Claude Code). Override with PHREN_AGENT_SHELL_TIMEOUT_MS (default)
 * and PHREN_AGENT_SHELL_MAX_TIMEOUT_MS (cap).
 */
function shellTimeouts(): { defaultMs: number; maxMs: number } {
  const maxMs = envMs("PHREN_AGENT_SHELL_MAX_TIMEOUT_MS", 600_000);
  return { defaultMs: Math.min(maxMs, envMs("PHREN_AGENT_SHELL_TIMEOUT_MS", 120_000)), maxMs };
}

/** Background task_output reads are capped at this many trailing characters. */
const MAX_OUTPUT_BYTES = 100_000;

/**
 * Foreground output kept for the model: the head (what ran) and the tail
 * (test summaries, stack traces). Anything between is dropped with a marker
 * and the full output is kept in a log file the model can read.
 */
export const OUTPUT_HEAD_CHARS = 8_000;
export const OUTPUT_TAIL_CHARS = 24_000;
/** Stop writing the full-output file past this, so a runaway command can't fill the disk. */
const MAX_SPILL_BYTES = 50_000_000;

// Background task tracking
const backgroundTasks = new Map<string, { pid: number; outputFile: string; done: boolean; exitCode: number | null }>();

/**
 * Background task logs live in a private directory, not loose in os.tmpdir().
 *
 * On Linux /tmp is world-writable (mode 1777) and the task ids are sequential,
 * so `phren-bg-bg-1.log` was a name any other local account could predict and
 * pre-create as a symlink to a file this user can write — `openSync(…, "w")`
 * follows it, which turns a background shell command into an arbitrary-file
 * overwrite running as us. mkdtemp gives a 0700 directory with a random name,
 * and the "wx" flag refuses to open a path that already exists.
 */
let backgroundLogRoot: string | undefined;

function backgroundLogDir(): string {
  if (!backgroundLogRoot || !fs.existsSync(backgroundLogRoot)) {
    backgroundLogRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phren-bg-"));
  }
  return backgroundLogRoot;
}
let nextBgId = 1;
let nextSpillId = 1;

/** Interleaved stdout/stderr, keeping only the head and tail in memory. */
class OutputCapture {
  private head = "";
  private tail = "";
  private total = 0;
  private spillFd: number | null = null;
  private spillPath: string | null = null;
  private spilled = 0;

  push(chunk: string): void {
    const full = this.total <= OUTPUT_HEAD_CHARS + OUTPUT_TAIL_CHARS;
    this.total += chunk.length;
    if (full && this.total <= OUTPUT_HEAD_CHARS + OUTPUT_TAIL_CHARS) {
      // Still small enough to hold whole: everything lives in head.
      this.head += chunk;
      return;
    }
    if (full) {
      // Crossing the limit: start the full-output file with what we have.
      const all = this.head + chunk;
      this.openSpill(all.slice(0, all.length - chunk.length));
      this.head = all.slice(0, OUTPUT_HEAD_CHARS);
      this.tail = all.slice(OUTPUT_HEAD_CHARS).slice(-OUTPUT_TAIL_CHARS);
    } else {
      this.tail = (this.tail + chunk).slice(-OUTPUT_TAIL_CHARS);
    }
    this.writeSpill(chunk);
  }

  private openSpill(initial: string): void {
    try {
      this.spillPath = path.join(backgroundLogDir(), `shell-${nextSpillId++}.log`);
      this.spillFd = fs.openSync(this.spillPath, "wx");
      this.writeSpill(initial);
    } catch {
      this.spillFd = null;
      this.spillPath = null;
    }
  }

  private writeSpill(text: string): void {
    if (this.spillFd === null || this.spilled >= MAX_SPILL_BYTES) return;
    try {
      this.spilled += fs.writeSync(this.spillFd, text);
    } catch { /* best effort */ }
  }

  /** The model-visible text: whole when small, else head + marker + tail. */
  finish(): string {
    if (this.spillFd !== null) {
      try { fs.closeSync(this.spillFd); } catch { /* already closed */ }
      this.spillFd = null;
    }
    if (this.total <= OUTPUT_HEAD_CHARS + OUTPUT_TAIL_CHARS) return this.head.trim();
    const omitted = this.total - this.head.length - this.tail.length;
    const where = this.spillPath
      ? ` Full output (${this.total} chars${this.spilled >= MAX_SPILL_BYTES ? `, file capped at ${MAX_SPILL_BYTES} bytes` : ""}) is in ${this.spillPath}; read or grep it for the middle.`
      : "";
    return `${this.head}\n\n... [${omitted} chars of output omitted.${where}] ...\n\n${this.tail}`.trim();
  }
}

interface ForegroundResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  timedOut: boolean;
  aborted: boolean;
  error?: Error;
}

/**
 * Run a command to completion without a size limit: output streams into an
 * OutputCapture, so a verbose command is never killed for printing too much
 * and its real exit code is reported. On POSIX the command gets its own
 * process group so a timeout or cancel also kills what it spawned.
 */
function runForeground(
  exe: string,
  args: string[],
  opts: { cwd: string; timeout: number; signal?: AbortSignal },
): Promise<ForegroundResult> {
  return new Promise((resolve) => {
    const capture = new OutputCapture();
    const posix = process.platform !== "win32";
    let timedOut = false;
    let aborted = false;
    let settled = false;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(exe, args, {
        cwd: opts.cwd,
        env: scrubEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        detached: posix,
      });
    } catch (err: unknown) {
      resolve({ code: null, signal: null, output: "", timedOut, aborted, error: err instanceof Error ? err : new Error(String(err)) });
      return;
    }

    const kill = () => {
      try {
        if (posix && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* already gone */ }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, opts.timeout);
    const onAbort = () => { aborted = true; kill(); };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => capture.push(chunk));
    child.stderr?.on("data", (chunk: string) => capture.push(chunk));

    const done = (result: Omit<ForegroundResult, "output" | "timedOut" | "aborted">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ ...result, output: capture.finish(), timedOut, aborted });
    };
    child.on("error", (err) => done({ code: null, signal: null, error: err }));
    // "close" fires after stdio drains, so the tail is complete.
    child.on("close", (code, signal) => done({ code, signal }));
  });
}

/**
 * Shell tool factory. `getPermissions` is read per call so /permissions and
 * /sandbox changes apply live; the kernel write fence derives its writable
 * roots from the SAME config as the in-process path sandbox.
 */
export function createShellTool(getPermissions?: () => PermissionConfig): AgentTool {
  return {
    name: "shell",
    // Give the scheduler a little headroom over the internal cap so the
    // tool's own richer timeout message wins the race.
    timeoutMs: shellTimeouts().maxMs + 5_000,
    description: "Run a shell command and return stdout + stderr. Use run_in_background for long-running commands (builds, test suites, dev servers). Use description to explain what the command does.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute." },
        description: { type: "string", description: "Human-readable description of what this command does (shown to user)." },
        cwd: { type: "string", description: "Working directory. Defaults to process cwd." },
        timeout: { type: "number", description: `Timeout in ms. Default: ${shellTimeouts().defaultMs}, max: ${shellTimeouts().maxMs}.` },
        run_in_background: { type: "boolean", description: "If true, run in background and return a task_id. Use task_output to get results later." },
      },
      required: ["command"],
    },
    async execute(input, signal) {
      const command = input.command as string;
      const cwd = (input.cwd as string) || process.cwd();
      const limits = shellTimeouts();
      const timeout = Math.min(limits.maxMs, (input.timeout as number) || limits.defaultMs);
      const description = input.description as string | undefined;
      const runInBackground = input.run_in_background as boolean;

      const safety = checkShellSafety(command);
      if (!safety.safe && safety.severity === "block") {
        return { output: `Blocked: ${safety.reason}`, is_error: true, permissionDenied: true };
      }

      const isWindows = process.platform === "win32";
      const shell = isWindows ? "cmd" : "bash";
      const shellArgs = isWindows ? ["/c", command] : ["-c", command];

      // Kernel write fence — one decision feeds both spawn paths.
      const perms = getPermissions?.();
      let decision: { argv: string[]; sandboxed: boolean; notice?: string };
      try {
        decision = wrapWithSandbox([shell, ...shellArgs], {
          mode: perms?.sandboxMode ?? "off",
          workspaceRoot: perms?.projectRoot ?? process.cwd(),
          extraWritable: perms?.allowedPaths ?? [],
        });
      } catch (err: unknown) {
        if (err instanceof SandboxRequiredError) {
          return { output: err.message, is_error: true, permissionDenied: true };
        }
        throw err;
      }
      const noticePrefix = decision.notice ? `${decision.notice}\n` : "";
      const [exe, ...exeArgs] = decision.argv;

      // Background execution
      if (runInBackground) {
        const taskId = `bg-${nextBgId++}`;
        const outputFile = path.join(backgroundLogDir(), `${taskId}.log`);
        const fd = fs.openSync(outputFile, "wx");

        const child = spawn(exe, exeArgs, {
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
        const confined = decision.sandboxed ? " [sandboxed]" : "";
        return { output: `${noticePrefix}Background task ${taskId} started${desc}${confined}. PID: ${child.pid}. Use task_output to get results.` };
      }

      // Foreground execution — async so concurrent tool batches actually run
      // concurrently and the scheduler's abort signal can kill a hung command.
      const result = await runForeground(exe, exeArgs, { cwd, timeout, signal });
      if (result.error) return { output: noticePrefix + result.error.message, is_error: true };
      const combined = result.output;
      if (result.aborted) {
        return { output: `${noticePrefix}Command was cancelled\n${combined}`.trim(), is_error: true };
      }
      if (result.timedOut) {
        return {
          output: `${noticePrefix}Command timed out after ${timeout}ms (pass a larger timeout, up to ${limits.maxMs}ms, or use run_in_background)\n${combined}`.trim(),
          is_error: true,
        };
      }
      if (result.code === 0) return { output: noticePrefix + (combined || "(no output)") };
      // Explain kernel write-fence denials so the model redirects instead
      // of retrying (classify combined output — commands often 2>&1)
      const denial = decision.sandboxed
        ? classifySandboxDenial(combined, perms?.projectRoot ?? process.cwd())
        : null;
      const status = result.code !== null ? `Exit code ${result.code}` : `Killed by ${result.signal ?? "signal"}`;
      return { output: `${noticePrefix}${status}\n${combined}${denial ?? ""}`, is_error: true };
    },
  };
}

/** Back-compat singleton: no permission source, so the sandbox stays off. */
export const shellTool: AgentTool = createShellTool();

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

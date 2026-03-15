import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync, spawnSync, spawn } from "child_process";
import { PhrenResult, writeRootManifest } from "./shared.js";

export function initTestPhrenRoot(
  phrenDir: string,
  options: {
    installMode?: "shared" | "project-local";
    syncMode?: "managed-git" | "workspace-git";
    workspaceRoot?: string;
    primaryProject?: string;
  } = {},
): void {
  writeRootManifest(phrenDir, {
    version: 1,
    installMode: options.installMode ?? "shared",
    syncMode: options.syncMode ?? "managed-git",
    workspaceRoot: options.workspaceRoot,
    primaryProject: options.primaryProject,
  });
}

/**
 * Create a temp directory and return its path + cleanup function.
 */
export function makeTempDir(prefix: string): { path: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    path: dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // On Windows, SQLite WAL files or antivirus scans can briefly lock files
        // after a process exits, causing ENOTEMPTY/EBUSY. Safe to ignore for temp dirs.
      }
    },
  };
}

export interface IsolatedCliEnv {
  rootDir: string;
  phrenDir: string;
  homeDir: string;
  cleanup: () => void;
  env: (extra?: Record<string, string>) => Record<string, string>;
}

/**
 * Create an isolated HOME + PHREN_PATH pair for CLI subprocess tests.
 */
export function setupIsolatedCliEnv(prefix: string): IsolatedCliEnv {
  const tmp = makeTempDir(prefix);
  const phrenDir = path.join(tmp.path, ".phren");
  const homeDir = path.join(tmp.path, "home");
  fs.mkdirSync(homeDir, { recursive: true });

  return {
    rootDir: tmp.path,
    phrenDir,
    homeDir,
    cleanup: tmp.cleanup,
    env: (extra: Record<string, string> = {}) => ({
      PHREN_PATH: phrenDir,
      HOME: homeDir,
      USERPROFILE: homeDir,
      ...extra,
    }),
  };
}

/**
 * Legacy helper — RBAC was removed. Now just ensures phren root is initialized.
 */
export function grantAdmin(phrenDir: string, actor = "vitest-admin"): string {
  if (!fs.existsSync(path.join(phrenDir, "phren.root.yaml"))) {
    initTestPhrenRoot(phrenDir);
  }
  return actor;
}

/**
 * Recursively create parent dirs and write a file.
 */
export function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

/**
 * Extract the user-facing message from a PhrenResult<string>.
 */
export function resultMsg(r: PhrenResult<unknown>): string {
  if (!r.ok) return r.error;
  return typeof r.data === "string" ? r.data : JSON.stringify(r.data);
}

// ── Shared CLI subprocess helpers ────────────────────────────────────────────

export const CLI_PATH = path.resolve(__dirname, "../dist/index.js");
export const REPO_ROOT = path.resolve(__dirname, "../..");
const CLI_BUILD_LOCK = path.join(REPO_ROOT, ".vitest-cli-build.lock");
const CLI_BUILD_WAIT = new Int32Array(new SharedArrayBuffer(4));

function npmExec(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

/**
 * Ensure the built CLI entry exists before spawning subprocess-based integration
 * tests. globalSetup handles the common case, while this guard repairs a missing
 * artifact mid-run under a file lock so parallel workers do not stampede.
 */
export function ensureCliBuilt(): void {
  if (fs.existsSync(CLI_PATH)) return;

  const staleMs = 120_000;
  const pollMs = 100;
  const maxWaitMs = 180_000;
  let waited = 0;
  let hasLock = false;

  while (!hasLock && waited <= maxWaitMs) {
    try {
      fs.writeFileSync(CLI_BUILD_LOCK, `${process.pid}\n${Date.now()}`, { flag: "wx" });
      hasLock = true;
      break;
    } catch {
      if (fs.existsSync(CLI_PATH)) return;
      try {
        const stat = fs.statSync(CLI_BUILD_LOCK);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.unlinkSync(CLI_BUILD_LOCK);
          continue;
        }
      } catch {
        // Lock disappeared between stat attempts; retry.
      }
      Atomics.wait(CLI_BUILD_WAIT, 0, 0, pollMs);
      waited += pollMs;
    }
  }

  if (!hasLock) {
    if (fs.existsSync(CLI_PATH)) return;
    throw new Error(`Timed out waiting for CLI build artifact: ${CLI_PATH}`);
  }

  try {
    if (!fs.existsSync(CLI_PATH)) {
      execFileSync(npmExec(), ["run", "build"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
        timeout: 180_000,
      });
    }
  } finally {
    try {
      fs.unlinkSync(CLI_BUILD_LOCK);
    } catch {
      // Another waiter may have already cleaned up a stale lock path.
    }
  }
}

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run the built CLI binary via execFileSync and return stdout/stderr/exitCode.
 * Callers that need spawnSync semantics (e.g. when expecting non-zero exits)
 * may use runCliSpawn instead.
 */
export function runCliExec(args: string[], env: Record<string, string> = {}): CliResult {
  try {
    ensureCliBuilt();
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout?.toString() || "",
      stderr: err.stderr?.toString() || "",
      exitCode: err.status ?? 1,
    };
  }
}

/**
 * Run the built CLI binary via spawnSync and return stdout/stderr/exitCode.
 * Preferred when the test needs to observe non-zero exit codes cleanly.
 */
export function runCliSpawn(args: string[], env: Record<string, string> = {}): CliResult {
  ensureCliBuilt();
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
  });
  if (result.error) throw result.error;
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status ?? 1,
  };
}

/**
 * Spawn a short-lived Node.js subprocess that evaluates `code` via tsx.
 * Used for cross-process concurrency tests.
 */
export function spawnTsxWorker(code: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "-e", code], {
      cwd: REPO_ROOT,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (codeNum) => {
      resolve({ exitCode: codeNum ?? 1, stdout, stderr });
    });
  });
}

// ── Stdout/stderr suppression helper ─────────────────────────────────────────

/**
 * Run `fn` while swallowing all process.stdout, process.stderr, console.log,
 * and console.error output.  Useful for silencing verbose CLI init/add flows
 * during integration tests so CI and release logs are easier to scan.
 *
 * The stdout/stderr noop shim still invokes any trailing flush callback so
 * that internal Promise-based flush helpers (e.g. `process.stdout.write("", cb)`)
 * resolve normally instead of hanging.
 */
export async function suppressOutput<T>(fn: () => Promise<T>): Promise<T> {
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origConsoleLog = console.log;
  const origConsoleError = console.error;
  const origConsoleWarn = console.warn;

  // Accept the same overload signatures as stream.Writable.write and invoke
  // any trailing callback so that flush-style callers don't hang.
  const noopWrite = (_chunk: any, _encodingOrCb?: any, cb?: () => void): boolean => {
    const callback = typeof _encodingOrCb === "function" ? _encodingOrCb : cb;
    if (typeof callback === "function") callback();
    return true;
  };
  const noopConsole = () => { /* suppressed */ };

  process.stdout.write = noopWrite as any;
  process.stderr.write = noopWrite as any;
  console.log = noopConsole;
  console.error = noopConsole;
  console.warn = noopConsole;
  try {
    return await fn();
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    console.log = origConsoleLog;
    console.error = origConsoleError;
    console.warn = origConsoleWarn;
  }
}

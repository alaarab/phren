import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync, spawnSync, spawn } from "child_process";
import { CortexResult } from "./shared.js";

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
  cortexDir: string;
  homeDir: string;
  cleanup: () => void;
  env: (extra?: Record<string, string>) => Record<string, string>;
}

/**
 * Create an isolated HOME + CORTEX_PATH pair for CLI subprocess tests.
 */
export function setupIsolatedCliEnv(prefix: string): IsolatedCliEnv {
  const tmp = makeTempDir(prefix);
  const cortexDir = path.join(tmp.path, ".cortex");
  const homeDir = path.join(tmp.path, "home");
  fs.mkdirSync(homeDir, { recursive: true });

  return {
    rootDir: tmp.path,
    cortexDir,
    homeDir,
    cleanup: tmp.cleanup,
    env: (extra: Record<string, string> = {}) => ({
      CORTEX_PATH: cortexDir,
      HOME: homeDir,
      USERPROFILE: homeDir,
      ...extra,
    }),
  };
}

/**
 * Write governance access-control.json granting admin to the given actor,
 * and set CORTEX_ACTOR in process.env. Returns the actor name.
 */
export function grantAdmin(cortexDir: string, actor = "vitest-admin"): string {
  const govDir = path.join(cortexDir, ".governance");
  fs.mkdirSync(govDir, { recursive: true });
  fs.writeFileSync(
    path.join(govDir, "access-control.json"),
    JSON.stringify({
      admins: [actor],
      maintainers: [],
      contributors: [],
      viewers: [],
    }, null, 2) + "\n"
  );
  process.env.CORTEX_ACTOR = actor;
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
 * Extract the user-facing message from a CortexResult<string>.
 */
export function resultMsg(r: CortexResult<string>): string {
  return r.ok ? r.data : r.error;
}

// ── Shared CLI subprocess helpers ────────────────────────────────────────────

export const CLI_PATH = path.resolve(__dirname, "../dist/index.js");
export const REPO_ROOT = path.resolve(__dirname, "../..");

let _cliBuilt = false;

/**
 * Build the CLI once per process if the dist artifact is missing.
 * Subsequent calls are no-ops once the binary exists.
 */
export function ensureCliBuilt(): void {
  if (fs.existsSync(CLI_PATH)) {
    _cliBuilt = true;
    return;
  }
  if (_cliBuilt) return;
  execFileSync("npm", ["run", "build"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
  });
  _cliBuilt = true;
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

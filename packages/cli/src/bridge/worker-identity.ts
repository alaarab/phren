import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { BridgeError, bridgeRoot } from "./protocol.js";

/**
 * A keyed worker's durable identity: the PID and start time written by the
 * launch wrapper before it execs the harness, plus the launch lock that says
 * whether the launch handler is still placing it. Both survive a Hook restart
 * and a replacement session in the same pane has a different PID or start time.
 */

const exec = promisify(execFile);
const dispatchId = z.string().uuid();

export interface LaunchLock { file: string; nonce: string; pid: number; start?: string }
export type WorkerLiveness = "alive" | "gone" | "unknown";
export const SUBMITTED_GRACE_MS = 120_000;

export function workerFilePath(id: string): string {
  return path.join(bridgeRoot(), "clones", `${dispatchId.parse(id)}.worker`);
}
export function launchLockFile(id: string): string {
  return path.join(bridgeRoot(), "clones", `${dispatchId.parse(id)}.launching`);
}
export function submittedFilePath(id: string): string {
  return path.join(bridgeRoot(), "clones", `${dispatchId.parse(id)}.submitted`);
}

/** Mark a launch as submitted before its command is typed or spawned. */
export async function markSubmitted(id: string, at = new Date()): Promise<string> {
  const file = submittedFilePath(id);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, at.toISOString(), { mode: 0o600 });
  return at.toISOString();
}

async function submittedTime(id: string, fallback?: string): Promise<string | undefined> {
  const text = await readFile(submittedFilePath(id), "utf8").catch(() => undefined);
  const value = text?.trim();
  if (value) {
    const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  if (fallback && Number.isFinite(Date.parse(fallback))) return fallback;
  return undefined;
}

/** Normalize `ps -o lstart=` and the wrapper's `tr -s " "` output to one form. */
function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/** The process's start time, or undefined when no process has that PID. Throws when ps itself fails. */
export async function processStartTime(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await exec("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 3_000, maxBuffer: 4_096 });
    return normalize(stdout) || undefined;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return undefined;
    throw error;
  }
}

/** Whether the PID still belongs to the process that wrote `start`. */
export async function processMatches(pid: number, start: string | undefined): Promise<WorkerLiveness> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  let actual: string | undefined;
  try { actual = await processStartTime(pid); } catch { return "unknown"; }
  if (!actual) return "gone";
  if (!start) return "unknown";
  return actual === normalize(start) ? "alive" : "gone";
}

function parseWorker(text: string): { pid: number; start: string } | undefined {
  const match = /^(\d+)\s+(.+)$/.exec(text.trim());
  if (!match) return undefined;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return { pid, start: normalize(match[2]) };
}

/** The recorded worker process, if the identity file is readable and well-formed. */
export async function workerPid(id: string, file = workerFilePath(id)): Promise<{ pid: number; start: string } | undefined> {
  const text = await readFile(file, "utf8").catch(() => undefined);
  return text === undefined ? undefined : parseWorker(text);
}

function parseLock(text: string): { pid: number; start?: string; nonce: string } | undefined {
  try {
    const value = z.object({ pid: z.number().int().positive(), start: z.string().optional(), nonce: z.string().min(1) }).parse(JSON.parse(text));
    return value;
  } catch { return undefined; }
}

/** A held launch lock whose owner is alive means the launch is still placing. */
export async function launchInProgress(id: string): Promise<boolean> {
  const file = launchLockFile(id);
  const text = await readFile(file, "utf8").catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (text === undefined) return false;
  const lock = parseLock(text);
  if (!lock) {
    // A crash can leave a partial lock. It is stale once the launch's own
    // bounded window has passed; until then, fail closed.
    const info = await lstat(file).catch(() => undefined);
    return !!info && Date.now() - info.mtimeMs < 5 * 60_000;
  }
  return await processMatches(lock.pid, lock.start) !== "gone";
}

/** Whether a `ps -E` command line carries exactly our worker-file marker. */
function carriesMarker(command: string, file: string): boolean {
  const marker = `PHREN_WORKER_ID_FILE=${file}`;
  const at = command.indexOf(marker);
  if (at < 0) return false;
  const before = at === 0 ? " " : command[at - 1];
  const after = command[at + marker.length] ?? " ";
  return /\s/.test(before) && /\s/.test(after);
}

const PS_LINE = /^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;

export type WorkerScan = { ok: true; worker?: { pid: number; start: string } } | { ok: false };
type ProcessScanner = (file: string) => Promise<WorkerScan>;
let processScanner: ProcessScanner | undefined;
/** Only for tests: replace the real same-user process scan. */
export function setWorkerProcessScan(scanner: ProcessScanner | undefined): void {
  processScanner = scanner;
}

/** A successful same-user process scan: the worker carrying our marker, if any. */
async function scanWorker(file: string): Promise<WorkerScan> {
  if (processScanner) return processScanner(file);
  try {
    if (process.platform === "darwin") {
      const { stdout } = await exec("ps", ["-axww", "-E", "-o", "pid=,lstart=,command="], { timeout: 5_000, maxBuffer: 16_777_216 });
      for (const line of stdout.split("\n")) {
        const match = PS_LINE.exec(line);
        if (!match || !carriesMarker(match[3], file)) continue;
        return { ok: true, worker: { pid: Number(match[1]), start: normalize(match[2]) } };
      }
      return { ok: true };
    }
    if (process.platform === "linux") {
      const { stdout } = await exec("ps", ["-eww", "-o", "pid=,lstart=,args="], { timeout: 5_000, maxBuffer: 16_777_216 });
      const marker = `PHREN_WORKER_ID_FILE=${file}`;
      for (const line of stdout.split("\n")) {
        const match = PS_LINE.exec(line);
        if (!match) continue;
        const pid = Number(match[1]);
        const environ = await readFile(`/proc/${pid}/environ`).catch(() => undefined);
        if (!environ || !environ.includes(`${marker}\0`)) continue;
        return { ok: true, worker: { pid, start: normalize(match[2]) } };
      }
      return { ok: true };
    }
    return { ok: false };
  } catch { return { ok: false }; }
}

/**
 * The worker's liveness. A present identity file is authoritative. Without one,
 * a same-user process carrying this launch's worker-file marker is adopted;
 * otherwise the submitted marker and the launch lock decide whether no worker
 * can still be starting.
 */
export async function workerAlive(id: string, file = workerFilePath(id), submittedAt?: string): Promise<WorkerLiveness> {
  let lockLive = false;
  try { lockLive = await launchInProgress(id); } catch { return "unknown"; }
  let text: string | undefined;
  try { text = await readFile(file, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unknown";
  }
  if (text !== undefined) {
    const worker = parseWorker(text);
    return worker ? processMatches(worker.pid, worker.start) : "unknown";
  }
  if (lockLive) return "unknown";
  const scan = await scanWorker(file);
  if (!scan.ok) return "unknown";
  if (scan.worker) {
    try {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, `${scan.worker.pid} ${scan.worker.start}\n`, { mode: 0o600 });
    } catch { return "unknown"; }
    return processMatches(scan.worker.pid, scan.worker.start);
  }
  const submitted = await submittedTime(id, submittedAt);
  if (!submitted) return "gone";
  if (Date.now() - Date.parse(submitted) > SUBMITTED_GRACE_MS) return "gone";
  return "unknown";
}

/** Hold the launch lock for one keyed dispatch; a stale lock is replaced. */
export async function acquireLaunchLock(id: string): Promise<LaunchLock> {
  const file = launchLockFile(id);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const start = await processStartTime(process.pid).catch(() => undefined);
  const nonce = randomUUID();
  const lock: LaunchLock = { file, nonce, pid: process.pid, ...(start ? { start } : {}) };
  const body = JSON.stringify(lock);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(file, body, { flag: "wx", mode: 0o600 });
      return lock;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await launchInProgress(id)) throw new BridgeError(409, "This dispatch's launch is already in progress.");
      await unlink(file).catch(() => undefined);
    }
  }
  throw new BridgeError(503, "The dispatch launch lock is busy; retry.");
}

export async function releaseLaunchLock(lock: LaunchLock): Promise<void> {
  const text = await readFile(lock.file, "utf8").catch(() => undefined);
  if (text === undefined) return;
  try {
    if (JSON.parse(text).nonce === lock.nonce) await unlink(lock.file).catch(() => undefined);
  } catch { /* a replaced lock is not ours to remove */ }
}

/** Remove the worker identity and its temporary file after a confirmed termination. */
export async function removeWorkerFile(id: string): Promise<void> {
  const file = workerFilePath(id);
  await unlink(`${file}.tmp`).catch(() => undefined);
  await unlink(file).catch(() => undefined);
}

/** SIGTERM the recorded process, then SIGKILL it if the same process is still alive after 10 s. */
export async function terminateWorker(pid: number, start: string): Promise<void> {
  if (await processMatches(pid, start) !== "alive") return;
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await processMatches(pid, start) !== "alive") return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (await processMatches(pid, start) !== "alive") return;
  try { process.kill(pid, "SIGKILL"); } catch { return; }
  const killDeadline = Date.now() + 5_000;
  while (Date.now() < killDeadline) {
    if (await processMatches(pid, start) !== "alive") return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

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

export function workerFilePath(id: string): string {
  return path.join(bridgeRoot(), "clones", `${dispatchId.parse(id)}.worker`);
}
export function launchLockFile(id: string): string {
  return path.join(bridgeRoot(), "clones", `${dispatchId.parse(id)}.launching`);
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

/**
 * The worker's liveness. While a live launch lock is held, no conclusion can be
 * drawn yet. With no file after the launch finished, the worker never started.
 */
export async function workerAlive(id: string, file = workerFilePath(id)): Promise<WorkerLiveness> {
  try { if (await launchInProgress(id)) return "unknown"; } catch { return "unknown"; }
  let text: string;
  try { text = await readFile(file, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    return "unknown";
  }
  const worker = parseWorker(text);
  if (!worker) return "unknown";
  return processMatches(worker.pid, worker.start);
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
  await new Promise(resolve => setTimeout(resolve, 300));
}

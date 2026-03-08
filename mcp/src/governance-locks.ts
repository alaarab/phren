import * as fs from "fs";
import * as path from "path";
import { debugLog } from "./shared.js";

// Acquire the file lock, returning true on success or throwing on timeout.
function acquireFileLock(lockPath: string): void {
  const maxWait = Number.parseInt(process.env.CORTEX_FILE_LOCK_MAX_WAIT_MS || "5000", 10) || 5000;
  const pollInterval = Number.parseInt(process.env.CORTEX_FILE_LOCK_POLL_MS || "100", 10) || 100;
  const staleThreshold = Number.parseInt(process.env.CORTEX_FILE_LOCK_STALE_MS || "30000", 10) || 30000;
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  const sleep = (ms: number) => Atomics.wait(waiter, 0, 0, ms);

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let waited = 0;
  let hasLock = false;
  while (waited < maxWait) {
    try {
      fs.writeFileSync(lockPath, `${process.pid}\n${Date.now()}`, { flag: "wx" });
      hasLock = true;
      break;
    } catch {
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleThreshold) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        sleep(pollInterval);
        waited += pollInterval;
        continue;
      }
      sleep(pollInterval);
      waited += pollInterval;
    }
  }

  if (!hasLock) {
    const msg = `withFileLock: could not acquire lock for "${path.basename(lockPath)}" within ${maxWait}ms`;
    debugLog(msg);
    throw new Error(msg);
  }
}

function releaseFileLock(lockPath: string): void {
  try { fs.unlinkSync(lockPath); } catch { /* lock may not exist */ }
}

// Q10: withFileLock now accepts both sync and async callbacks.
// When the callback returns a Promise, the lock file is held until the
// Promise settles — preventing concurrent processes from seeing partial state.
export function withFileLock<T>(filePath: string, fn: () => T): T extends Promise<infer U> ? Promise<U> : T {
  const lockPath = filePath + ".lock";
  acquireFileLock(lockPath);
  let result: T;
  try {
    result = fn();
  } catch (err) {
    releaseFileLock(lockPath);
    throw err;
  }

  // If the callback returned a Promise, hold the lock until it settles.
  if (result instanceof Promise) {
    return result.then(
      (value) => { releaseFileLock(lockPath); return value; },
      (err)   => { releaseFileLock(lockPath); throw err; },
    ) as T extends Promise<infer U> ? Promise<U> : T;
  }

  releaseFileLock(lockPath);
  return result as T extends Promise<infer U> ? Promise<U> : T;
}

export const withFileLockRaw = withFileLock;

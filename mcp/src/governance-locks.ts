import * as fs from "fs";
import * as path from "path";
import { debugLog } from "./shared.js";

export function withFileLock<T>(filePath: string, fn: () => T): T {
  const lockPath = filePath + ".lock";
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
    const msg = `withFileLock: could not acquire lock for "${path.basename(filePath)}" within ${maxWait}ms`;
    debugLog(msg);
    throw new Error(msg);
  }

  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // lock may not exist
    }
  }
}

export const withFileLockRaw = withFileLock;

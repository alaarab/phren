import * as fs from "fs";
import * as path from "path";
import { debugLog } from "../shared.js";
import { errorMessage } from "../utils.js";
import { logger } from "../logger.js";
// Acquire the file lock, returning true on success or throwing on timeout.
function acquireFileLock(lockPath) {
    const maxWait = Number.parseInt(process.env.PHREN_FILE_LOCK_MAX_WAIT_MS || "5000", 10) || 5000;
    const pollInterval = Number.parseInt((process.env.PHREN_FILE_LOCK_POLL_MS) || "100", 10) || 100;
    const staleThreshold = Number.parseInt((process.env.PHREN_FILE_LOCK_STALE_MS) || "30000", 10) || 30000;
    const waiter = new Int32Array(new SharedArrayBuffer(4));
    const sleep = (ms) => Atomics.wait(waiter, 0, 0, ms);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    let waited = 0;
    let hasLock = false;
    while (waited < maxWait) {
        try {
            fs.writeFileSync(lockPath, `${process.pid}\n${Date.now()}`, { flag: "wx" });
            hasLock = true;
            break;
        }
        catch (err) {
            logger.debug("acquireFileLock", `lockWrite: ${errorMessage(err)}`);
            try {
                const stat = fs.statSync(lockPath);
                if (Date.now() - stat.mtimeMs > staleThreshold) {
                    // Lock mtime exceeds stale threshold — but only delete if the
                    // owning process is dead.  Legitimate long operations (e.g. index
                    // rebuilds) can hold locks beyond the threshold.
                    let ownerAlive = false;
                    try {
                        const content = fs.readFileSync(lockPath, "utf-8");
                        const pid = Number.parseInt(content.split("\n")[0], 10);
                        if (pid > 0 && Number.isFinite(pid)) {
                            try {
                                process.kill(pid, 0); // signal 0: liveness check, no actual signal sent
                                ownerAlive = true;
                            }
                            catch {
                                // process.kill throws if PID doesn't exist → owner is dead
                            }
                        }
                        // pid <= 0 or NaN → treat as stale (unparseable / corrupt lock)
                    }
                    catch {
                        // Can't read lock file (deleted between stat and read) → retry
                    }
                    if (!ownerAlive) {
                        try {
                            fs.unlinkSync(lockPath);
                        }
                        catch { /* already gone */ }
                        continue;
                    }
                    // Owner is alive and legitimately holding a long lock: back off
                    // like every other retry path, or this loop spins at 100% CPU
                    // and `maxWait` never fires.
                    sleep(pollInterval);
                    waited += pollInterval;
                    continue;
                }
            }
            catch (statErr) {
                logger.debug("acquireFileLock", `staleStat: ${statErr instanceof Error ? statErr.message : String(statErr)}`);
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
function releaseFileLock(lockPath) {
    try {
        fs.unlinkSync(lockPath);
    }
    catch (err) {
        logger.debug("releaseFileLock", `${errorMessage(err)}`);
    }
}
/** A non-blocking lock for background work. Uses the same files as withFileLock. */
export function tryFileLock(filePath) {
    const lockPath = filePath + ".lock";
    const owner = `${process.pid}\n${Date.now()}\n${Math.random()}`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            fs.writeFileSync(lockPath, owner, { flag: "wx", mode: 0o600 });
            return () => {
                try {
                    if (fs.readFileSync(lockPath, "utf8") === owner)
                        fs.unlinkSync(lockPath);
                }
                catch { /* already released */ }
            };
        }
        catch (err) {
            if (err.code !== "EEXIST")
                throw err;
            try {
                const contents = fs.readFileSync(lockPath, "utf8");
                const pid = Number.parseInt(contents.split("\n")[0], 10);
                if (pid > 0) {
                    try {
                        process.kill(pid, 0);
                        return null;
                    }
                    catch (error) {
                        if (error.code !== "ESRCH")
                            return null;
                    }
                }
                else if (Date.now() - fs.statSync(lockPath).mtimeMs < 30_000) {
                    return null;
                }
                if (fs.readFileSync(lockPath, "utf8") === contents)
                    fs.unlinkSync(lockPath);
            }
            catch {
                return null;
            }
        }
    }
    return null;
}
// Q10: withFileLock now accepts both sync and async callbacks.
// When the callback returns a Promise, the lock file is held until the
// Promise settles — preventing concurrent processes from seeing partial state.
export function withFileLock(filePath, fn) {
    const lockPath = filePath + ".lock";
    acquireFileLock(lockPath);
    let result;
    try {
        result = fn();
    }
    catch (err) {
        releaseFileLock(lockPath);
        throw err;
    }
    // If the callback returned a Promise, hold the lock until it settles.
    if (result instanceof Promise) {
        return result.then((value) => { releaseFileLock(lockPath); return value; }, (err) => { releaseFileLock(lockPath); throw err; });
    }
    releaseFileLock(lockPath);
    return result;
}
export function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}
export function hasValidSchemaVersion(data) {
    return !("schemaVersion" in data) || typeof data.schemaVersion === "number";
}

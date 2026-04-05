/**
 * Background sync and maintenance scheduling.
 * Extracted from hooks-session.ts for modularity.
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  debugLog,
  errorMessage,
  runtimeFile,
  isFeatureEnabled,
} from "./hooks-context.js";
import { qualityMarkers } from "../shared.js";
import { spawnDetachedChild } from "../shared/process.js";
import { logger } from "../logger.js";

const SYNC_LOCK_STALE_MS = 10 * 60 * 1000; // 10 minutes
const MAINTENANCE_LOCK_STALE_MS = 2 * 60 * 60 * 1000; // 2 hours

export function resolveSubprocessArgs(command: string): string[] | null {
  // Prefer the entry script that started this process
  const entry = process.argv[1];
  if (entry && fs.existsSync(entry) && /index\.(ts|js)$/.test(entry)) return [entry, command];
  // Fallback: look for index.js next to this file or one level up (for subdirectory builds)
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  for (const dir of [thisDir, path.dirname(thisDir)]) {
    const candidate = path.join(dir, "index.js");
    if (fs.existsSync(candidate)) return [candidate, command];
  }
  return null;
}

export function scheduleBackgroundSync(phrenPathLocal: string): boolean {
  const lockPath = runtimeFile(phrenPathLocal, "background-sync.lock");
  const logPath = runtimeFile(phrenPathLocal, "background-sync.log");
  const spawnArgs = resolveSubprocessArgs("background-sync");
  if (!spawnArgs) return false;

  try {
    if (fs.existsSync(lockPath)) {
      const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (ageMs <= SYNC_LOCK_STALE_MS) return false;
      fs.unlinkSync(lockPath);
    }
  } catch (err: unknown) {
    debugLog(`scheduleBackgroundSync: lock check failed: ${errorMessage(err)}`);
    return false;
  }

  try {
    fs.writeFileSync(lockPath, JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid }) + "\n", { flag: "wx" });
    const logFd = fs.openSync(logPath, "a");
    fs.writeSync(logFd, `[${new Date().toISOString()}] spawn ${process.execPath} ${spawnArgs.join(" ")}\n`);
    const child = spawnDetachedChild(spawnArgs, { phrenPath: phrenPathLocal, logFd });
    child.unref();
    fs.closeSync(logFd);
    return true;
  } catch (err: unknown) {
    try { fs.unlinkSync(lockPath); } catch {}
    debugLog(`scheduleBackgroundSync: spawn failed: ${errorMessage(err)}`);
    return false;
  }
}

export function scheduleBackgroundMaintenance(phrenPathLocal: string, project?: string): boolean {
  if (!isFeatureEnabled("PHREN_FEATURE_DAILY_MAINTENANCE", true)) return false;
  const markers = qualityMarkers(phrenPathLocal);
  if (fs.existsSync(markers.done)) return false;
  if (fs.existsSync(markers.lock)) {
    try {
      const ageMs = Date.now() - fs.statSync(markers.lock).mtimeMs;
      if (ageMs <= MAINTENANCE_LOCK_STALE_MS) return false;
      fs.unlinkSync(markers.lock);
    } catch (err: unknown) {
      debugLog(`maybeRunBackgroundMaintenance: lock check failed: ${errorMessage(err)}`);
  return false;
}
  }

  const spawnArgs = resolveSubprocessArgs("background-maintenance");
  if (!spawnArgs) return false;

  try {
    // Use exclusive open (O_EXCL) to atomically claim the lock; if another process
    // already holds it this throws and we return false without spawning a duplicate.
    const lockContent = JSON.stringify({
      startedAt: new Date().toISOString(),
      project: project || "all",
      pid: process.pid,
    }) + "\n";
    let fd: number;
    try {
      fd = fs.openSync(markers.lock, "wx");
    } catch (err: unknown) {
      // Another process already claimed the lock
      logger.debug("hooks-session", `backgroundMaintenance lockClaim: ${errorMessage(err)}`);
      return false;
    }
    try {
      fs.writeSync(fd, lockContent);
    } finally {
      fs.closeSync(fd);
    }
    if (project) spawnArgs.push(project);
    const logDir = path.join(phrenPathLocal, ".config");
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, "background-maintenance.log");
    const logFd = fs.openSync(logPath, "a");
    fs.writeSync(
      logFd,
      `[${new Date().toISOString()}] spawn ${process.execPath} ${spawnArgs.join(" ")}\n`
    );
    const child = spawnDetachedChild(spawnArgs, { phrenPath: phrenPathLocal, logFd });
    child.on("exit", (code, signal) => {
      const msg = `[${new Date().toISOString()}] exit code=${code ?? "null"} signal=${signal ?? "none"}\n`;
      try { fs.appendFileSync(logPath, msg); } catch (err: unknown) {
        logger.debug("hooks-session", `backgroundMaintenance exitLog: ${errorMessage(err)}`);
      }
      if (code === 0) {
        try { fs.writeFileSync(markers.done, new Date().toISOString() + "\n"); } catch (err: unknown) {
          logger.debug("hooks-session", `backgroundMaintenance doneMarker: ${errorMessage(err)}`);
        }
      }
      try { fs.unlinkSync(markers.lock); } catch (err: unknown) {
        logger.debug("hooks-session", `backgroundMaintenance unlockOnExit: ${errorMessage(err)}`);
      }
    });
    child.on("error", (spawnErr) => {
      const msg = `[${new Date().toISOString()}] spawn error: ${spawnErr.message}\n`;
      try { fs.appendFileSync(logPath, msg); } catch (err: unknown) {
        logger.debug("hooks-session", `backgroundMaintenance errorLog: ${errorMessage(err)}`);
      }
      try { fs.unlinkSync(markers.lock); } catch (err: unknown) {
        logger.debug("hooks-session", `backgroundMaintenance unlockOnError: ${errorMessage(err)}`);
      }
    });
    fs.closeSync(logFd);
    child.unref();
    return true;
  } catch (err: unknown) {
    const errMsg = errorMessage(err);
    try {
      const logDir = path.join(phrenPathLocal, ".config");
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(
        path.join(logDir, "background-maintenance.log"),
        `[${new Date().toISOString()}] spawn failed: ${errMsg}\n`
      );
    } catch (err: unknown) {
      logger.debug("hooks-session", `backgroundMaintenance logSpawnFailure: ${errorMessage(err)}`);
    }
    try { fs.unlinkSync(markers.lock); } catch (err: unknown) {
      logger.debug("hooks-session", `backgroundMaintenance unlockOnFailure: ${errorMessage(err)}`);
    }
    return false;
  }
}

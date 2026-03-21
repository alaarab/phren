import * as fs from "fs";
import { runtimeFile, findPhrenPath } from "./phren-paths.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function resolvedLogLevel(): LogLevel {
  const env = (process.env.PHREN_LOG_LEVEL || "").toLowerCase();
  if (env === "debug" || env === "info" || env === "warn" || env === "error") return env;
  return "warn"; // default: only warn+error go to phren.log
}

export function log(level: LogLevel, tool: string, message: string, extra?: object): void {
  try {
    const phrenPath = findPhrenPath();
    if (!phrenPath) return;

    const line = JSON.stringify({ ts: new Date().toISOString(), level, tool, message, ...extra });

    // error and warn: always write to phren.log
    // info: write to phren.log when PHREN_LOG_LEVEL is info or debug
    // debug: write to debug.log only when PHREN_DEBUG is set (preserves existing behavior)
    if (level === "debug") {
      if (process.env.PHREN_DEBUG) {
        const debugPath = runtimeFile(phrenPath, "debug.log");
        fs.appendFileSync(debugPath, line + "\n");
      }
    } else if (LEVEL_RANK[level] >= LEVEL_RANK[resolvedLogLevel()]) {
      const phrenLogPath = runtimeFile(phrenPath, "phren.log");
      fs.appendFileSync(phrenLogPath, line + "\n");
    }
  } catch {
    // Logging must never throw
  }
}

// Convenience exports
export function logError(tool: string, message: string, extra?: object): void {
  log("error", tool, message, extra);
}

export function logWarn(tool: string, message: string, extra?: object): void {
  log("warn", tool, message, extra);
}

export function logInfo(tool: string, message: string, extra?: object): void {
  log("info", tool, message, extra);
}

export function logDebug(tool: string, message: string, extra?: object): void {
  log("debug", tool, message, extra);
}

import * as fs from "fs";
import { runtimeFile, findPhrenPath } from "./shared.js";

type LogLevel = "debug" | "info" | "warn" | "error";

let _cachedPhrenPath: string | null | undefined;

const LOG_MAX_BYTES = 5_000_000; // rotate debug.log past ~5MB
const LOG_KEEP_LINES = 2000;     // keep the most recent lines on rotation

/** Truncate debug.log to its last LOG_KEEP_LINES if it has grown past the cap. */
function rotateIfLarge(logPath: string): void {
  try {
    if (fs.statSync(logPath).size <= LOG_MAX_BYTES) return;
    const lines = fs.readFileSync(logPath, "utf-8").split("\n");
    fs.writeFileSync(logPath, lines.slice(-LOG_KEEP_LINES).join("\n"));
  } catch {
    // statSync ENOENT (no file yet) or any IO error — nothing to rotate
  }
}

export function log(level: LogLevel, tool: string, message: string, extra?: object): void {
  try {
    // debug-level logging is opt-in (matches debugLog). It was the bulk of the
    // 30MB debug.log — mostly expected-ENOENT noise logged on the normal path.
    if (level === "debug" && !process.env.PHREN_DEBUG) return;
    if (_cachedPhrenPath === undefined) _cachedPhrenPath = findPhrenPath();
    if (!_cachedPhrenPath) return;
    const logPath = runtimeFile(_cachedPhrenPath, "debug.log");
    rotateIfLarge(logPath);
    const line = JSON.stringify({ ts: new Date().toISOString(), level, tool, message, ...extra });
    fs.appendFileSync(logPath, line + "\n");
  } catch {
    // Logging must never throw
  }
}

export const logger = {
  debug: (tool: string, message: string, extra?: object) => log("debug", tool, message, extra),
  info: (tool: string, message: string, extra?: object) => log("info", tool, message, extra),
  warn: (tool: string, message: string, extra?: object) => log("warn", tool, message, extra),
  error: (tool: string, message: string, extra?: object) => log("error", tool, message, extra),
};

import * as fs from "fs";
import { runtimeFile, findPhrenPath } from "./shared.js";

type LogLevel = "debug" | "info" | "warn" | "error";

let _cachedPhrenPath: string | null | undefined;

export function log(level: LogLevel, tool: string, message: string, extra?: object): void {
  try {
    if (_cachedPhrenPath === undefined) _cachedPhrenPath = findPhrenPath();
    if (!_cachedPhrenPath) return;
    const logPath = runtimeFile(_cachedPhrenPath, "debug.log");
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

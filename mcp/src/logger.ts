import * as fs from "fs";
import { runtimeFile, findPhrenPath } from "./shared.js";

type LogLevel = "debug" | "info" | "warn" | "error";

export function log(level: LogLevel, tool: string, message: string, extra?: object): void {
  try {
    const phrenPath = findPhrenPath();
    if (!phrenPath) return;
    const logPath = runtimeFile(phrenPath, "debug.log");
    const line = JSON.stringify({ ts: new Date().toISOString(), level, tool, message, ...extra });
    fs.appendFileSync(logPath, line + "\n");
  } catch {
    // Logging must never throw
  }
}

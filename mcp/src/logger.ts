import * as fs from "fs";
import { runtimeFile, findCortexPath } from "./shared.js";

type LogLevel = "debug" | "info" | "warn" | "error";

export function log(level: LogLevel, tool: string, message: string, extra?: object): void {
  try {
    const cortexPath = findCortexPath();
    if (!cortexPath) return;
    const logPath = runtimeFile(cortexPath, "debug.log");
    const line = JSON.stringify({ ts: new Date().toISOString(), level, tool, message, ...extra });
    fs.appendFileSync(logPath, line + "\n");
  } catch {
    // Logging must never throw
  }
}

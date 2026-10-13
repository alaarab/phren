import * as vscode from "vscode";

function describe(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// One channel for the whole extension, so every failure lands in one place the
// user can open with "Phren: Show Log". `{ log: true }` returns a
// LogOutputChannel with trace/debug/info/warn/error; the vitest stub and older
// VS Code builds only expose the plain OutputChannel surface, so fill the
// level helpers in when missing rather than let a log call throw.
function createPhrenLog(): vscode.LogOutputChannel {
  const channel = vscode.window.createOutputChannel("Phren", { log: true });
  const log = channel as Partial<vscode.LogOutputChannel>;
  const emit = (level: string, args: unknown[]): void => {
    channel.appendLine(`[${level}] ${args.map(describe).join(" ")}`);
  };
  if (typeof log.trace !== "function") log.trace = (...args) => emit("trace", args);
  if (typeof log.debug !== "function") log.debug = (...args) => emit("debug", args);
  if (typeof log.info !== "function") log.info = (...args) => emit("info", args);
  if (typeof log.warn !== "function") log.warn = (...args) => emit("warn", args);
  if (typeof log.error !== "function") log.error = (...args) => emit("error", args);
  return channel as vscode.LogOutputChannel;
}

export const phrenLog: vscode.LogOutputChannel = createPhrenLog();

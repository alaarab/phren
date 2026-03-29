import * as path from "path";
import * as fs from "fs";
import { spawn, spawnSync } from "child_process";
import * as vscode from "vscode";
import { toErrorMessage, asRecord } from "../extensionContext";

const PHREN_PACKAGE_NAME = "@phren/cli";

export interface CommandResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  env?: NodeJS.ProcessEnv;
}

export function cleanYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function getNpmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function summarizeCommandError(result: CommandResult): string {
  if (result.stderr.trim()) {
    return result.stderr.trim().split("\n").slice(-1)[0];
  }
  if (result.stdout.trim()) {
    return result.stdout.trim().split("\n").slice(-1)[0];
  }
  return result.status === null ? "failed to start command" : `exit code ${result.status}`;
}

export function safeParseJson(raw: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw);
    return asRecord(value);
  } catch {
    return undefined;
  }
}

export async function isGlobalPhrenInstalled(): Promise<boolean> {
  const result = await runCommand(getNpmCommand(), ["list", "-g", PHREN_PACKAGE_NAME, "--json"]);
  const parsed = safeParseJson(result.stdout);
  const dependencies = asRecord(parsed?.dependencies);
  const packageEntry = dependencies ? dependencies[PHREN_PACKAGE_NAME] : undefined;
  return Boolean(packageEntry);
}

export function hasPhrenStoreMarkers(storePath: string): boolean {
  return [
    path.join(storePath, "phren.root.yaml"),
    path.join(storePath, "machines.yaml"),
    path.join(storePath, ".config"),
    path.join(storePath, "global"),
  ].some((candidate) => fs.existsSync(candidate));
}

export function removePhrenStore(storePath: string): { removed: boolean; skipped: boolean; error?: string } {
  if (!fs.existsSync(storePath)) return { removed: false, skipped: true };
  if (!hasPhrenStoreMarkers(storePath)) return { removed: false, skipped: true };
  try {
    fs.rmSync(storePath, { recursive: true, force: true });
    return { removed: true, skipped: false };
  } catch (error) {
    return { removed: false, skipped: false, error: toErrorMessage(error) };
  }
}

export function uninstallGlobalPhrenPackage(): CommandResult {
  try {
    const result = spawnSync(getNpmCommand(), ["uninstall", "-g", PHREN_PACKAGE_NAME], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      stdout: "",
      stderr: toErrorMessage(error),
    };
  }
}

export async function runCommandWithProgress(
  title: string,
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: false },
    async () => runCommand(command, args, options),
  );
}

export async function runCommand(command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: false,
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error: Error) => {
      resolve({
        ok: false,
        status: null,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
      });
    });
    child.on("close", (status: number | null) => {
      resolve({
        ok: status === 0,
        status,
        stdout,
        stderr,
      });
    });
  });
}

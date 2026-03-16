/**
 * Shared constants and utilities for init modules.
 * Kept separate to avoid circular dependencies between init-config and init-setup.
 */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { homePath, EXEC_TIMEOUT_QUICK_MS, debugLog } from "./shared.js";
import { errorMessage } from "./utils.js";
import { ROOT as PACKAGE_ROOT, VERSION } from "./package-metadata.js";
export const ROOT = PACKAGE_ROOT;
export { VERSION };
export const STARTER_DIR = path.join(ROOT, "starter");
export const DEFAULT_PHREN_PATH = homePath(".phren");

export function resolveEntryScript(): string {
  return path.join(ROOT, "mcp", "dist", "index.js");
}

export function log(msg: string) {
  process.stdout.write(msg + "\n");
}

export function commandVersion(cmd: string, args: string[] = ["--version"]): string | null {
  const effectiveCmd = process.platform === "win32" && (cmd === "npm" || cmd === "npx") ? `${cmd}.cmd` : cmd;
  try {
    return execFileSync(effectiveCmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      shell: process.platform === "win32" && effectiveCmd.endsWith(".cmd"),
      timeout: EXEC_TIMEOUT_QUICK_MS,
    }).trim();
  } catch (err: unknown) {
    debugLog(`commandVersion ${effectiveCmd} failed: ${errorMessage(err)}`);
    return null;
  }
}

export function parseSemverTriple(raw: string): [number, number, number] | null {
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10), Number.parseInt(match[3], 10)];
}

export function versionAtLeast(raw: string | null, major: number, minor = 0): boolean {
  if (!raw) return false;
  const parsed = parseSemverTriple(raw);
  if (!parsed) return false;
  const [m, n] = parsed;
  if (m !== major) return m > major;
  return n >= minor;
}

export function nearestWritableTarget(filePath: string): boolean {
  let probe = fs.existsSync(filePath) ? filePath : path.dirname(filePath);
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return false;
    probe = parent;
  }
  try {
    fs.accessSync(probe, fs.constants.W_OK);
    return true;
  } catch (err: unknown) {
    debugLog(`nearestWritableTarget failed for ${filePath}: ${errorMessage(err)}`);
    return false;
  }
}

export async function confirmPrompt(message: string): Promise<boolean> {
  if (process.env.CI === "true" || !process.stdin.isTTY) return true;

  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
    });
  });
}

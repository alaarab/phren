/**
 * Shared constants and utilities for init modules.
 * Kept separate to avoid circular dependencies between init-config and init-setup.
 */
import * as path from "path";
import { homePath } from "./shared.js";
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

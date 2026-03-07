/**
 * Shared constants and utilities for init modules.
 * Kept separate to avoid circular dependencies between init-config and init-setup.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
export const VERSION = pkg.version as string;
export const STARTER_DIR = path.join(ROOT, "starter");
export const DEFAULT_CORTEX_PATH = path.join(os.homedir(), ".cortex");

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

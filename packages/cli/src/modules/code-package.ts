import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export const CODE_PACKAGE_HINT = "phren code needs @phren/code: run phren modules enable code";
type CodePackage = typeof import("@phren/code");
let loaded: CodePackage | undefined;

/** Resolve by package name, including a globally installed optional package. */
export async function loadCodePackage(): Promise<CodePackage | undefined> {
  if (loaded) return loaded;
  try { loaded = await import("@phren/code"); return loaded; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw error;
  }
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 10_000 }).trim();
    const resolve = createRequire(path.join(globalRoot, "__phren_resolve.cjs"));
    loaded = await import(pathToFileURL(resolve.resolve("@phren/code")).href) as CodePackage;
    return loaded;
  } catch { return undefined; }
}

export async function requireCodePackage(): Promise<CodePackage> {
  const code = await loadCodePackage();
  if (!code) throw new Error(CODE_PACKAGE_HINT);
  return code;
}

export async function installCodePackage(): Promise<CodePackage> {
  const existing = await loadCodePackage();
  if (existing) return existing;
  try { execFileSync("npm", ["install", "-g", "@phren/code"], { stdio: "inherit", timeout: 120_000 }); }
  catch { throw new Error(`${CODE_PACKAGE_HINT}\nInstallation failed. Run: npm install -g @phren/code`); }
  const installed = await loadCodePackage();
  if (!installed) throw new Error(`${CODE_PACKAGE_HINT}\nRun: npm install -g @phren/code`);
  return installed;
}

export function copyCodeSkill(store: string, code: CodePackage): void {
  const destination = path.join(store, "global", "skills", "code", "SKILL.md");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(code.codeSkill, destination);
}

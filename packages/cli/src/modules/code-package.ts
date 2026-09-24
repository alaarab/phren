import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CODE_PACKAGE_HINT = "phren code needs @phren/code: run phren modules enable code";
type CodePackage = typeof import("@phren/code");
let loaded: CodePackage | undefined;
let resolvedFrom: string | undefined;

/** Where the loaded copy came from: an explicit directory, a resolver step or
 * the bare specifier "@phren/code". Undefined until a load succeeds. */
export function loadedFrom(): string | undefined { return resolvedFrom; }

/**
 * The Hook bundle runs from `<bridge>/versions/<v>` with no node_modules, so a
 * bare import fails there and the npm global root is invisible when the
 * daemon's PATH has no npm (mise shims under systemd). Resolve a local copy
 * before the bare import: an explicit directory, the bridge install, then the
 * store's runtime packages.
 */
function bridgeRoot(): string { return process.env.PHREN_BRIDGE_HOME || path.join(homedir(), ".local/share/phren/bridge"); }

/** The npm shims and Homebrew bin a service manager's PATH usually omits. */
const EXTRA_PATH = [path.join(homedir(), ".local/share/mise/shims"), "/opt/homebrew/bin"];
function npmPath(): string {
  const entries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const entry of EXTRA_PATH) if (!entries.includes(entry) && fs.existsSync(entry)) entries.push(entry);
  return entries.join(path.delimiter);
}

/** The entry file an installed package declares, without executing anything. */
function packageEntry(directory: string): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")) as {
    exports?: unknown; module?: unknown; main?: unknown;
  };
  const exported: unknown = typeof manifest.exports === "object" && manifest.exports !== null && "." in manifest.exports
    ? (manifest.exports as Record<string, unknown>)["."] : manifest.exports;
  const nested: unknown = typeof exported === "object" && exported !== null ? (exported as Record<string, unknown>).default ?? (exported as Record<string, unknown>).import : exported;
  for (const candidate of [nested, manifest.module, manifest.main, "index.js", "index.mjs"]) {
    if (typeof candidate === "string") return path.join(directory, candidate);
  }
  throw new Error(`@phren/code has no entry point in ${directory}.`);
}

async function importDirectory(directory: string): Promise<CodePackage> {
  return await import(pathToFileURL(packageEntry(directory)).href) as CodePackage;
}

function globalPackageDirectory(): string | undefined {
  try {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 10_000, env: { ...process.env, PATH: npmPath() } }).trim();
    return root ? path.join(root, "@phren", "code") : undefined;
  } catch { return undefined; }
}

/** Resolution order for the optional package. First success wins and is remembered. */
export async function loadCodePackage(store?: string): Promise<CodePackage | undefined> {
  if (loaded) return loaded;
  const candidates: string[] = [];
  if (process.env.PHREN_CODE_PACKAGE) candidates.push(process.env.PHREN_CODE_PACKAGE);
  candidates.push(path.join(bridgeRoot(), "node_modules", "@phren", "code"));
  const root = store || process.env.PHREN_PATH;
  if (root) candidates.push(path.join(root, ".runtime", "packages", "node_modules", "@phren", "code"));
  for (const directory of candidates) {
    if (!fs.existsSync(path.join(directory, "package.json"))) continue;
    try {
      loaded = await importDirectory(directory);
      resolvedFrom = directory;
      return loaded;
    } catch { /* try the next candidate */ }
  }
  try { loaded = await import("@phren/code"); resolvedFrom = "@phren/code"; return loaded; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw error;
  }
  const global = globalPackageDirectory();
  if (global && fs.existsSync(path.join(global, "package.json"))) {
    try { loaded = await importDirectory(global); resolvedFrom = global; return loaded; }
    catch { /* not installed after all */ }
  }
  return undefined;
}

export async function requireCodePackage(store?: string): Promise<CodePackage> {
  const code = await loadCodePackage(store);
  if (!code) throw new Error(CODE_PACKAGE_HINT);
  return code;
}

/** This repository checked out as a workspace, if its packages/code is present. */
function workspaceCodeDirectory(): string | undefined {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    const candidate = path.join(directory, "packages", "code");
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

/**
 * Make @phren/code available to this store. A workspace checkout links its own
 * package; otherwise npm installs into the store's runtime packages, which the
 * Hook can resolve without a global npm.
 */
export async function installCodePackage(store: string): Promise<CodePackage> {
  const existing = await loadCodePackage(store);
  if (existing) return existing;
  const packages = path.join(store, ".runtime", "packages");
  const linked = path.join(packages, "node_modules", "@phren", "code");
  const workspace = workspaceCodeDirectory();
  if (workspace) {
    fs.mkdirSync(path.dirname(linked), { recursive: true });
    fs.rmSync(linked, { recursive: true, force: true });
    fs.symlinkSync(workspace, linked, "junction");
    const code = await loadCodePackage(store);
    if (!code) throw new Error(`${CODE_PACKAGE_HINT}\nLinked ${workspace}, but it could not be loaded. Run pnpm build.`);
    console.log(`@phren/code linked from ${workspace} into ${linked}.`);
    return code;
  }
  try { execFileSync("npm", ["install", "--prefix", packages, "@phren/code"], { stdio: "inherit", timeout: 120_000, env: { ...process.env, PATH: npmPath() } }); }
  catch { throw new Error(`${CODE_PACKAGE_HINT}\nInstallation failed. Run: npm install --prefix ${packages} @phren/code`); }
  const installed = await loadCodePackage(store);
  if (!installed) throw new Error(`${CODE_PACKAGE_HINT}\nRun: npm install --prefix ${packages} @phren/code`);
  console.log(`@phren/code installed into ${packages}.`);
  return installed;
}

export function copyCodeSkill(store: string, code: CodePackage): void {
  const destination = path.join(store, "global", "skills", "code", "SKILL.md");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(code.codeSkill, destination);
}
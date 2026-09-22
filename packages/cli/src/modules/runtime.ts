import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { resolveRuntimeProfile } from "../runtime-profile.js";
import { installPreferencesFile } from "../phren-paths.js";
import { migrateModules } from "./config.js";
import { BUILTIN_MODULES, resolveModules, disabledHint, readConfig } from "./registry.js";
import type { ModuleManifest } from "./manifest.js";

export interface ModuleSnapshot {
  store: string;
  profile: string;
  modules: readonly ModuleManifest[];
  generation: string;
  has(name: string): boolean;
}

/** The runtime profile for module gating; unscoped while a store is still being set up. */
function snapshotProfile(store: string): string {
  try { return resolveRuntimeProfile(store); } catch { return ""; }
}

export function moduleSnapshot(store: string, profile = snapshotProfile(store), legacyHook = false): ModuleSnapshot {
  const config = readConfig(store);
  const hasStore = !!config || fs.existsSync(path.join(store, "phren.root.yaml")) || fs.existsSync(installPreferencesFile(store));
  const modules = !hasStore && legacyHook
    ? BUILTIN_MODULES.filter(module => ["hook", "git", "schedules", "conductor"].includes(module.name))
    : resolveModules(config ?? (hasStore ? { version: 1, enabled: { tasks: true } } : undefined), profile);
  const names = new Set(modules.map(module => module.name));
  const generation = createHash("sha256").update(JSON.stringify([store, profile, modules.map(module => [module.name, module.version])])).digest("hex").slice(0, 16);
  return { store, profile, modules, generation, has: name => names.has(name) };
}

export function moduleEnabled(store: string, name: string, profile?: string): boolean {
  return moduleSnapshot(store, profile).has(name);
}

export function requireModule(store: string, name: string, profile?: string): void {
  if (!moduleEnabled(store, name, profile)) throw new Error(disabledHint(name));
}

export function migrateInstalledModules(store: string, legacyHook = false): void {
  const hookRoot = process.env.PHREN_BRIDGE_HOME || path.join(homedir(), ".local", "share", "phren", "bridge");
  const installedHook = legacyHook || fs.existsSync(path.join(hookRoot, "installed.json"));
  // A store without .config was never set up; migration must not create it and
  // make `phren add` believe the store is ready.
  if (!fs.existsSync(path.join(store, ".config"))) return;
  if (readConfig(store) || fs.existsSync(path.join(store, "phren.root.yaml")) || fs.existsSync(installPreferencesFile(store))) migrateModules(store, installedHook);
}

/** The version in <bridge>/installed.json, or undefined when no Hook is installed. */
export function installedHookVersion(): string | undefined {
  const hookRoot = process.env.PHREN_BRIDGE_HOME || path.join(homedir(), ".local", "share", "phren", "bridge");
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(hookRoot, "installed.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : undefined;
  } catch { return undefined; }
}

export function activateModules(store: string, profile = snapshotProfile(store), legacyHook = false): ModuleSnapshot {
  migrateInstalledModules(store, legacyHook);
  return moduleSnapshot(store, profile, legacyHook);
}

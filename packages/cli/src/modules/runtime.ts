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

export function moduleSnapshot(store: string, profile = resolveRuntimeProfile(store), legacyHook = false): ModuleSnapshot {
  const config = readConfig(store);
  const hasStore = !!config || fs.existsSync(path.join(store, "phren.root.yaml")) || fs.existsSync(installPreferencesFile(store));
  const modules = !hasStore && legacyHook
    ? BUILTIN_MODULES.filter(module => module.name !== "memory" && module.name !== "tasks")
    : resolveModules(config, profile);
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
  if (fs.existsSync(path.join(store, "phren.root.yaml")) || fs.existsSync(installPreferencesFile(store))) migrateModules(store, installedHook);
}

export function activateModules(store: string, profile = resolveRuntimeProfile(store), legacyHook = false): ModuleSnapshot {
  migrateInstalledModules(store, legacyHook);
  return moduleSnapshot(store, profile, legacyHook);
}

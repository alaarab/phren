import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";
import { withFileLock } from "../governance/locks.js";
import { atomicWriteText, installPreferencesFile, runtimeFile } from "../phren-paths.js";
import { inProgressGitOperation } from "../sync/git-state.js";
import { BUILTIN_MODULES, readConfig, resolveModules, validateConfig } from "./registry.js";
import type { ModulesConfig } from "./manifest.js";

export function setModuleEnabled(store: string, name: string, value: boolean, profile?: string): void {
  if (!BUILTIN_MODULES.some(module => module.name === name)) throw new Error(`Unknown module "${name}".`);
  const file = path.join(store, ".config", "modules.yaml");
  withFileLock(file, () => {
    const config: ModulesConfig = readConfig(store) ?? { version: 1, enabled: { tasks: false } };
    if (profile !== undefined) {
      if (!profile.trim() || ["__proto__", "constructor", "prototype"].includes(profile)) throw new Error("Invalid module profile.");
      config.profiles ??= {};
      config.profiles[profile] ??= {};
      config.profiles[profile].enabled = { ...config.profiles[profile].enabled, [name]: value };
    } else config.enabled = { ...config.enabled, [name]: value };
    validateConfig(config);
    for (const scope of [undefined, ...Object.keys(config.profiles ?? {})]) resolveModules(config, scope);
    atomicWriteText(file, yaml.dump(config, { noRefs: true, lineWidth: -1 }));
  });
}

/** Freeze legacy surfaces before runtime defaults can change an existing install. */
export function migrateModules(store: string, hookInstalled = false): void {
  if (inProgressGitOperation(store)) return;
  const file = path.join(store, ".config", "modules.yaml");
  const existing = readConfig(store);
  if (existing?.enabled?.tasks !== undefined) return;
  const legacy = fs.existsSync(path.join(store, "phren.root.yaml")) || fs.existsSync(installPreferencesFile(store));
  if (!existing && !legacy && !hookInstalled) return;
  withFileLock(file, () => {
    const current = readConfig(store);
    if (current?.enabled?.tasks !== undefined) return;
    if (current) {
      // Before memory-only defaults, an omitted tasks override meant enabled.
      current.enabled = { tasks: true, ...current.enabled };
      const text = yaml.dump(current, { noRefs: true });
      atomicWriteText(runtimeFile(store, "modules.yaml.migration-backup"), fs.readFileSync(file, "utf8"));
      atomicWriteText(file, text);
      return;
    }
    const conductor = fs.existsSync(path.join(store, "global", "skills", "conductor"));
    const schedules = fs.existsSync(store) && fs.readdirSync(store, { withFileTypes: true })
      .some(entry => entry.isDirectory() && fs.existsSync(path.join(store, entry.name, "schedules.yaml")));
    const config: ModulesConfig = { version: 1, enabled: Object.fromEntries(BUILTIN_MODULES.map(module => [module.name,
      ["memory", "tasks", "git"].includes(module.name) || (hookInstalled && ["hook", "schedules", "conductor"].includes(module.name))
      || (conductor && ["hook", "conductor"].includes(module.name)) || (schedules && module.name === "schedules"),
    ])) };
    const text = yaml.dump(config, { noRefs: true });
    atomicWriteText(runtimeFile(store, "modules.yaml.migration-backup"), text);
    atomicWriteText(file, text);
  });
}

export function initializeModules(store: string): void {
  const file = path.join(store, ".config", "modules.yaml");
  withFileLock(file, () => {
    if (!readConfig(store)) atomicWriteText(file, yaml.dump({ version: 1, enabled: Object.fromEntries(BUILTIN_MODULES.map(module => [module.name, module.defaultEnabled])) }, { noRefs: true }));
  });
}

/**
 * `phren pair` and `phren bridge install` are how a person asks for the Hook,
 * so they turn its module on instead of refusing. Returns true when this
 * call enabled it. Without a store there is nothing to record; the Hook's
 * legacy default already allows it there.
 */
export function enableHookForPhone(store: string): boolean {
  const hasStore = !!readConfig(store) || fs.existsSync(path.join(store, "phren.root.yaml")) || fs.existsSync(installPreferencesFile(store));
  if (!hasStore) return false;
  const config = readConfig(store);
  if (config?.enabled?.hook === true) return false;
  migrateModules(store);
  setModuleEnabled(store, "hook", true);
  return true;
}

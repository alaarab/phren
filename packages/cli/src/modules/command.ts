import { installCodePackage, copyCodeSkill } from "./code-package.js";
import { resolveRuntimeProfile } from "../runtime-profile.js";
import { resolveAllStores } from "../store-registry.js";
import { isVersionNewer } from "../init/init.js";
import { installedHookVersion, migrateInstalledModules, moduleSnapshot } from "./runtime.js";
import { BUILTIN_MODULES, moduleSource, readConfig } from "./registry.js";
import { setModuleEnabled } from "./config.js";
import type { CliContext } from "../cli-registry.js";

export async function runModules(args: string[], ctx: CliContext): Promise<number | void> {
  const [action, ...rest] = args;
  let name: string | undefined;
  let profile: string | undefined;
  let storeName: string | undefined;
  if (action === "enable" || action === "disable") name = rest.shift();
  while (["--profile", "--store"].includes(rest[0]) && rest[1] && !rest[1].startsWith("-")) {
    const option = rest.shift(), value = rest.shift()!;
    if (option === "--profile" && profile === undefined) profile = value;
    else if (option === "--store" && storeName === undefined) storeName = value;
    else { rest.push("invalid"); break; }
  }
  if (!["list", "enable", "disable"].includes(action) || rest.length || (action !== "list" && (!name || name.startsWith("-")))) {
    console.error("Usage: phren modules list|enable|disable [name] [--profile <name>] [--store <name>]");
    return 1;
  }
  if (name && !BUILTIN_MODULES.some(module => module.name === name)) throw new Error(`Unknown module "${name}".`);
  if (name === "memory" && action === "disable") throw new Error("The memory module cannot be disabled.");
  let store = ctx.phrenPath();
  if (storeName) {
    const selected = resolveAllStores(store).find(entry => entry.name === storeName);
    if (!selected || selected.available === false) throw new Error(`Store "${storeName}" is unavailable.`);
    if (action !== "list" && selected.role === "readonly") throw new Error(`Store "${storeName}" is read-only.`);
    store = selected.path;
  }
  const selectedProfile = profile ?? (action === "list" ? (storeName ? resolveRuntimeProfile(store) : ctx.profile()) : "");
  if (action !== "list") {
    migrateInstalledModules(store);
    const code = name === "code" && action === "enable" ? await installCodePackage() : undefined;
    setModuleEnabled(store, name!, action === "enable", profile);
    if (code) copyCodeSkill(store, code);
    console.log(`${name} ${action === "enable" ? "enabled" : "disabled"}${profile ? ` for profile ${profile}` : " for the store"}. Run phren init to reconcile integrations; restart MCP and Hook to refresh their surfaces.`);
    if (action === "enable") {
      const manifest = BUILTIN_MODULES.find(module => module.name === name);
      const installed = installedHookVersion();
      if (manifest && installed && isVersionNewer(manifest.version, installed)) {
        console.error(`warning: installed Phren Hook ${installed} is older than module ${name} ${manifest.version}; run phren bridge update so the Hook knows this module.`);
      }
    }
    return;
  }
  const snapshot = moduleSnapshot(store, selectedProfile);
  const config = readConfig(store);
  console.log(`Modules for profile ${selectedProfile || "(store)"}`);
  console.log("Module\tVersion\tEffective\tSource\tRequires");
  for (const module of BUILTIN_MODULES) {
    console.log(`${module.name}\t${module.version}\t${snapshot.has(module.name) ? "enabled" : "disabled"}\t${moduleSource(config, module.name, selectedProfile)}\t${module.requires.join(",") || "-"}`);
  }
}

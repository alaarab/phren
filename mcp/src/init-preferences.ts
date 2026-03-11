/**
 * Install preferences: MCP/hooks mode, version tracking.
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { debugLog, installPreferencesFile } from "./cortex-paths.js";
import { errorMessage } from "./utils.js";
import type { CustomHookEntry } from "./hooks.js";

export interface InstallPreferences {
  mcpEnabled?: boolean;
  hooksEnabled?: boolean;
  projectOwnershipDefault?: "cortex-managed" | "detached" | "repo-managed";
  proactivity?: "high" | "medium" | "low";
  proactivityFindings?: "high" | "medium" | "low";
  proactivityTask?: "high" | "medium" | "low";
  hookTools?: Record<string, boolean>;
  disabledSkills?: Record<string, boolean>;
  installedVersion?: string;
  updatedAt?: string;
  customHooks?: CustomHookEntry[];
}

function preferencesFile(cortexPath: string): string {
  return installPreferencesFile(cortexPath);
}

export function governanceInstallPreferencesFile(cortexPath: string): string {
  return path.join(cortexPath, ".governance", "install-preferences.json");
}

function readPreferencesFile(file: string): InstallPreferences {
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as InstallPreferences;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err: unknown) {
    debugLog(`readInstallPreferences: failed to parse ${file}: ${errorMessage(err)}`);
    return {};
  }
}

function writePreferencesFile(file: string, current: InstallPreferences, patch: Partial<InstallPreferences>) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmpPath = `${file}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(
    tmpPath,
    JSON.stringify(
      {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    ) + "\n"
  );
  fs.renameSync(tmpPath, file);
}

export function readInstallPreferences(cortexPath: string): InstallPreferences {
  return readPreferencesFile(preferencesFile(cortexPath));
}

export function readGovernanceInstallPreferences(cortexPath: string): InstallPreferences {
  return readPreferencesFile(governanceInstallPreferencesFile(cortexPath));
}

export function writeInstallPreferences(cortexPath: string, patch: Partial<InstallPreferences>) {
  writePreferencesFile(preferencesFile(cortexPath), readInstallPreferences(cortexPath), patch);
}

export function writeGovernanceInstallPreferences(cortexPath: string, patch: Partial<InstallPreferences>) {
  writePreferencesFile(governanceInstallPreferencesFile(cortexPath), readGovernanceInstallPreferences(cortexPath), patch);
}

export function getMcpEnabledPreference(cortexPath: string): boolean {
  const prefs = readInstallPreferences(cortexPath);
  return prefs.mcpEnabled !== false;
}

export function setMcpEnabledPreference(cortexPath: string, enabled: boolean): void {
  writeInstallPreferences(cortexPath, { mcpEnabled: enabled });
}

export function getHooksEnabledPreference(cortexPath: string): boolean {
  const prefs = readInstallPreferences(cortexPath);
  return prefs.hooksEnabled !== false;
}

export function setHooksEnabledPreference(cortexPath: string, enabled: boolean): void {
  writeInstallPreferences(cortexPath, { hooksEnabled: enabled });
}

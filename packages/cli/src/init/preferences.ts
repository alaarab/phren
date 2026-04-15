/**
 * Install preferences: MCP/hooks mode, version tracking.
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { debugLog, installPreferencesFile } from "../phren-paths.js";
import { errorMessage } from "../utils.js";
import { withFileLock } from "../shared/governance.js";
import type { CustomHookEntry } from "../hooks.js";

export interface InstallPreferences {
  mcpEnabled?: boolean;
  hooksEnabled?: boolean;
  skillsScope?: "global" | "project";
  projectOwnershipDefault?: "phren-managed" | "detached" | "repo-managed";
  proactivity?: "high" | "medium" | "low";
  proactivityFindings?: "high" | "medium" | "low";
  proactivityTask?: "high" | "medium" | "low";
  hookTools?: Record<string, boolean>;
  disabledSkills?: Record<string, boolean>;
  installedVersion?: string;
  updatedAt?: string;
  customHooks?: CustomHookEntry[];
  /**
   * Pre-prompt custom hook commands that have been mirrored into Claude
   * Code's settings.json as sibling UserPromptSubmit entries. Used to detect
   * stale siblings on resync so we can remove commands that were deleted
   * from `customHooks`. Internal bookkeeping — managed by
   * `syncPrePromptSiblingsToClaudeSettings`. Do not edit by hand.
   */
  managedPrePromptSiblingCommands?: string[];
  /** Whether the user intended cross-machine sync ("sync") or local-only ("local"). */
  syncIntent?: "sync" | "local";
}

function preferencesFile(phrenPath: string): string {
  return installPreferencesFile(phrenPath);
}

export function governanceInstallPreferencesFile(phrenPath: string): string {
  return path.join(phrenPath, ".config", "install-preferences.json");
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

function writePreferencesFileRaw(file: string, current: InstallPreferences, patch: Partial<InstallPreferences>) {
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

function writePreferencesFile(file: string, patch: Partial<InstallPreferences>) {
  withFileLock(file, () => {
    const current = readPreferencesFile(file);
    writePreferencesFileRaw(file, current, patch);
  });
}

export function readInstallPreferences(phrenPath: string): InstallPreferences {
  return readPreferencesFile(preferencesFile(phrenPath));
}

export function readGovernanceInstallPreferences(phrenPath: string): InstallPreferences {
  return readPreferencesFile(governanceInstallPreferencesFile(phrenPath));
}

export function writeInstallPreferences(phrenPath: string, patch: Partial<InstallPreferences>) {
  writePreferencesFile(preferencesFile(phrenPath), patch);
}

export function writeGovernanceInstallPreferences(phrenPath: string, patch: Partial<InstallPreferences>) {
  writePreferencesFile(governanceInstallPreferencesFile(phrenPath), patch);
}

/** Atomically read-modify-write install preferences using a patcher function. */
export function updateInstallPreferences(phrenPath: string, patcher: (current: InstallPreferences) => Partial<InstallPreferences>): void {
  const file = preferencesFile(phrenPath);
  withFileLock(file, () => {
    const current = readPreferencesFile(file);
    writePreferencesFileRaw(file, current, patcher(current));
  });
}

export function getMcpEnabledPreference(phrenPath: string): boolean {
  const prefs = readInstallPreferences(phrenPath);
  return prefs.mcpEnabled !== false;
}

export function setMcpEnabledPreference(phrenPath: string, enabled: boolean): void {
  writeInstallPreferences(phrenPath, { mcpEnabled: enabled });
}

export function getHooksEnabledPreference(phrenPath: string): boolean {
  const prefs = readInstallPreferences(phrenPath);
  return prefs.hooksEnabled !== false;
}

export function setHooksEnabledPreference(phrenPath: string, enabled: boolean): void {
  writeInstallPreferences(phrenPath, { hooksEnabled: enabled });
}

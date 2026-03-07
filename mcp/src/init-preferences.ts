/**
 * Install preferences: MCP/hooks mode, version tracking.
 */
import * as fs from "fs";
import * as path from "path";
import { debugLog } from "./shared.js";
import { errorMessage } from "./utils.js";

export interface InstallPreferences {
  mcpEnabled?: boolean;
  hooksEnabled?: boolean;
  hookTools?: Record<string, boolean>;
  installedVersion?: string;
  updatedAt?: string;
}

function preferencesFile(cortexPath: string): string {
  return path.join(cortexPath, ".governance", "install-preferences.json");
}

export function readInstallPreferences(cortexPath: string): InstallPreferences {
  const file = preferencesFile(cortexPath);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as InstallPreferences;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err: unknown) {
    debugLog(`readInstallPreferences: failed to parse ${file}: ${errorMessage(err)}`);
    return {};
  }
}

export function writeInstallPreferences(cortexPath: string, patch: Partial<InstallPreferences>) {
  const file = preferencesFile(cortexPath);
  const current = readInstallPreferences(cortexPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
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

/**
 * Install preferences: MCP/hooks mode, version tracking.
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { debugLog, installPreferencesFile } from "./phren-paths.js";
import { errorMessage } from "./utils.js";
function preferencesFile(phrenPath) {
    return installPreferencesFile(phrenPath);
}
export function governanceInstallPreferencesFile(phrenPath) {
    return path.join(phrenPath, ".governance", "install-preferences.json");
}
function readPreferencesFile(file) {
    if (!fs.existsSync(file))
        return {};
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        return parsed && typeof parsed === "object" ? parsed : {};
    }
    catch (err) {
        debugLog(`readInstallPreferences: failed to parse ${file}: ${errorMessage(err)}`);
        return {};
    }
}
function writePreferencesFile(file, current, patch) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmpPath = `${file}.tmp-${crypto.randomUUID()}`;
    fs.writeFileSync(tmpPath, JSON.stringify({
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
    }, null, 2) + "\n");
    fs.renameSync(tmpPath, file);
}
export function readInstallPreferences(phrenPath) {
    return readPreferencesFile(preferencesFile(phrenPath));
}
export function readGovernanceInstallPreferences(phrenPath) {
    return readPreferencesFile(governanceInstallPreferencesFile(phrenPath));
}
export function writeInstallPreferences(phrenPath, patch) {
    writePreferencesFile(preferencesFile(phrenPath), readInstallPreferences(phrenPath), patch);
}
export function writeGovernanceInstallPreferences(phrenPath, patch) {
    writePreferencesFile(governanceInstallPreferencesFile(phrenPath), readGovernanceInstallPreferences(phrenPath), patch);
}
export function getMcpEnabledPreference(phrenPath) {
    const prefs = readInstallPreferences(phrenPath);
    return prefs.mcpEnabled !== false;
}
export function setMcpEnabledPreference(phrenPath, enabled) {
    writeInstallPreferences(phrenPath, { mcpEnabled: enabled });
}
export function getHooksEnabledPreference(phrenPath) {
    const prefs = readInstallPreferences(phrenPath);
    return prefs.hooksEnabled !== false;
}
export function setHooksEnabledPreference(phrenPath, enabled) {
    writeInstallPreferences(phrenPath, { hooksEnabled: enabled });
}

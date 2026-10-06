import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { loadYamlDocument } from "./phren-core.js";
import { readInstallPreferences } from "./init/preferences.js";
import { debugLog } from "./shared.js";
import { errorMessage } from "./utils.js";
import { storeAwareProjectPath } from "./store-routing.js";
import { withFileLock } from "./governance/locks.js";
import { getMachineName } from "./machine-identity.js";
export const PROJECT_OWNERSHIP_MODES = ["phren-managed", "detached", "repo-managed"];
export const PROJECT_HOOK_EVENTS = ["UserPromptSubmit", "Stop", "SessionStart", "PostToolUse"];
export function parseProjectOwnershipMode(raw) {
    if (!raw)
        return undefined;
    const normalized = raw.trim().toLowerCase();
    if (normalized === "phren" || normalized === "managed")
        return "phren-managed";
    if (normalized === "repo" || normalized === "external")
        return "repo-managed";
    if (PROJECT_OWNERSHIP_MODES.includes(normalized)) {
        return normalized;
    }
    return undefined;
}
export function projectConfigPath(phrenPath, project) {
    return path.join(phrenPath, project, "phren.project.yaml");
}
function resolveProjectConfigPath(phrenPath, project) {
    return storeAwareProjectPath(phrenPath, project, "phren.project.yaml");
}
function writeProjectConfigFile(configPath, next) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const tmpPath = `${configPath}.tmp-${crypto.randomUUID()}`;
    fs.writeFileSync(tmpPath, yaml.dump(next, { lineWidth: 1000 }));
    fs.renameSync(tmpPath, configPath);
    _projectConfigCache.delete(configPath);
}
function normalizeProjectOverrides(raw) {
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}
// ── mtime-based config cache ─────────────────────────────────────────────────
const _projectConfigCache = new Map();
export function clearProjectConfigCache() {
    _projectConfigCache.clear();
}
export function readProjectConfig(phrenPath, project) {
    const configPath = resolveProjectConfigPath(phrenPath, project);
    if (!configPath) {
        debugLog(`readProjectConfig: rejected path for project "${project}"`);
        return {};
    }
    let mtimeMs;
    try {
        mtimeMs = fs.statSync(configPath).mtimeMs;
    }
    catch {
        // File doesn't exist or can't be stat'd
        _projectConfigCache.delete(configPath);
        return {};
    }
    const cached = _projectConfigCache.get(configPath);
    if (cached && cached.mtimeMs === mtimeMs) {
        return cached.config;
    }
    try {
        const parsed = loadYamlDocument(fs.readFileSync(configPath, "utf8"), (text) => yaml.load(text, { schema: yaml.CORE_SCHEMA }));
        const config = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
        _projectConfigCache.set(configPath, { mtimeMs, config });
        return config;
    }
    catch (err) {
        debugLog(`readProjectConfig: failed to parse ${configPath}: ${errorMessage(err)}`);
        _projectConfigCache.delete(configPath);
        return {};
    }
}
export function writeProjectConfig(phrenPath, project, patch) {
    const configPath = resolveProjectConfigPath(phrenPath, project);
    if (!configPath) {
        throw new Error(`Project config path escapes phren store`);
    }
    return withFileLock(configPath, () => {
        const current = readProjectConfig(phrenPath, project);
        const next = {
            ...current,
            ...patch,
        };
        writeProjectConfigFile(configPath, next);
        return next;
    });
}
export function updateProjectConfigOverrides(phrenPath, project, updater) {
    const configPath = resolveProjectConfigPath(phrenPath, project);
    if (!configPath) {
        throw new Error(`Project config path escapes phren store`);
    }
    return withFileLock(configPath, () => {
        const current = readProjectConfig(phrenPath, project);
        const currentConfig = normalizeProjectOverrides(current.config);
        const nextOverrides = normalizeProjectOverrides(updater(currentConfig));
        const next = {
            ...current,
            config: nextOverrides,
        };
        writeProjectConfigFile(configPath, next);
        return next;
    });
}
/**
 * Where this project's source lives on this machine. The store syncs between
 * computers, so the shared `sourcePath` is often another machine's folder:
 * this machine's `sourcePaths` entry wins, and the shared value is only used
 * when nothing more specific was recorded.
 */
export function getProjectSourcePath(phrenPath, project, config, machine = getMachineName()) {
    const resolved = config ?? readProjectConfig(phrenPath, project);
    const perMachine = resolved.sourcePaths && typeof resolved.sourcePaths === "object" && !Array.isArray(resolved.sourcePaths)
        ? resolved.sourcePaths[machine]
        : undefined;
    const raw = typeof perMachine === "string" && perMachine.trim() ? perMachine : resolved.sourcePath;
    return typeof raw === "string" && raw.trim() ? path.resolve(raw) : undefined;
}
/**
 * Record `sourceRoot` as this machine's folder for the project, alongside the
 * legacy shared `sourcePath` older CLIs read.
 */
export function recordProjectSourcePath(phrenPath, project, sourceRoot, patch = {}, machine = getMachineName()) {
    const current = readProjectConfig(phrenPath, project);
    const existing = current.sourcePaths && typeof current.sourcePaths === "object" && !Array.isArray(current.sourcePaths)
        ? current.sourcePaths
        : {};
    return writeProjectConfig(phrenPath, project, {
        ...patch,
        sourcePath: sourceRoot,
        sourcePaths: { ...existing, [machine]: sourceRoot },
    });
}
export function getProjectOwnershipDefault(phrenPath) {
    return parseProjectOwnershipMode(readInstallPreferences(phrenPath).projectOwnershipDefault) ?? "phren-managed";
}
export function getProjectOwnershipMode(phrenPath, project, config) {
    return parseProjectOwnershipMode((config ?? readProjectConfig(phrenPath, project)).ownership) ?? "phren-managed";
}
function normalizeHookConfig(config) {
    const hooks = config?.hooks;
    return hooks && typeof hooks === "object" ? hooks : {};
}
export function isProjectHookEnabled(phrenPath, project, event, config) {
    if (!project)
        return true;
    const hooks = normalizeHookConfig(config ?? readProjectConfig(phrenPath, project));
    const eventValue = hooks[event];
    if (typeof eventValue === "boolean")
        return eventValue;
    if (typeof hooks.enabled === "boolean")
        return hooks.enabled;
    return true;
}
/**
 * Remove a per-project hook override, restoring inheritance from global config.
 * Pass event to clear a specific event override; omit to clear the whole hooks block.
 */
export function clearProjectHookOverride(phrenPath, project, event) {
    const configPath = resolveProjectConfigPath(phrenPath, project);
    if (!configPath)
        throw new Error("Project config path escapes phren store");
    return withFileLock(configPath, () => {
        const current = readProjectConfig(phrenPath, project);
        const existingHooks = normalizeHookConfig(current);
        let nextHooks;
        if (event && PROJECT_HOOK_EVENTS.includes(event)) {
            // Delete just this event key
            const { [event]: _removed, ...rest } = existingHooks;
            nextHooks = rest;
        }
        else {
            // Clear all overrides
            nextHooks = {};
        }
        const next = { ...current, hooks: nextHooks };
        writeProjectConfigFile(configPath, next);
        return next;
    });
}
export function writeProjectHookConfig(phrenPath, project, patch) {
    // Move read+merge inside the lock so concurrent writers cannot clobber each other.
    const configPath = resolveProjectConfigPath(phrenPath, project);
    if (!configPath) {
        throw new Error(`Project config path escapes phren store`);
    }
    return withFileLock(configPath, () => {
        const current = readProjectConfig(phrenPath, project);
        const next = {
            ...current,
            hooks: {
                ...normalizeHookConfig(current),
                ...patch,
            },
        };
        writeProjectConfigFile(configPath, next);
        return next;
    });
}

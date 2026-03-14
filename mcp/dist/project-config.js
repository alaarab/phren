import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { readInstallPreferences } from "./init-preferences.js";
import { debugLog } from "./shared.js";
import { errorMessage } from "./utils.js";
export const PROJECT_OWNERSHIP_MODES = ["phren-managed", "detached", "repo-managed"];
export const PROJECT_HOOK_EVENTS = ["UserPromptSubmit", "Stop", "SessionStart", "PostToolUse"];
export function parseProjectOwnershipMode(raw) {
    if (!raw)
        return undefined;
    const normalized = raw.trim().toLowerCase();
    if (normalized === "phren" || normalized === "managed" || normalized === "phren")
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
export function readProjectConfig(phrenPath, project) {
    const configPath = projectConfigPath(phrenPath, project);
    if (!fs.existsSync(configPath))
        return {};
    try {
        const parsed = yaml.load(fs.readFileSync(configPath, "utf8"), { schema: yaml.CORE_SCHEMA });
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    }
    catch (err) {
        debugLog(`readProjectConfig: failed to parse ${configPath}: ${errorMessage(err)}`);
        return {};
    }
}
export function writeProjectConfig(phrenPath, project, patch) {
    const configPath = projectConfigPath(phrenPath, project);
    const current = readProjectConfig(phrenPath, project);
    const next = {
        ...current,
        ...patch,
    };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const tmpPath = `${configPath}.tmp-${crypto.randomUUID()}`;
    fs.writeFileSync(tmpPath, yaml.dump(next, { lineWidth: 1000 }));
    fs.renameSync(tmpPath, configPath);
    return next;
}
export function getProjectSourcePath(phrenPath, project, config) {
    const raw = (config ?? readProjectConfig(phrenPath, project)).sourcePath;
    return typeof raw === "string" && raw.trim() ? path.resolve(raw) : undefined;
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
export function writeProjectHookConfig(phrenPath, project, patch) {
    const current = readProjectConfig(phrenPath, project);
    return writeProjectConfig(phrenPath, project, {
        hooks: {
            ...normalizeHookConfig(current),
            ...patch,
        },
    });
}

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { readInstallPreferences } from "./init/preferences.js";
import { debugLog } from "./shared.js";
import { errorMessage, safeProjectPath } from "./utils.js";
import { withFileLock } from "./shared/governance.js";
import type { RetentionPolicyPatch } from "./governance/policy.js";

export const PROJECT_OWNERSHIP_MODES = ["phren-managed", "detached", "repo-managed"] as const;
export type ProjectOwnershipMode = typeof PROJECT_OWNERSHIP_MODES[number];

export interface ProjectMcpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ProjectConfigOverrides {
  findingSensitivity?: "minimal" | "conservative" | "balanced" | "aggressive";
  proactivity?: "high" | "medium" | "low";
  proactivityFindings?: "high" | "medium" | "low";
  proactivityTask?: "high" | "medium" | "low";
  taskMode?: "off" | "manual" | "suggest" | "auto";
  retentionPolicy?: RetentionPolicyPatch;
  workflowPolicy?: {
    lowConfidenceThreshold?: number;
    riskySections?: Array<"Review" | "Stale" | "Conflicts">;
  };
}

export interface ProjectAccessControl {
  admins?: string[];
  contributors?: string[];
  readers?: string[];
}

export interface ProjectConfig {
  ownership?: ProjectOwnershipMode;
  sourcePath?: string;
  skills?: boolean;
  hooks?: {
    enabled?: boolean;
    UserPromptSubmit?: boolean;
    Stop?: boolean;
    SessionStart?: boolean;
    PostToolUse?: boolean;
  };
  mcpServers?: Record<string, ProjectMcpServerEntry>;
  config?: ProjectConfigOverrides;
  access?: ProjectAccessControl;
}

export const PROJECT_HOOK_EVENTS = ["UserPromptSubmit", "Stop", "SessionStart", "PostToolUse"] as const;
export type ProjectHookEvent = typeof PROJECT_HOOK_EVENTS[number];

type ProjectHookConfig = NonNullable<ProjectConfig["hooks"]>;

export function parseProjectOwnershipMode(raw: string | undefined | null): ProjectOwnershipMode | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "phren" || normalized === "managed") return "phren-managed";
  if (normalized === "repo" || normalized === "external") return "repo-managed";
  if (PROJECT_OWNERSHIP_MODES.includes(normalized as ProjectOwnershipMode)) {
    return normalized as ProjectOwnershipMode;
  }
  return undefined;
}

export function projectConfigPath(phrenPath: string, project: string): string {
  return path.join(phrenPath, project, "phren.project.yaml");
}

function resolveProjectConfigPath(phrenPath: string, project: string): string | null {
  return safeProjectPath(phrenPath, project, "phren.project.yaml");
}

function writeProjectConfigFile(configPath: string, next: ProjectConfig): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmpPath = `${configPath}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(tmpPath, yaml.dump(next, { lineWidth: 1000 }));
  fs.renameSync(tmpPath, configPath);
  _projectConfigCache.delete(configPath);
}

function normalizeProjectOverrides(raw: unknown): ProjectConfigOverrides {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as ProjectConfigOverrides : {};
}

// ── mtime-based config cache ─────────────────────────────────────────────────
const _projectConfigCache = new Map<string, { mtimeMs: number; config: ProjectConfig }>();

export function clearProjectConfigCache(): void {
  _projectConfigCache.clear();
}

export function readProjectConfig(phrenPath: string, project: string): ProjectConfig {
  const configPath = resolveProjectConfigPath(phrenPath, project);
  if (!configPath) {
    debugLog(`readProjectConfig: rejected path for project "${project}"`);
    return {};
  }
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(configPath).mtimeMs;
  } catch {
    // File doesn't exist or can't be stat'd
    _projectConfigCache.delete(configPath);
    return {};
  }
  const cached = _projectConfigCache.get(configPath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.config;
  }
  try {
    const parsed = yaml.load(fs.readFileSync(configPath, "utf8"), { schema: yaml.CORE_SCHEMA });
    const config = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as ProjectConfig : {};
    _projectConfigCache.set(configPath, { mtimeMs, config });
    return config;
  } catch (err: unknown) {
    debugLog(`readProjectConfig: failed to parse ${configPath}: ${errorMessage(err)}`);
    _projectConfigCache.delete(configPath);
    return {};
  }
}

export function writeProjectConfig(phrenPath: string, project: string, patch: Partial<ProjectConfig>): ProjectConfig {
  const configPath = resolveProjectConfigPath(phrenPath, project);
  if (!configPath) {
    throw new Error(`Project config path escapes phren store`);
  }
  return withFileLock(configPath, () => {
    const current = readProjectConfig(phrenPath, project);
    const next: ProjectConfig = {
      ...current,
      ...patch,
    };
    writeProjectConfigFile(configPath, next);
    return next;
  });
}

export function updateProjectConfigOverrides(
  phrenPath: string,
  project: string,
  updater: (current: ProjectConfigOverrides) => ProjectConfigOverrides,
): ProjectConfig {
  const configPath = resolveProjectConfigPath(phrenPath, project);
  if (!configPath) {
    throw new Error(`Project config path escapes phren store`);
  }
  return withFileLock(configPath, () => {
    const current = readProjectConfig(phrenPath, project);
    const currentConfig = normalizeProjectOverrides(current.config);
    const nextOverrides = normalizeProjectOverrides(updater(currentConfig));
    const next: ProjectConfig = {
      ...current,
      config: nextOverrides,
    };
    writeProjectConfigFile(configPath, next);
    return next;
  });
}

export function getProjectSourcePath(phrenPath: string, project: string, config?: ProjectConfig): string | undefined {
  const raw = (config ?? readProjectConfig(phrenPath, project)).sourcePath;
  return typeof raw === "string" && raw.trim() ? path.resolve(raw) : undefined;
}

export function getProjectOwnershipDefault(phrenPath: string): ProjectOwnershipMode {
  return parseProjectOwnershipMode(readInstallPreferences(phrenPath).projectOwnershipDefault) ?? "phren-managed";
}

export function getProjectOwnershipMode(phrenPath: string, project: string, config?: ProjectConfig): ProjectOwnershipMode {
  return parseProjectOwnershipMode((config ?? readProjectConfig(phrenPath, project)).ownership) ?? "phren-managed";
}

function normalizeHookConfig(config?: ProjectConfig): ProjectHookConfig {
  const hooks = config?.hooks;
  return hooks && typeof hooks === "object" ? hooks : {};
}

export function isProjectHookEnabled(
  phrenPath: string,
  project: string | null | undefined,
  event: ProjectHookEvent,
  config?: ProjectConfig,
): boolean {
  if (!project) return true;
  const hooks = normalizeHookConfig(config ?? readProjectConfig(phrenPath, project));
  const eventValue = hooks[event];
  if (typeof eventValue === "boolean") return eventValue;
  if (typeof hooks.enabled === "boolean") return hooks.enabled;
  return true;
}

/**
 * Remove a per-project hook override, restoring inheritance from global config.
 * Pass event to clear a specific event override; omit to clear the whole hooks block.
 */
export function clearProjectHookOverride(
  phrenPath: string,
  project: string,
  event?: string,
): ProjectConfig {
  const configPath = resolveProjectConfigPath(phrenPath, project);
  if (!configPath) throw new Error("Project config path escapes phren store");
  return withFileLock(configPath, () => {
    const current = readProjectConfig(phrenPath, project);
    const existingHooks = normalizeHookConfig(current);
    let nextHooks: ProjectHookConfig;
    if (event && PROJECT_HOOK_EVENTS.includes(event as ProjectHookEvent)) {
      // Delete just this event key
      const { [event as ProjectHookEvent]: _removed, ...rest } = existingHooks;
      nextHooks = rest as ProjectHookConfig;
    } else {
      // Clear all overrides
      nextHooks = {};
    }
    const next: ProjectConfig = { ...current, hooks: nextHooks };
    writeProjectConfigFile(configPath, next);
    return next;
  });
}

export function writeProjectHookConfig(
  phrenPath: string,
  project: string,
  patch: Partial<ProjectHookConfig>,
): ProjectConfig {
  // Move read+merge inside the lock so concurrent writers cannot clobber each other.
  const configPath = resolveProjectConfigPath(phrenPath, project);
  if (!configPath) {
    throw new Error(`Project config path escapes phren store`);
  }
  return withFileLock(configPath, () => {
    const current = readProjectConfig(phrenPath, project);
    const next: ProjectConfig = {
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

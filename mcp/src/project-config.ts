import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { readInstallPreferences } from "./init-preferences.js";
import { debugLog } from "./shared.js";
import { errorMessage } from "./utils.js";

export const PROJECT_OWNERSHIP_MODES = ["phren-managed", "detached", "repo-managed"] as const;
export type ProjectOwnershipMode = typeof PROJECT_OWNERSHIP_MODES[number];

export interface ProjectMcpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
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
}

export const PROJECT_HOOK_EVENTS = ["UserPromptSubmit", "Stop", "SessionStart", "PostToolUse"] as const;
export type ProjectHookEvent = typeof PROJECT_HOOK_EVENTS[number];

type ProjectHookConfig = NonNullable<ProjectConfig["hooks"]>;

export function parseProjectOwnershipMode(raw: string | undefined | null): ProjectOwnershipMode | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "phren" || normalized === "managed" || normalized === "phren") return "phren-managed";
  if (normalized === "repo" || normalized === "external") return "repo-managed";
  if (PROJECT_OWNERSHIP_MODES.includes(normalized as ProjectOwnershipMode)) {
    return normalized as ProjectOwnershipMode;
  }
  return undefined;
}

export function projectConfigPath(phrenPath: string, project: string): string {
  return path.join(phrenPath, project, "phren.project.yaml");
}

export function readProjectConfig(phrenPath: string, project: string): ProjectConfig {
  const configPath = projectConfigPath(phrenPath, project);
  if (!fs.existsSync(configPath)) return {};
  try {
    const parsed = yaml.load(fs.readFileSync(configPath, "utf8"), { schema: yaml.CORE_SCHEMA });
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as ProjectConfig : {};
  } catch (err: unknown) {
    debugLog(`readProjectConfig: failed to parse ${configPath}: ${errorMessage(err)}`);
    return {};
  }
}

export function writeProjectConfig(phrenPath: string, project: string, patch: Partial<ProjectConfig>): ProjectConfig {
  const configPath = projectConfigPath(phrenPath, project);
  const current = readProjectConfig(phrenPath, project);
  const next: ProjectConfig = {
    ...current,
    ...patch,
  };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmpPath = `${configPath}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(tmpPath, yaml.dump(next, { lineWidth: 1000 }));
  fs.renameSync(tmpPath, configPath);
  return next;
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

export function writeProjectHookConfig(
  phrenPath: string,
  project: string,
  patch: Partial<ProjectHookConfig>,
): ProjectConfig {
  const current = readProjectConfig(phrenPath, project);
  return writeProjectConfig(phrenPath, project, {
    hooks: {
      ...normalizeHookConfig(current),
      ...patch,
    },
  });
}

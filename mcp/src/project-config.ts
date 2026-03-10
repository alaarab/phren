import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { readInstallPreferences } from "./init-preferences.js";
import { debugLog } from "./shared.js";
import { errorMessage } from "./utils.js";

export const PROJECT_OWNERSHIP_MODES = ["cortex-managed", "detached", "repo-managed"] as const;
export type ProjectOwnershipMode = typeof PROJECT_OWNERSHIP_MODES[number];

export interface ProjectMcpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ProjectConfig {
  ownership?: ProjectOwnershipMode;
  skills?: boolean;
  hooks?: {
    UserPromptSubmit?: boolean;
    Stop?: boolean;
    SessionStart?: boolean;
  };
  mcpServers?: Record<string, ProjectMcpServerEntry>;
}

export function parseProjectOwnershipMode(raw: string | undefined | null): ProjectOwnershipMode | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "cortex" || normalized === "managed") return "cortex-managed";
  if (normalized === "repo" || normalized === "external") return "repo-managed";
  if (PROJECT_OWNERSHIP_MODES.includes(normalized as ProjectOwnershipMode)) {
    return normalized as ProjectOwnershipMode;
  }
  return undefined;
}

export function projectConfigPath(cortexPath: string, project: string): string {
  return path.join(cortexPath, project, "cortex.project.yaml");
}

export function readProjectConfig(cortexPath: string, project: string): ProjectConfig {
  const configPath = projectConfigPath(cortexPath, project);
  if (!fs.existsSync(configPath)) return {};
  try {
    const parsed = yaml.load(fs.readFileSync(configPath, "utf8"), { schema: yaml.CORE_SCHEMA });
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as ProjectConfig : {};
  } catch (err: unknown) {
    debugLog(`readProjectConfig: failed to parse ${configPath}: ${errorMessage(err)}`);
    return {};
  }
}

export function writeProjectConfig(cortexPath: string, project: string, patch: Partial<ProjectConfig>): ProjectConfig {
  const configPath = projectConfigPath(cortexPath, project);
  const current = readProjectConfig(cortexPath, project);
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

export function getProjectOwnershipDefault(cortexPath: string): ProjectOwnershipMode {
  return parseProjectOwnershipMode(readInstallPreferences(cortexPath).projectOwnershipDefault) ?? "cortex-managed";
}

export function getProjectOwnershipMode(cortexPath: string, project: string, config?: ProjectConfig): ProjectOwnershipMode {
  return parseProjectOwnershipMode((config ?? readProjectConfig(cortexPath, project)).ownership) ?? "cortex-managed";
}

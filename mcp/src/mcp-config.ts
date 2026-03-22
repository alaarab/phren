import * as fs from "fs";
import * as path from "path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpContext, mcpResponse } from "./mcp-types.js";
import { z } from "zod";
import {
  getRetentionPolicy,
  updateRetentionPolicy,
  getWorkflowPolicy,
  updateWorkflowPolicy,
  getIndexPolicy,
  updateIndexPolicy,
  mergeConfig,
  VALID_TASK_MODES,
  VALID_FINDING_SENSITIVITY,
} from "./shared-governance.js";
import {
  PROACTIVITY_LEVELS,
  type ProactivityLevel,
} from "./proactivity.js";
import {
  writeGovernanceInstallPreferences,
} from "./init-preferences.js";
import { FINDING_SENSITIVITY_CONFIG, buildProactivitySnapshot, checkProjectInProfile } from "./cli-config.js";
import {
  readProjectConfig,
  type ProjectConfigOverrides,
  updateProjectConfigOverrides,
} from "./project-config.js";
import { isValidProjectName, safeProjectPath } from "./utils.js";
import {
  readProjectTopics,
  writeProjectTopics,
  type ProjectTopic,
} from "./project-topics.js";
// ── Helpers ─────────────────────────────────────────────────────────────────

function proactivitySnapshot(phrenPath: string) {
  const snap = buildProactivitySnapshot(phrenPath);
  return { configured: snap.configured, effective: snap.effective };
}

function validateProject(project: string): string | null {
  if (!isValidProjectName(project)) return `Invalid project name: "${project}".`;
  return null;
}

function checkProjectRegistered(phrenPath: string, project: string): string | null {
  const warning = checkProjectInProfile(phrenPath, project);
  if (warning) {
    return `Project '${project}' is not registered in your active profile. Config was written but won't take effect until you run 'phren add' to register the project.`;
  }
  return null;
}

function normalizeProjectOverrides(raw: unknown): ProjectConfigOverrides {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as ProjectConfigOverrides : {};
}

function getProjectOverrides(phrenPath: string, project: string): ProjectConfigOverrides {
  return normalizeProjectOverrides(readProjectConfig(phrenPath, project).config);
}

function hasOwnOverride(overrides: ProjectConfigOverrides, key: keyof ProjectConfigOverrides): boolean {
  return Object.prototype.hasOwnProperty.call(overrides, key);
}


const projectParam = z.string().optional().describe(
  "Project name. When provided, writes to that project's phren.project.yaml instead of global .config/."
);

// ── Topic helpers (shared by get_config topic domain and set_config topic domain) ──

function getTopicConfigData(phrenPath: string, project: string) {
  const projectDir = safeProjectPath(phrenPath, project);
  if (!projectDir || !fs.existsSync(projectDir)) {
    return { ok: false as const, error: `Project "${project}" not found in phren.` };
  }

  const result = readProjectTopics(phrenPath, project);
  const configPath = path.join(projectDir, "topic-config.json");
  const raw = fs.existsSync(configPath)
    ? (() => { try { return JSON.parse(fs.readFileSync(configPath, "utf8")); } catch { return null; } })()
    : null;

  return {
    ok: true as const,
    data: {
      project,
      source: result.source,
      domain: result.domain ?? raw?.domain ?? null,
      topics: result.topics,
      pinnedTopics: raw?.pinnedTopics ?? [],
    },
  };
}

// ── Registration ────────────────────────────────────────────────────────────

export function register(server: McpServer, ctx: McpContext): void {
  const { phrenPath } = ctx;

  // ── get_config ────────────────────────────────────────────────────────────

  server.registerTool(
    "get_config",
    {
      title: "◆ phren · get config",
      description:
        "Read current configuration for one or all config domains: proactivity, taskMode, " +
        "findingSensitivity, retention (policy), workflow, access, index, topic. " +
        "Returns both configured and effective values. When project is provided, returns " +
        "the merged view with project overrides applied and _source annotations.",
      inputSchema: z.object({
        domain: z
          .enum(["proactivity", "taskMode", "findingSensitivity", "retention", "workflow", "access", "index", "topic", "all"])
          .optional()
          .describe("Config domain to read. Defaults to 'all'."),
        project: projectParam,
      }),
    },
    async ({ domain, project }) => {
      const d = domain ?? "all";

      // topic domain requires a project
      if (d === "topic") {
        if (!project) {
          return mcpResponse({ ok: false, error: "The 'topic' domain requires a project parameter." });
        }
        const err = validateProject(project);
        if (err) return mcpResponse({ ok: false, error: err });

        const topicResult = getTopicConfigData(phrenPath, project);
        if (!topicResult.ok) return mcpResponse({ ok: false, error: topicResult.error });

        return mcpResponse({
          ok: true,
          message: `Topic config for "${project}" (source: ${topicResult.data.source}).`,
          data: topicResult.data,
        });
      }

      if (project) {
        const err = validateProject(project);
        if (err) return mcpResponse({ ok: false, error: err });

        const resolved = mergeConfig(phrenPath, project);
        const projectOverrides = getProjectOverrides(phrenPath, project);

        function src(key: keyof ProjectConfigOverrides): "project" | "global" {
          return hasOwnOverride(projectOverrides, key) ? "project" : "global";
        }

        const result: Record<string, unknown> = {
          _project: project,
          _note: "Values marked _source=project override the global default.",
        };

        if (d === "all" || d === "findingSensitivity") {
          const level = resolved.findingSensitivity;
          result.findingSensitivity = {
            level,
            ...FINDING_SENSITIVITY_CONFIG[level],
            _source: src("findingSensitivity"),
          };
        }
        if (d === "all" || d === "taskMode") {
          result.taskMode = { taskMode: resolved.taskMode, _source: src("taskMode") };
        }
        if (d === "all" || d === "retention") {
          result.retention = {
            ...resolved.retentionPolicy,
            _source: hasOwnOverride(projectOverrides, "retentionPolicy") ? "project" : "global",
          };
        }
        if (d === "all" || d === "workflow") {
          result.workflow = {
            ...resolved.workflowPolicy,
            _source: hasOwnOverride(projectOverrides, "workflowPolicy") ? "project" : "global",
          };
        }
        if (d === "all" || d === "proactivity") {
          const globalSnapshot = proactivitySnapshot(phrenPath).effective;
          const base = resolved.proactivity.base ?? globalSnapshot.proactivity;
          const findings = resolved.proactivity.findings ?? resolved.proactivity.base ?? globalSnapshot.proactivityFindings;
          const tasks = resolved.proactivity.tasks ?? resolved.proactivity.base ?? globalSnapshot.proactivityTask;
          result.proactivity = {
            base,
            findings,
            tasks,
            _source: {
              base: hasOwnOverride(projectOverrides, "proactivity") ? "project" : "global",
              findings: hasOwnOverride(projectOverrides, "proactivityFindings")
                ? "project"
                : hasOwnOverride(projectOverrides, "proactivity")
                  ? "project"
                  : "global",
              tasks: hasOwnOverride(projectOverrides, "proactivityTask")
                ? "project"
                : hasOwnOverride(projectOverrides, "proactivity")
                  ? "project"
                  : "global",
            },
          };
        }
        if (d === "all" || d === "index") {
          result.index = getIndexPolicy(phrenPath);
        }

        return mcpResponse({
          ok: true,
          message: `Config for ${d === "all" ? "all domains" : d} (project: ${project}).`,
          data: result,
        });
      }

      const result: Record<string, unknown> = {};

      if (d === "all" || d === "proactivity") {
        result.proactivity = proactivitySnapshot(phrenPath);
      }
      if (d === "all" || d === "taskMode") {
        const wf = getWorkflowPolicy(phrenPath);
        result.taskMode = { taskMode: wf.taskMode };
      }
      if (d === "all" || d === "findingSensitivity") {
        const wf = getWorkflowPolicy(phrenPath);
        const level = wf.findingSensitivity;
        const config = FINDING_SENSITIVITY_CONFIG[level];
        result.findingSensitivity = { level, ...config };
      }
      if (d === "all" || d === "retention") {
        result.retention = getRetentionPolicy(phrenPath);
      }
      if (d === "all" || d === "workflow") {
        result.workflow = getWorkflowPolicy(phrenPath);
      }
      if (d === "all" || d === "index") {
        result.index = getIndexPolicy(phrenPath);
      }

      return mcpResponse({
        ok: true,
        message: `Config for ${d === "all" ? "all domains" : d}.`,
        data: result,
      });
    }
  );

  // ── set_config ──────────────────────────────────────────────────────────

  server.registerTool(
    "set_config",
    {
      title: "◆ phren · set config",
      description:
        "Update configuration for a specific domain. Replaces set_proactivity, set_task_mode, " +
        "set_finding_sensitivity, set_retention_policy, set_workflow_policy, set_index_policy, " +
        "and set_topic_config. When project is provided, writes to that project's phren.project.yaml " +
        "instead of global .config/.",
      inputSchema: z.object({
        domain: z.enum(["proactivity", "taskMode", "findingSensitivity", "retention", "workflow", "index", "topic"]),
        settings: z.record(z.string(), z.unknown()).describe(
          "Domain-specific settings. proactivity: { level, scope? } | taskMode: { mode } | " +
          "findingSensitivity: { level } | retention: { ttlDays?, retentionDays?, autoAcceptThreshold?, " +
          "minInjectConfidence?, decay? } | workflow: { lowConfidenceThreshold?, riskySections?, taskMode?, " +
          "findingSensitivity? } | index: { includeGlobs?, excludeGlobs?, includeHidden? } | " +
          "topic: { topics, domain? }"
        ),
        project: z.string().optional().describe(
          "Project name. When provided, writes to that project's phren.project.yaml instead of global .config/. " +
          "Required for the 'topic' domain."
        ),
      }),
    },
    async ({ domain, settings, project }) => {
      switch (domain) {

        // ── proactivity ───────────────────────────────────────────────
        case "proactivity": {
          const level = settings.level as ProactivityLevel | undefined;
          if (!level || !PROACTIVITY_LEVELS.includes(level)) {
            return mcpResponse({ ok: false, error: `Invalid proactivity level. Must be one of: ${PROACTIVITY_LEVELS.join(", ")}.` });
          }
          const scope = (settings.scope as string | undefined) ?? "base";
          if (!["base", "findings", "tasks"].includes(scope)) {
            return mcpResponse({ ok: false, error: `Invalid scope. Must be one of: base, findings, tasks.` });
          }
          const s = scope as "base" | "findings" | "tasks";

          if (project) {
            const err = validateProject(project);
            if (err) return mcpResponse({ ok: false, error: err });

            const warning = checkProjectRegistered(phrenPath, project);
            const key = s === "base" ? "proactivity" : s === "findings" ? "proactivityFindings" : "proactivityTask";
            updateProjectConfigOverrides(phrenPath, project, (current) => ({
              ...current,
              [key]: level,
            }));
            return mcpResponse({
              ok: true,
              message: warning
                ? `Proactivity ${s} set to ${level} for project "${project}". WARNING: ${warning}`
                : `Proactivity ${s} set to ${level} for project "${project}".`,
              data: { project, scope: s, level, ...(warning ? { warning } : {}) },
            });
          }

          const patch: Record<string, string> = {};
          if (s === "base") patch.proactivity = level;
          else if (s === "findings") patch.proactivityFindings = level;
          else if (s === "tasks") patch.proactivityTask = level;

          writeGovernanceInstallPreferences(phrenPath, patch);
          return mcpResponse({
            ok: true,
            message: `Proactivity ${s} set to ${level}.`,
            data: proactivitySnapshot(phrenPath),
          });
        }

        // ── taskMode ──────────────────────────────────────────────────
        case "taskMode": {
          const mode = settings.mode as string | undefined;
          if (!mode || !(VALID_TASK_MODES as readonly string[]).includes(mode)) {
            return mcpResponse({ ok: false, error: `Invalid task mode. Must be one of: ${VALID_TASK_MODES.join(", ")}.` });
          }
          const validMode = mode as (typeof VALID_TASK_MODES)[number];

          if (project) {
            const err = validateProject(project);
            if (err) return mcpResponse({ ok: false, error: err });

            const warning = checkProjectRegistered(phrenPath, project);
            updateProjectConfigOverrides(phrenPath, project, (current) => ({
              ...current,
              taskMode: validMode,
            }));
            return mcpResponse({
              ok: true,
              message: warning
                ? `Task mode set to ${validMode} for project "${project}". WARNING: ${warning}`
                : `Task mode set to ${validMode} for project "${project}".`,
              data: { project, taskMode: validMode, ...(warning ? { warning } : {}) },
            });
          }

          const result = updateWorkflowPolicy(phrenPath, { taskMode: validMode });
          if (!result.ok) {
            return mcpResponse({ ok: false, error: result.error, errorCode: result.code });
          }
          return mcpResponse({
            ok: true,
            message: `Task mode set to ${validMode}.`,
            data: { taskMode: validMode },
          });
        }

        // ── findingSensitivity ────────────────────────────────────────
        case "findingSensitivity": {
          const level = settings.level as string | undefined;
          if (!level || !(VALID_FINDING_SENSITIVITY as readonly string[]).includes(level)) {
            return mcpResponse({ ok: false, error: `Invalid finding sensitivity. Must be one of: ${VALID_FINDING_SENSITIVITY.join(", ")}.` });
          }
          const validLevel = level as (typeof VALID_FINDING_SENSITIVITY)[number];

          if (project) {
            const err = validateProject(project);
            if (err) return mcpResponse({ ok: false, error: err });

            const warning = checkProjectRegistered(phrenPath, project);
            updateProjectConfigOverrides(phrenPath, project, (current) => ({
              ...current,
              findingSensitivity: validLevel,
            }));
            const config = FINDING_SENSITIVITY_CONFIG[validLevel];
            return mcpResponse({
              ok: true,
              message: warning
                ? `Finding sensitivity set to ${validLevel} for project "${project}". WARNING: ${warning}`
                : `Finding sensitivity set to ${validLevel} for project "${project}".`,
              data: { project, level: validLevel, ...config, ...(warning ? { warning } : {}) },
            });
          }

          const result = updateWorkflowPolicy(phrenPath, { findingSensitivity: validLevel });
          if (!result.ok) {
            return mcpResponse({ ok: false, error: result.error, errorCode: result.code });
          }
          const config = FINDING_SENSITIVITY_CONFIG[validLevel];
          return mcpResponse({
            ok: true,
            message: `Finding sensitivity set to ${validLevel}.`,
            data: { level: validLevel, ...config },
          });
        }

        // ── retention ─────────────────────────────────────────────────
        case "retention": {
          const { ttlDays, retentionDays, autoAcceptThreshold, minInjectConfidence, decay } =
            settings as {
              ttlDays?: number;
              retentionDays?: number;
              autoAcceptThreshold?: number;
              minInjectConfidence?: number;
              decay?: { d30?: number; d60?: number; d90?: number; d120?: number };
            };

          if (project) {
            const err = validateProject(project);
            if (err) return mcpResponse({ ok: false, error: err });

            const warning = checkProjectRegistered(phrenPath, project);
            const next = updateProjectConfigOverrides(phrenPath, project, (current) => {
              const existingRetention = current.retentionPolicy ?? {};
              const retentionPatch: NonNullable<ProjectConfigOverrides["retentionPolicy"]> = { ...existingRetention };
              if (ttlDays !== undefined) retentionPatch.ttlDays = ttlDays;
              if (retentionDays !== undefined) retentionPatch.retentionDays = retentionDays;
              if (autoAcceptThreshold !== undefined) retentionPatch.autoAcceptThreshold = autoAcceptThreshold;
              if (minInjectConfidence !== undefined) retentionPatch.minInjectConfidence = minInjectConfidence;
              if (decay !== undefined) retentionPatch.decay = { ...(existingRetention.decay ?? {}), ...decay };
              return { ...current, retentionPolicy: retentionPatch };
            });
            return mcpResponse({
              ok: true,
              message: warning
                ? `Retention policy updated for project "${project}". WARNING: ${warning}`
                : `Retention policy updated for project "${project}".`,
              data: { project, retentionPolicy: next.config?.retentionPolicy ?? {}, ...(warning ? { warning } : {}) },
            });
          }

          const globalPatch: Parameters<typeof updateRetentionPolicy>[1] = {};
          if (ttlDays !== undefined) globalPatch.ttlDays = ttlDays;
          if (retentionDays !== undefined) globalPatch.retentionDays = retentionDays;
          if (autoAcceptThreshold !== undefined) globalPatch.autoAcceptThreshold = autoAcceptThreshold;
          if (minInjectConfidence !== undefined) globalPatch.minInjectConfidence = minInjectConfidence;
          if (decay !== undefined) globalPatch.decay = decay;

          const result = updateRetentionPolicy(phrenPath, globalPatch);
          if (!result.ok) {
            return mcpResponse({ ok: false, error: result.error, errorCode: result.code });
          }
          return mcpResponse({
            ok: true,
            message: "Retention policy updated.",
            data: result.data,
          });
        }

        // ── workflow ──────────────────────────────────────────────────
        case "workflow": {
          const { lowConfidenceThreshold, riskySections, taskMode, findingSensitivity } =
            settings as {
              lowConfidenceThreshold?: number;
              riskySections?: string[];
              taskMode?: string;
              findingSensitivity?: string;
            };

          if (project) {
            const err = validateProject(project);
            if (err) return mcpResponse({ ok: false, error: err });

            const warning = checkProjectRegistered(phrenPath, project);
            const next = updateProjectConfigOverrides(phrenPath, project, (current) => {
              const nextConfig: ProjectConfigOverrides = { ...current };
              const shouldUpdateWorkflowPolicy = (
                lowConfidenceThreshold !== undefined
                || riskySections !== undefined
                || current.workflowPolicy !== undefined
              );
              if (shouldUpdateWorkflowPolicy) {
                const existingWorkflow = current.workflowPolicy ?? {};
                nextConfig.workflowPolicy = {
                  ...existingWorkflow,
                  ...(lowConfidenceThreshold !== undefined ? { lowConfidenceThreshold } : {}),
                  ...(riskySections !== undefined ? { riskySections: riskySections as ("Review" | "Stale" | "Conflicts")[] } : {}),
                };
              }
              if (taskMode !== undefined) nextConfig.taskMode = taskMode as (typeof VALID_TASK_MODES)[number];
              if (findingSensitivity !== undefined) nextConfig.findingSensitivity = findingSensitivity as (typeof VALID_FINDING_SENSITIVITY)[number];
              return nextConfig;
            });
            return mcpResponse({
              ok: true,
              message: warning
                ? `Workflow policy updated for project "${project}". WARNING: ${warning}`
                : `Workflow policy updated for project "${project}".`,
              data: { project, config: next.config ?? {}, ...(warning ? { warning } : {}) },
            });
          }

          const patch: Parameters<typeof updateWorkflowPolicy>[1] = {};
          if (lowConfidenceThreshold !== undefined) patch.lowConfidenceThreshold = lowConfidenceThreshold;
          if (riskySections !== undefined) patch.riskySections = riskySections as ("Review" | "Stale" | "Conflicts")[];
          if (taskMode !== undefined) patch.taskMode = taskMode as (typeof VALID_TASK_MODES)[number];
          if (findingSensitivity !== undefined) patch.findingSensitivity = findingSensitivity as (typeof VALID_FINDING_SENSITIVITY)[number];

          const result = updateWorkflowPolicy(phrenPath, patch);
          if (!result.ok) {
            return mcpResponse({ ok: false, error: result.error, errorCode: result.code });
          }
          return mcpResponse({
            ok: true,
            message: "Workflow policy updated.",
            data: result.data,
          });
        }

        // ── index ─────────────────────────────────────────────────────
        case "index": {
          const { includeGlobs, excludeGlobs, includeHidden } =
            settings as {
              includeGlobs?: string[];
              excludeGlobs?: string[];
              includeHidden?: boolean;
            };

          const patch: Parameters<typeof updateIndexPolicy>[1] = {};
          if (includeGlobs !== undefined) patch.includeGlobs = includeGlobs;
          if (excludeGlobs !== undefined) patch.excludeGlobs = excludeGlobs;
          if (includeHidden !== undefined) patch.includeHidden = includeHidden;

          const result = updateIndexPolicy(phrenPath, patch);
          if (!result.ok) {
            return mcpResponse({ ok: false, error: result.error, errorCode: result.code });
          }
          return mcpResponse({
            ok: true,
            message: "Index policy updated.",
            data: result.data,
          });
        }

        // ── topic ─────────────────────────────────────────────────────
        case "topic": {
          if (!project) {
            return mcpResponse({ ok: false, error: "The 'topic' domain requires a project parameter." });
          }
          const err = validateProject(project);
          if (err) return mcpResponse({ ok: false, error: err });

          const projectDir = safeProjectPath(phrenPath, project);
          if (!projectDir || !fs.existsSync(projectDir)) {
            return mcpResponse({ ok: false, error: `Project "${project}" not found in phren.` });
          }

          const topics = settings.topics as Array<{
            slug: string;
            label: string;
            description?: string;
            keywords?: string[];
          }> | undefined;

          if (!topics || !Array.isArray(topics)) {
            return mcpResponse({ ok: false, error: "The 'topic' domain requires a 'topics' array in settings." });
          }

          const topicDomain = settings.domain as string | undefined;

          const normalized: ProjectTopic[] = topics.map((t) => ({
            slug: t.slug,
            label: t.label,
            description: t.description ?? "",
            keywords: t.keywords ?? [],
          }));

          // If a domain is provided, patch it onto the existing file before writing topics
          if (topicDomain) {
            const configPath = path.join(projectDir, "topic-config.json");
            if (fs.existsSync(configPath)) {
              try {
                const existing = JSON.parse(fs.readFileSync(configPath, "utf8"));
                if (existing && typeof existing === "object") {
                  existing.domain = topicDomain;
                  fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n");
                }
              } catch {
                // ignore read errors; writeProjectTopics will still succeed
              }
            } else {
              fs.mkdirSync(projectDir, { recursive: true });
              fs.writeFileSync(configPath, JSON.stringify({ version: 1, domain: topicDomain, topics: [] }, null, 2) + "\n");
            }
          }

          const result = writeProjectTopics(phrenPath, project, normalized);
          if (!result.ok) {
            return mcpResponse({ ok: false, error: result.error });
          }

          return mcpResponse({
            ok: true,
            message: `Topic config written for "${project}" (${result.topics.length} topics).`,
            data: { project, topics: result.topics, domain: topicDomain ?? null },
          });
        }

        default:
          return mcpResponse({ ok: false, error: `Unknown config domain: ${domain}` });
      }
    }
  );
}

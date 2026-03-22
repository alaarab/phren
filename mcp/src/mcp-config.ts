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
        "findingSensitivity, retention (policy), workflow, access, index. " +
        "Returns both configured and effective values. When project is provided, returns " +
        "the merged view with project overrides applied and _source annotations.",
      inputSchema: z.object({
        domain: z
          .enum(["proactivity", "taskMode", "findingSensitivity", "retention", "workflow", "access", "index", "all"])
          .optional()
          .describe("Config domain to read. Defaults to 'all'."),
        project: projectParam,
      }),
    },
    async ({ domain, project }) => {
      const d = domain ?? "all";

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

  // ── set_proactivity ───────────────────────────────────────────────────────

  server.registerTool(
    "set_proactivity",
    {
      title: "◆ phren · set proactivity",
      description:
        "Set the proactivity level for auto-capture. Controls how aggressively phren " +
        "captures findings and tasks. Supports base level, findings-specific, and task-specific overrides. " +
        "When project is provided, writes to that project's phren.project.yaml.",
      inputSchema: z.object({
        level: z.enum(PROACTIVITY_LEVELS).describe("Proactivity level: high, medium, or low."),
        scope: z
          .enum(["base", "findings", "tasks"])
          .optional()
          .describe("Which proactivity to set. Defaults to 'base'."),
        project: projectParam,
      }),
    },
    async ({ level, scope, project }) => {
      const s = scope ?? "base";

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
  );

  // ── set_task_mode ─────────────────────────────────────────────────────────

  server.registerTool(
    "set_task_mode",
    {
      title: "◆ phren · set task mode",
      description:
        "Set the task automation mode: off (no auto-tasks), manual (user creates), " +
        "suggest (phren suggests, user approves), auto (phren creates automatically). " +
        "When project is provided, writes to that project's phren.project.yaml.",
      inputSchema: z.object({
        mode: z.enum(VALID_TASK_MODES).describe("Task mode: off, manual, suggest, or auto."),
        project: projectParam,
      }),
    },
    async ({ mode, project }) => {
      if (project) {
        const err = validateProject(project);
        if (err) return mcpResponse({ ok: false, error: err });

        const warning = checkProjectRegistered(phrenPath, project);
        updateProjectConfigOverrides(phrenPath, project, (current) => ({
          ...current,
          taskMode: mode,
        }));
        return mcpResponse({
          ok: true,
          message: warning
            ? `Task mode set to ${mode} for project "${project}". WARNING: ${warning}`
            : `Task mode set to ${mode} for project "${project}".`,
          data: { project, taskMode: mode, ...(warning ? { warning } : {}) },
        });
      }

      const result = updateWorkflowPolicy(phrenPath, { taskMode: mode });
      if (!result.ok) {
        return mcpResponse({ ok: false, error: result.error, errorCode: result.code });
      }
      return mcpResponse({
        ok: true,
        message: `Task mode set to ${mode}.`,
        data: { taskMode: mode },
      });
    }
  );

  // ── set_finding_sensitivity ───────────────────────────────────────────────

  server.registerTool(
    "set_finding_sensitivity",
    {
      title: "◆ phren · set finding sensitivity",
      description:
        "Set the finding capture sensitivity level. Controls how many findings phren captures per session. " +
        "minimal: only explicit asks. conservative: decisions/pitfalls only. " +
        "balanced: non-obvious patterns. aggressive: capture everything. " +
        "When project is provided, writes to that project's phren.project.yaml.",
      inputSchema: z.object({
        level: z.enum(VALID_FINDING_SENSITIVITY).describe("Sensitivity level."),
        project: projectParam,
      }),
    },
    async ({ level, project }) => {
      if (project) {
        const err = validateProject(project);
        if (err) return mcpResponse({ ok: false, error: err });

        const warning = checkProjectRegistered(phrenPath, project);
        updateProjectConfigOverrides(phrenPath, project, (current) => ({
          ...current,
          findingSensitivity: level,
        }));
        const config = FINDING_SENSITIVITY_CONFIG[level];
        return mcpResponse({
          ok: true,
          message: warning
            ? `Finding sensitivity set to ${level} for project "${project}". WARNING: ${warning}`
            : `Finding sensitivity set to ${level} for project "${project}".`,
          data: { project, level, ...config, ...(warning ? { warning } : {}) },
        });
      }

      const result = updateWorkflowPolicy(phrenPath, { findingSensitivity: level });
      if (!result.ok) {
        return mcpResponse({ ok: false, error: result.error, errorCode: result.code });
      }
      const config = FINDING_SENSITIVITY_CONFIG[level];
      return mcpResponse({
        ok: true,
        message: `Finding sensitivity set to ${level}.`,
        data: { level, ...config },
      });
    }
  );

  // ── set_retention_policy ──────────────────────────────────────────────────

  server.registerTool(
    "set_retention_policy",
    {
      title: "◆ phren · set retention policy",
      description:
        "Update memory retention policy: TTL, retention days, auto-accept threshold, " +
        "minimum injection confidence, and decay curve. " +
        "When project is provided, writes to that project's phren.project.yaml.",
      inputSchema: z.object({
        ttlDays: z.number().int().min(1).optional().describe("Days before a finding is considered for expiry."),
        retentionDays: z.number().int().min(1).optional().describe("Hard retention limit in days."),
        autoAcceptThreshold: z.number().min(0).max(1).optional().describe("Score threshold (0-1) for auto-accepting extracted memories."),
        minInjectConfidence: z.number().min(0).max(1).optional().describe("Minimum confidence (0-1) to inject a finding into context."),
        decay: z
          .object({
            d30: z.number().min(0).max(1).optional(),
            d60: z.number().min(0).max(1).optional(),
            d90: z.number().min(0).max(1).optional(),
            d120: z.number().min(0).max(1).optional(),
          })
          .optional()
          .describe("Decay multipliers at 30/60/90/120 day marks."),
        project: projectParam,
      }),
    },
    async ({ ttlDays, retentionDays, autoAcceptThreshold, minInjectConfidence, decay, project }) => {
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
  );

  // ── set_workflow_policy ───────────────────────────────────────────────────

  server.registerTool(
    "set_workflow_policy",
    {
      title: "◆ phren · set workflow policy",
      description:
        "Update workflow policy: low-confidence threshold, " +
        "risky sections list, task mode, and finding sensitivity. " +
        "When project is provided, writes to that project's phren.project.yaml.",
      inputSchema: z.object({
        lowConfidenceThreshold: z.number().min(0).max(1).optional()
          .describe("Confidence below which items are flagged as low-confidence."),
        riskySections: z.array(z.enum(["Review", "Stale", "Conflicts"])).optional()
          .describe("Which queue sections are considered risky."),
        taskMode: z.enum(VALID_TASK_MODES).optional()
          .describe("Task automation mode."),
        findingSensitivity: z.enum(VALID_FINDING_SENSITIVITY).optional()
          .describe("Finding capture sensitivity."),
        project: projectParam,
      }),
    },
    async ({ lowConfidenceThreshold, riskySections, taskMode, findingSensitivity, project }) => {
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
              ...(riskySections !== undefined ? { riskySections } : {}),
            };
          }
          if (taskMode !== undefined) nextConfig.taskMode = taskMode;
          if (findingSensitivity !== undefined) nextConfig.findingSensitivity = findingSensitivity;
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
      if (riskySections !== undefined) patch.riskySections = riskySections;
      if (taskMode !== undefined) patch.taskMode = taskMode;
      if (findingSensitivity !== undefined) patch.findingSensitivity = findingSensitivity;

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
  );

  // ── set_index_policy ──────────────────────────────────────────────────────

  server.registerTool(
    "set_index_policy",
    {
      title: "◆ phren · set index policy",
      description:
        "Update the FTS indexer policy: include/exclude glob patterns and hidden file inclusion.",
      inputSchema: z.object({
        includeGlobs: z.array(z.string()).optional()
          .describe("Glob patterns for files to include in the index."),
        excludeGlobs: z.array(z.string()).optional()
          .describe("Glob patterns for files to exclude from the index."),
        includeHidden: z.boolean().optional()
          .describe("Whether to index hidden (dot-prefixed) files."),
      }),
    },
    async ({ includeGlobs, excludeGlobs, includeHidden }) => {
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
  );

  // ── get_topic_config ──────────────────────────────────────────────────────

  server.registerTool(
    "get_topic_config",
    {
      title: "◆ phren · get topic config",
      description:
        "Read the topic-config.json for a project. Returns the list of topics, domain, " +
        "and pinned topics. When no config exists, returns the built-in default topics for the project.",
      inputSchema: z.object({
        project: z.string().describe("Project name to read topic config from."),
      }),
    },
    async ({ project }) => {
      const err = validateProject(project);
      if (err) return mcpResponse({ ok: false, error: err });

      const projectDir = safeProjectPath(phrenPath, project);
      if (!projectDir || !fs.existsSync(projectDir)) {
        return mcpResponse({ ok: false, error: `Project "${project}" not found in phren.` });
      }

      const result = readProjectTopics(phrenPath, project);
      const configPath = path.join(projectDir, "topic-config.json");
      const raw = fs.existsSync(configPath)
        ? (() => { try { return JSON.parse(fs.readFileSync(configPath, "utf8")); } catch { return null; } })()
        : null;

      return mcpResponse({
        ok: true,
        message: `Topic config for "${project}" (source: ${result.source}).`,
        data: {
          project,
          source: result.source,
          domain: result.domain ?? raw?.domain ?? null,
          topics: result.topics,
          pinnedTopics: raw?.pinnedTopics ?? [],
        },
      });
    }
  );

  // ── set_topic_config ──────────────────────────────────────────────────────

  server.registerTool(
    "set_topic_config",
    {
      title: "◆ phren · set topic config",
      description:
        "Write the topic-config.json for a project. Accepts a list of topics with slug, label, " +
        "description, and keywords. Merges with any existing pinnedTopics and domain.",
      inputSchema: z.object({
        project: z.string().describe("Project name to write topic config for."),
        topics: z.array(z.object({
          slug: z.string().describe("Topic slug (lowercase, hyphens allowed)."),
          label: z.string().describe("Human-readable label."),
          description: z.string().optional().describe("Short description of what goes in this topic."),
          keywords: z.array(z.string()).optional().describe("Keywords used for auto-classification."),
        })).describe("Topic list to write."),
        domain: z.string().optional().describe("Optional domain label (e.g. 'software', 'music')."),
      }),
    },
    async ({ project, topics, domain }) => {
      const err = validateProject(project);
      if (err) return mcpResponse({ ok: false, error: err });

      const projectDir = safeProjectPath(phrenPath, project);
      if (!projectDir || !fs.existsSync(projectDir)) {
        return mcpResponse({ ok: false, error: `Project "${project}" not found in phren.` });
      }

      const normalized: ProjectTopic[] = topics.map((t) => ({
        slug: t.slug,
        label: t.label,
        description: t.description ?? "",
        keywords: t.keywords ?? [],
      }));

      // If a domain is provided, patch it onto the existing file before writing topics
      if (domain) {
        const configPath = path.join(projectDir, "topic-config.json");
        if (fs.existsSync(configPath)) {
          try {
            const existing = JSON.parse(fs.readFileSync(configPath, "utf8"));
            if (existing && typeof existing === "object") {
              existing.domain = domain;
              fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n");
            }
          } catch {
            // ignore read errors; writeProjectTopics will still succeed
          }
        } else {
          fs.mkdirSync(projectDir, { recursive: true });
          fs.writeFileSync(configPath, JSON.stringify({ version: 1, domain, topics: [] }, null, 2) + "\n");
        }
      }

      const result = writeProjectTopics(phrenPath, project, normalized);
      if (!result.ok) {
        return mcpResponse({ ok: false, error: result.error });
      }

      return mcpResponse({
        ok: true,
        message: `Topic config written for "${project}" (${result.topics.length} topics).`,
        data: { project, topics: result.topics, domain: domain ?? null },
      });
    }
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpContext, mcpResponse } from "./mcp-types.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { runtimeFile, getProjectDirs } from "./shared.js";
import { findFtsCacheForPath } from "./shared-index.js";
import { isValidProjectName } from "./utils.js";
import { readReviewQueue, readReviewQueueAcrossProjects } from "./data-access.js";
import { addProjectFromPath } from "./core-project.js";
import { PROJECT_OWNERSHIP_MODES, parseProjectOwnershipMode } from "./project-config.js";
import { resolveRuntimeProfile } from "./runtime-profile.js";
import { getMachineName } from "./machine-identity.js";

import type { PhrenResult } from "./shared.js";
import type { McpToolResult } from "./mcp-types.js";
import { getProjectConsolidationStatus, CONSOLIDATION_ENTRY_THRESHOLD } from "./content-validate.js";

/** Translate a PhrenResult<string> into a standard McpToolResult shape. */
function phrenResultToMcp(result: PhrenResult<string>): McpToolResult {
  if (result.ok) {
    return { ok: true, message: result.data };
  }
  return { ok: false, error: result.error, errorCode: result.code };
}

export function register(server: McpServer, ctx: McpContext): void {
  const { phrenPath, profile, withWriteQueue, updateFileInIndex } = ctx;

  // ── get_consolidation_status ───────────────────────────────────────────────

  server.registerTool(
    "add_project",
    {
      title: "◆ phren · add project",
      description:
        "Bootstrap a project into phren from a repo or working directory. " +
        "Copies or creates CLAUDE.md/summary/tasks/findings under ~/.phren/<project> and adds the project to the active profile.",
      inputSchema: z.object({
        path: z.string().describe("Project path to import. Pass the current repo path explicitly."),
        profile: z.string().optional().describe("Profile to update. Defaults to the active profile."),
        ownership: z.enum(PROJECT_OWNERSHIP_MODES).optional()
          .describe("How Phren should treat repo-facing instruction files: phren-managed, detached, or repo-managed."),
      }),
    },
    async ({ path: targetPath, profile: requestedProfile, ownership }) => {
      return withWriteQueue(async () => {
        try {
          const added = addProjectFromPath(
            phrenPath,
            targetPath,
            requestedProfile || profile || undefined,
            parseProjectOwnershipMode(ownership) ?? undefined
          );
          if (!added.ok) {
            return mcpResponse({
              ok: false,
              error: added.error,
            });
          }
          await ctx.rebuildIndex();
          return mcpResponse({
            ok: true,
            message: `Added project "${added.data.project}" (${added.data.ownership}) from ${added.data.path}.`,
            data: added.data,
          });
        } catch (err: unknown) {
          return mcpResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    }
  );

  server.registerTool(
    "get_consolidation_status",
    {
      title: "◆ phren · consolidation status",
      description:
        "Check whether a project's FINDINGS.md needs consolidation. " +
        "Returns entry count since last consolidation, threshold, and recommendation.",
      inputSchema: z.object({
        project: z.string().optional().describe("Project name. If omitted, checks all projects."),
      }),
    },
    async ({ project }) => {
      const projectDirs = project
        ? (() => {
            if (!isValidProjectName(project)) return [];
            const dir = path.join(phrenPath, project);
            return fs.existsSync(dir) ? [dir] : [];
          })()
        : getProjectDirs(phrenPath, profile);

      if (project && projectDirs.length === 0) {
        return mcpResponse({ ok: false, error: `Project "${project}" not found.` });
      }

      const results: Array<{
        project: string;
        entriesSince: number;
        threshold: number;
        daysSince: number | null;
        lastConsolidated: string | null;
        recommended: boolean;
      }> = [];

      for (const dir of projectDirs) {
        const status = getProjectConsolidationStatus(dir);
        if (!status) continue;
        results.push({ ...status, threshold: CONSOLIDATION_ENTRY_THRESHOLD });
      }

      if (results.length === 0) {
        return mcpResponse({ ok: true, message: "No FINDINGS.md files found.", data: { results: [] } });
      }

      const lines = results.map(r =>
        `${r.project}: ${r.entriesSince} entries since${r.lastConsolidated ? ` ${r.lastConsolidated}` : " (never consolidated)"}` +
        `${r.recommended ? " — consolidation recommended" : ""}`
      );

      return mcpResponse({
        ok: true,
        message: lines.join("\n"),
        data: { results },
      });
    }
  );

  // ── health_check ───────────────────────────────────────────────────────────

  server.registerTool(
    "health_check",
    {
      title: "◆ phren · health",
      description:
        "Return phren health status: version, FTS index status, hook registration, and profile/machine info.",
      inputSchema: z.object({}),
    },
    async () => {
      const activeProfile = (() => {
        try {
          return resolveRuntimeProfile(phrenPath);
        } catch {
          return profile || "";
        }
      })();

      // Version
      let version = "unknown";
      try {
        const pkgPath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "package.json");
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        version = pkg.version || "unknown";
      } catch (err: unknown) {
        if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG)) process.stderr.write(`[phren] healthCheck version: ${err instanceof Error ? err.message : String(err)}\n`);
      }

      // FTS index (lives in /tmpphren-fts-*/, not .runtime/)
      let indexStatus: { exists: boolean; sizeBytes?: number } = { exists: false };
      try {
        indexStatus = findFtsCacheForPath(phrenPath, activeProfile);
      } catch (err: unknown) {
        if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG)) process.stderr.write(`[phren] healthCheck ftsCacheCheck: ${err instanceof Error ? err.message : String(err)}\n`);
      }

      // Hook registration
      let hooksEnabled = false;
      try {
        const { getHooksEnabledPreference } = await import("./init-preferences.js");
        hooksEnabled = getHooksEnabledPreference(phrenPath);
      } catch (err: unknown) {
        if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG)) process.stderr.write(`[phren] healthCheck hooksEnabled: ${err instanceof Error ? err.message : String(err)}\n`);
      }

      let mcpEnabled = false;
      try {
        const { getMcpEnabledPreference } = await import("./init-preferences.js");
        mcpEnabled = getMcpEnabledPreference(phrenPath);
      } catch (err: unknown) {
        if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG)) process.stderr.write(`[phren] healthCheck mcpEnabled: ${err instanceof Error ? err.message : String(err)}\n`);
      }

      // Profile/machine info
      const machineName = (() => {
        try {
          return getMachineName();
        } catch (err: unknown) {
          if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG)) process.stderr.write(`[phren] healthCheck machineName: ${err instanceof Error ? err.message : String(err)}\n`);
        }
        return undefined;
      })();

      const projectCount = getProjectDirs(phrenPath, activeProfile).length;

      // Proactivity and taskMode
      let proactivity: string = "high";
      let taskMode: string = "auto";
      try {
        const { getWorkflowPolicy } = await import("./governance-policy.js");
        const workflowPolicy = getWorkflowPolicy(phrenPath);
        taskMode = workflowPolicy.taskMode;
      } catch (err: unknown) {
        if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG)) process.stderr.write(`[phren] healthCheck taskMode: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      try {
        const { readInstallPreferences } = await import("./init-preferences.js");
        const prefs = readInstallPreferences(phrenPath);
        proactivity = prefs.proactivity || "high";
      } catch (err: unknown) {
        if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG)) process.stderr.write(`[phren] healthCheck proactivity: ${err instanceof Error ? err.message : String(err)}\n`);
      }

      const lines = [
        `Phren v${version}`,
        `Profile: ${activeProfile || "(default)"}`,
        machineName ? `Machine: ${machineName}` : null,
        `Projects: ${projectCount}`,
        `FTS index: ${indexStatus.exists ? `ok (${Math.round((indexStatus.sizeBytes ?? 0) / 1024)} KB)` : "missing"}`,
        `MCP: ${mcpEnabled ? "enabled" : "disabled"}`,
        `Hooks: ${hooksEnabled ? "enabled" : "disabled"}`,
        `Proactivity: ${proactivity}`,
        `Task mode: ${taskMode}`,
        `Path: ${phrenPath}`,
      ].filter(Boolean);

      return mcpResponse({
        ok: true,
        message: lines.join("\n"),
        data: {
          version,
          profile: activeProfile || "(default)",
          machine: machineName ?? null,
          projectCount,
          index: indexStatus,
          mcpEnabled,
          hooksEnabled,
          proactivity,
          taskMode,
          phrenPath,
        },
      });
    }
  );

  // ── doctor_fix ─────────────────────────────────────────────────────────────

  server.registerTool(
    "doctor_fix",
    {
      title: "◆ phren · doctor fix",
      description:
        "Run phren doctor with --fix: re-links hooks, symlinks, context, and memory pointers. " +
        "Returns the list of checks and repair actions taken.",
      inputSchema: z.object({
        check_data: z.boolean().optional()
          .describe("Also validate data files (tasks, findings, governance). Default false."),
      }),
    },
    async ({ check_data }) => {
      const { runDoctor } = await import("./link-doctor.js");
      const result = await runDoctor(phrenPath, true, check_data ?? false);
      const lines = result.checks.map((c) => `${c.ok ? "ok" : "FAIL"} ${c.name}: ${c.detail}`);
      return mcpResponse({
        ok: result.ok,
        message: result.ok
          ? `Doctor fix complete: all ${result.checks.length} checks passed`
          : `Doctor fix complete: ${result.checks.filter((c) => !c.ok).length} issue(s) remain`,
        data: {
          machine: result.machine,
          profile: result.profile,
          checks: result.checks,
          summary: lines.join("\n"),
        },
      });
    }
  );

  // ── list_hook_errors ───────────────────────────────────────────────────────

  server.registerTool(
    "list_hook_errors",
    {
      title: "◆ phren · hook errors",
      description:
        "List recent error entries from phren hook-errors.log and debug.log. " +
        "Useful for diagnosing hook or index failures.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).optional()
          .describe("Max error entries to return (default 20)."),
      }),
    },
    async ({ limit }) => {
      const maxEntries = limit ?? 20;

      const ERROR_PATTERNS = [
        /\berror\b/i,
        /\bfail(ed|ure|s)?\b/i,
        /\bcrash(ed)?\b/i,
        /\btimeout\b/i,
        /\bEXCEPTION\b/i,
        /\bEACCES\b/,
        /\bENOENT\b/,
        /\bEPERM\b/,
        /\bENOSPC\b/,
      ];

      function readErrorLines(filePath: string, filterPatterns: boolean): string[] {
        try {
          if (!fs.existsSync(filePath)) return [];
          const content = fs.readFileSync(filePath, "utf8");
          const lines = content.split("\n").filter(l => l.trim());
          if (!filterPatterns) return lines; // hook-errors.log: every line is an error
          return lines.filter(line => ERROR_PATTERNS.some(p => p.test(line)));
        } catch (err: unknown) {
          if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG)) process.stderr.write(`[phren] readErrorLines: ${err instanceof Error ? err.message : String(err)}\n`);
          return [];
        }
      }

      // hook-errors.log contains only hook failure lines (no filtering needed)
      const hookErrors = readErrorLines(runtimeFile(phrenPath, "hook-errors.log"), false);
      // debug.log may contain non-error lines, so filter
      const debugErrors = readErrorLines(runtimeFile(phrenPath, "debug.log"), true);

      const allErrors = [...hookErrors, ...debugErrors];

      if (allErrors.length === 0) {
        return mcpResponse({
          ok: true,
          message: "No error entries found. Hook errors go to hook-errors.log; general errors require PHREN_DEBUG=1.",
          data: { errors: [], total: 0 },
        });
      }

      const recent = allErrors.slice(-maxEntries);
      return mcpResponse({
        ok: true,
        message: `Found ${allErrors.length} error(s), showing last ${recent.length}:\n\n${recent.join("\n")}`,
        data: { errors: recent, total: allErrors.length, sources: { hookErrors: hookErrors.length, debugErrors: debugErrors.length } },
      });
    }
  );

  // ── get_review_queue ─────────────────────────────────────────────────────

  server.registerTool(
    "get_review_queue",
    {
      title: "◆ phren · get review queue",
      description:
        "List all items in a project's review queue (review.md), or across all projects when omitted. " +
        "Returns items with their id, section (Review/Stale/Conflicts), date, text, confidence, and risky flag.",
      inputSchema: z.object({
        project: z.string().optional().describe("Project name. Omit to read the review queue across all projects in the active profile."),
      }),
    },
    async ({ project }) => {
      if (project && !isValidProjectName(project)) {
        return mcpResponse({ ok: false, error: `Invalid project name: "${project}".` });
      }
      if (project) {
        const result = readReviewQueue(phrenPath, project);
        if (!result.ok) {
          return mcpResponse({ ok: false, error: result.error, errorCode: result.code });
        }
        const items = result.data.map((item) => ({ ...item, project }));
        return mcpResponse({
          ok: true,
          message: `${items.length} queue item(s) for "${project}".`,
          data: { items },
        });
      }

      const result = readReviewQueueAcrossProjects(phrenPath, profile);
      if (!result.ok) {
        return mcpResponse({ ok: false, error: result.error, errorCode: result.code });
      }
      return mcpResponse({
        ok: true,
        message: `${result.data.length} queue item(s) across all projects.`,
        data: { items: result.data },
      });
    }
  );

}

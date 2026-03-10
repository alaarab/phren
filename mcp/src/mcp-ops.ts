import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpContext, mcpResponse } from "./mcp-types.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { runtimeFile, getProjectDirs } from "./shared.js";
import { findFtsCacheForPath } from "./shared-index.js";
import { isValidProjectName } from "./utils.js";
import { approveQueueItem, rejectQueueItem, editQueueItem } from "./data-access.js";
import { addProjectFromPath } from "./core-project.js";
import { resolveRuntimeProfile } from "./runtime-profile.js";
import { getMachineName } from "./machine-identity.js";

import type { CortexResult } from "./shared.js";
import type { McpToolResult } from "./mcp-types.js";
import { getProjectConsolidationStatus, CONSOLIDATION_ENTRY_THRESHOLD } from "./content-validate.js";

/** Translate a CortexResult<string> into a standard McpToolResult shape. */
function cortexResultToMcp(result: CortexResult<string>): McpToolResult {
  if (result.ok) {
    return { ok: true, message: result.data };
  }
  return { ok: false, error: result.error, errorCode: result.code };
}

export function register(server: McpServer, ctx: McpContext): void {
  const { cortexPath, profile, updateFileInIndex, withWriteQueue } = ctx;

  // ── get_consolidation_status ───────────────────────────────────────────────

  server.registerTool(
    "add_project",
    {
      title: "◆ cortex · add project",
      description:
        "Bootstrap a project into cortex from a repo or working directory. " +
        "Copies or creates CLAUDE.md/summary/backlog/findings under ~/.cortex/<project> and adds the project to the active profile.",
      inputSchema: z.object({
        path: z.string().describe("Project path to import. Pass the current repo path explicitly."),
        profile: z.string().optional().describe("Profile to update. Defaults to the active profile."),
      }),
    },
    async ({ path: targetPath, profile: requestedProfile }) => {
      return withWriteQueue(async () => {
        try {
          const added = addProjectFromPath(cortexPath, targetPath, requestedProfile || profile || undefined);
          if (!added.ok) {
            return mcpResponse({
              ok: false,
              error: added.error,
            });
          }
          updateFileInIndex(added.data.files.claude);
          updateFileInIndex(added.data.files.summary);
          updateFileInIndex(added.data.files.findings);
          updateFileInIndex(added.data.files.backlog);
          return mcpResponse({
            ok: true,
            message: `Added project "${added.data.project}" from ${added.data.path}.`,
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
      title: "◆ cortex · consolidation status",
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
            const dir = path.join(cortexPath, project);
            return fs.existsSync(dir) ? [dir] : [];
          })()
        : getProjectDirs(cortexPath, profile);

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
      title: "◆ cortex · health",
      description:
        "Return cortex health status: version, FTS index status, hook registration, and profile/machine info.",
      inputSchema: z.object({}),
    },
    async () => {
      const activeProfile = (() => {
        try {
          return resolveRuntimeProfile(cortexPath);
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
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] healthCheck version: ${err instanceof Error ? err.message : String(err)}\n`);
      }

      // FTS index (lives in /tmp/cortex-fts-*/, not .runtime/)
      let indexStatus: { exists: boolean; sizeBytes?: number } = { exists: false };
      try {
        indexStatus = findFtsCacheForPath(cortexPath, activeProfile);
      } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] healthCheck ftsCacheCheck: ${err instanceof Error ? err.message : String(err)}\n`);
      }

      // Hook registration
      let hooksEnabled = false;
      try {
        const { getHooksEnabledPreference } = await import("./init-preferences.js");
        hooksEnabled = getHooksEnabledPreference(cortexPath);
      } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] healthCheck hooksEnabled: ${err instanceof Error ? err.message : String(err)}\n`);
      }

      let mcpEnabled = false;
      try {
        const { getMcpEnabledPreference } = await import("./init-preferences.js");
        mcpEnabled = getMcpEnabledPreference(cortexPath);
      } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] healthCheck mcpEnabled: ${err instanceof Error ? err.message : String(err)}\n`);
      }

      // Profile/machine info
      const machineName = (() => {
        try {
          return getMachineName();
        } catch (err: unknown) {
          if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] healthCheck machineName: ${err instanceof Error ? err.message : String(err)}\n`);
        }
        return undefined;
      })();

      const projectCount = getProjectDirs(cortexPath, activeProfile).length;

      const lines = [
        `Cortex v${version}`,
        `Profile: ${activeProfile || "(default)"}`,
        machineName ? `Machine: ${machineName}` : null,
        `Projects: ${projectCount}`,
        `FTS index: ${indexStatus.exists ? `ok (${Math.round((indexStatus.sizeBytes ?? 0) / 1024)} KB)` : "missing"}`,
        `MCP: ${mcpEnabled ? "enabled" : "disabled"}`,
        `Hooks: ${hooksEnabled ? "enabled" : "disabled"}`,
        `Path: ${cortexPath}`,
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
          cortexPath,
        },
      });
    }
  );

  // ── list_hook_errors ───────────────────────────────────────────────────────

  server.registerTool(
    "list_hook_errors",
    {
      title: "◆ cortex · hook errors",
      description:
        "List recent error entries from cortex hook-errors.log and debug.log. " +
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
          if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] readErrorLines: ${err instanceof Error ? err.message : String(err)}\n`);
          return [];
        }
      }

      // hook-errors.log contains only hook failure lines (no filtering needed)
      const hookErrors = readErrorLines(runtimeFile(cortexPath, "hook-errors.log"), false);
      // debug.log may contain non-error lines, so filter
      const debugErrors = readErrorLines(runtimeFile(cortexPath, "debug.log"), true);

      const allErrors = [...hookErrors, ...debugErrors];

      if (allErrors.length === 0) {
        return mcpResponse({
          ok: true,
          message: "No error entries found. Hook errors go to hook-errors.log; general errors require CORTEX_DEBUG=1.",
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

  // ── approve_queue_item ────────────────────────────────────────────────────

  server.registerTool(
    "approve_queue_item",
    {
      title: "◆ cortex · approve queue item",
      description:
        "Approve a queued memory item: moves it from the review queue into FINDINGS.md. " +
        "Requires queue + write permission. High-risk items additionally require maintainer role.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        item: z.string().describe("Partial text of the queue item to approve."),
      }),
    },
    async ({ project, item }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}".` });
      const result = approveQueueItem(cortexPath, project, item);
      if (result.ok) {
        // Approval writes to both FINDINGS.md and MEMORY_QUEUE.md — update both in index
        updateFileInIndex(path.join(cortexPath, project, "FINDINGS.md"));
        updateFileInIndex(path.join(cortexPath, project, "MEMORY_QUEUE.md"));
      }
      return mcpResponse(cortexResultToMcp(result));
    }
  );

  // ── reject_queue_item ─────────────────────────────────────────────────────

  server.registerTool(
    "reject_queue_item",
    {
      title: "◆ cortex · reject queue item",
      description:
        "Reject a queued memory item: removes it from the review queue without promoting to FINDINGS.md. " +
        "Requires queue permission.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        item: z.string().describe("Partial text of the queue item to reject."),
      }),
    },
    async ({ project, item }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}".` });
      const result = rejectQueueItem(cortexPath, project, item);
      if (result.ok) {
        updateFileInIndex(path.join(cortexPath, project, "MEMORY_QUEUE.md"));
      }
      return mcpResponse(cortexResultToMcp(result));
    }
  );

  // ── edit_queue_item ───────────────────────────────────────────────────────

  server.registerTool(
    "edit_queue_item",
    {
      title: "◆ cortex · edit queue item",
      description:
        "Edit the text of a queued memory item before approving or rejecting it. " +
        "Requires queue permission.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        item: z.string().describe("Partial text of the queue item to edit."),
        new_text: z.string().describe("Replacement text for the queue item."),
      }),
    },
    async ({ project, item, new_text }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}".` });
      const result = editQueueItem(cortexPath, project, item, new_text);
      if (result.ok) {
        updateFileInIndex(path.join(cortexPath, project, "MEMORY_QUEUE.md"));
      }
      return mcpResponse(cortexResultToMcp(result));
    }
  );
}

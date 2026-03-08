import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpContext, mcpResponse } from "./mcp-types.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { debugLog, runtimeDir, runtimeFile, getProjectDirs } from "./shared.js";
import { findFtsCacheForPath } from "./shared-index.js";
import { isValidProjectName } from "./utils.js";
import { approveQueueItem, rejectQueueItem, editQueueItem } from "./data-access.js";

import type { CortexResult } from "./shared.js";
import type { McpToolResult } from "./mcp-types.js";

/** Translate a CortexResult<string> into a standard McpToolResult shape. */
function cortexResultToMcp(result: CortexResult<string>): McpToolResult {
  if (result.ok) {
    return { ok: true, message: result.data };
  }
  return { ok: false, error: result.error, errorCode: result.code };
}

export function register(server: McpServer, ctx: McpContext): void {
  const { cortexPath, profile, updateFileInIndex } = ctx;

  // ── get_consolidation_status ───────────────────────────────────────────────

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
      const ENTRY_THRESHOLD = 25;
      const TIME_THRESHOLD_DAYS = 60;

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
        const findingsPath = path.join(dir, "FINDINGS.md");
        if (!fs.existsSync(findingsPath)) continue;

        const content = fs.readFileSync(findingsPath, "utf8");
        const lines = content.split("\n");

        const markerMatch = content.match(/<!--\s*consolidated:\s*(\d{4}-\d{2}-\d{2})/);
        const lastConsolidated = markerMatch ? markerMatch[1] : null;

        let startLine = 0;
        if (markerMatch) {
          startLine = lines.findIndex(l => /<!--\s*consolidated:/.test(l)) + 1;
        }

        let inDetails = false;
        let entriesSince = 0;
        for (let i = startLine; i < lines.length; i++) {
          if (lines[i].includes("<details>")) { inDetails = true; continue; }
          if (lines[i].includes("</details>")) { inDetails = false; continue; }
          if (!inDetails && lines[i].startsWith("- ")) entriesSince++;
        }

        let daysSince: number | null = null;
        if (lastConsolidated) {
          const ts = Date.parse(`${lastConsolidated}T00:00:00Z`);
          if (!isNaN(ts)) {
            daysSince = Math.floor((Date.now() - ts) / 86400000);
          }
        }

        const recommended =
          entriesSince >= ENTRY_THRESHOLD ||
          (daysSince !== null && daysSince >= TIME_THRESHOLD_DAYS && entriesSince >= 10) ||
          (lastConsolidated === null && entriesSince >= ENTRY_THRESHOLD);

        results.push({
          project: path.basename(dir),
          entriesSince,
          threshold: ENTRY_THRESHOLD,
          daysSince,
          lastConsolidated,
          recommended,
        });
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
      // Version
      let version = "unknown";
      try {
        const pkgPath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "package.json");
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        version = pkg.version || "unknown";
      } catch { /* best-effort */ }

      // FTS index (lives in /tmp/cortex-fts-*/, not .runtime/)
      let indexStatus: { exists: boolean; sizeBytes?: number } = { exists: false };
      try {
        indexStatus = findFtsCacheForPath(cortexPath, profile);
      } catch { /* best-effort */ }

      // Hook registration
      let hooksEnabled = false;
      try {
        const { getHooksEnabledPreference } = await import("./init-preferences.js");
        hooksEnabled = getHooksEnabledPreference(cortexPath);
      } catch { /* best-effort */ }

      let mcpEnabled = false;
      try {
        const { getMcpEnabledPreference } = await import("./init-preferences.js");
        mcpEnabled = getMcpEnabledPreference(cortexPath);
      } catch { /* best-effort */ }

      // Profile/machine info
      const activeProfile = profile || "(default)";
      const machineName = (() => {
        try {
          const machinesPath = path.join(cortexPath, "machines.yaml");
          if (fs.existsSync(machinesPath)) {
            const content = fs.readFileSync(machinesPath, "utf8");
            const hostnameMatch = content.match(new RegExp(`^\\s*(\\S+):`, "m"));
            return hostnameMatch ? hostnameMatch[1] : undefined;
          }
        } catch { /* best-effort */ }
        return undefined;
      })();

      const projectCount = getProjectDirs(cortexPath, profile).length;

      const lines = [
        `Cortex v${version}`,
        `Profile: ${activeProfile}`,
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
          profile: activeProfile,
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
        } catch { return []; }
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

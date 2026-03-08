import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpContext, mcpResponse } from "./mcp-types.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { debugLog, runtimeDir, runtimeFile, getProjectDirs } from "./shared.js";
import { isValidProjectName } from "./utils.js";

export function register(server: McpServer, ctx: McpContext): void {
  const { cortexPath, profile } = ctx;

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
          startLine = lines.findIndex(l => l.includes("consolidated:")) + 1;
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

      // FTS index
      let indexStatus: { exists: boolean; sizeBytes?: number } = { exists: false };
      try {
        const rtDir = runtimeDir(cortexPath);
        const indexPath = path.join(rtDir, "index.db");
        if (fs.existsSync(indexPath)) {
          const stat = fs.statSync(indexPath);
          indexStatus = { exists: true, sizeBytes: stat.size };
        }
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
        "List recent error entries from the cortex debug log. " +
        "Useful for diagnosing hook or index failures.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).optional()
          .describe("Max error entries to return (default 20)."),
      }),
    },
    async ({ limit }) => {
      const maxEntries = limit ?? 20;
      const logPath = runtimeFile(cortexPath, "debug.log");

      if (!fs.existsSync(logPath)) {
        return mcpResponse({
          ok: true,
          message: "No debug log found. Debug logging may not be enabled (set CORTEX_DEBUG=1).",
          data: { errors: [], total: 0 },
        });
      }

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

      try {
        const content = fs.readFileSync(logPath, "utf8");
        const allLines = content.split("\n").filter(l => l.trim());
        const errorLines = allLines.filter(line =>
          ERROR_PATTERNS.some(p => p.test(line))
        );

        const recent = errorLines.slice(-maxEntries);

        if (recent.length === 0) {
          return mcpResponse({
            ok: true,
            message: "No error entries found in debug log.",
            data: { errors: [], total: 0, logLines: allLines.length },
          });
        }

        return mcpResponse({
          ok: true,
          message: `Found ${errorLines.length} error(s), showing last ${recent.length}:\n\n${recent.join("\n")}`,
          data: { errors: recent, total: errorLines.length, logLines: allLines.length },
        });
      } catch (err: unknown) {
        return mcpResponse({
          ok: false,
          error: `Failed to read debug log: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  );
}

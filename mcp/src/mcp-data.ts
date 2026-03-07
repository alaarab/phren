import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext } from "./mcp-types.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { isValidProjectName } from "./utils.js";
import { readFindings, readBacklog } from "./data-access.js";

function jsonResponse(payload: { ok: boolean; data?: unknown; error?: string; message?: string }) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

export function register(server: McpServer, ctx: McpContext): void {
  const { cortexPath, withWriteQueue, rebuildIndex } = ctx;

  server.registerTool(
    "export_project",
    {
      title: "◆ cortex · export",
      description: "Export a project's data (findings, backlog, summary) as portable JSON for sharing or backup.",
      inputSchema: z.object({
        project: z.string().describe("Project name to export."),
      }),
    },
    async ({ project }) => {
      if (!isValidProjectName(project)) return jsonResponse({ ok: false, error: `Invalid project name: "${project}"` });
      const projectDir = path.join(cortexPath, project);
      if (!fs.existsSync(projectDir)) return jsonResponse({ ok: false, error: `Project "${project}" not found.` });

      const exported: Record<string, unknown> = { project, exportedAt: new Date().toISOString(), version: 1 };

      const summaryPath = path.join(projectDir, "summary.md");
      if (fs.existsSync(summaryPath)) exported.summary = fs.readFileSync(summaryPath, "utf8");

      const learningsResult = readFindings(cortexPath, project);
      if (learningsResult.ok) exported.learnings = learningsResult.data;

      const backlogResult = readBacklog(cortexPath, project);
      if (backlogResult.ok) exported.backlog = backlogResult.data.items;

      const claudePath = path.join(projectDir, "CLAUDE.md");
      if (fs.existsSync(claudePath)) exported.claudeMd = fs.readFileSync(claudePath, "utf8");

      return jsonResponse({ ok: true, message: `Exported project "${project}".`, data: exported });
    }
  );

  server.registerTool(
    "import_project",
    {
      title: "◆ cortex · import",
      description: "Import project data from a previously exported JSON payload. Creates the project directory if needed.",
      inputSchema: z.object({
        data: z.string().describe("JSON string from a previous export_project call."),
      }),
    },
    async ({ data: rawData }) => {
      return withWriteQueue(async () => {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(rawData) as Record<string, unknown>;
        } catch {
          return jsonResponse({ ok: false, error: "Invalid JSON input." });
        }

        if (!parsed.project || typeof parsed.project !== "string") {
          return jsonResponse({ ok: false, error: "Missing 'project' field in import data." });
        }
        if (!isValidProjectName(parsed.project)) {
          return jsonResponse({ ok: false, error: `Invalid project name: "${parsed.project}"` });
        }

        const projectDir = path.join(cortexPath, parsed.project);
        fs.mkdirSync(projectDir, { recursive: true });
        const imported: string[] = [];

        if (parsed.summary && typeof parsed.summary === "string") {
          fs.writeFileSync(path.join(projectDir, "summary.md"), parsed.summary);
          imported.push("summary.md");
        }

        if (parsed.claudeMd && typeof parsed.claudeMd === "string") {
          fs.writeFileSync(path.join(projectDir, "CLAUDE.md"), parsed.claudeMd);
          imported.push("CLAUDE.md");
        }

        if (Array.isArray(parsed.learnings) && parsed.learnings.length > 0) {
          const date = new Date().toISOString().slice(0, 10);
          const lines = [`# ${parsed.project} Findings`, "", `## ${date}`, ""];
          for (const item of parsed.learnings) {
            if (item && typeof item.text === "string") {
              lines.push(`- ${item.text}`);
            }
          }
          lines.push("");
          fs.writeFileSync(path.join(projectDir, "FINDINGS.md"), lines.join("\n"));
          imported.push("FINDINGS.md");
        }

        if (parsed.backlog && typeof parsed.backlog === "object") {
          const sections = ["Active", "Queue", "Done"] as const;
          const lines = [`# ${parsed.project} backlog`, ""];
          for (const section of sections) {
            lines.push(`## ${section}`, "");
            const items = (parsed.backlog as Record<string, unknown>)[section];
            if (Array.isArray(items)) {
              for (const item of items) {
                if (item && typeof item.line === "string") {
                  const prefix = item.checked || section === "Done" ? "- [x] " : "- [ ] ";
                  lines.push(`${prefix}${item.line}`);
                  if (item.context) lines.push(`  Context: ${item.context}`);
                }
              }
            }
            lines.push("");
          }
          fs.writeFileSync(path.join(projectDir, "backlog.md"), lines.join("\n"));
          imported.push("backlog.md");
        }

        await rebuildIndex();
        return jsonResponse({
          ok: true,
          message: `Imported project "${parsed.project}": ${imported.join(", ")}`,
          data: { project: parsed.project, files: imported },
        });
      });
    }
  );

  server.registerTool(
    "manage_project",
    {
      title: "◆ cortex · manage project",
      description: "Archive or unarchive a project. Archive moves it out of the active index without deleting data (renamed with .archived suffix). Unarchive restores it.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        action: z.enum(["archive", "unarchive"]).describe("Action to perform."),
      }),
    },
    async ({ project, action }) => {
      if (!isValidProjectName(project)) return jsonResponse({ ok: false, error: `Invalid project name: "${project}"` });
      const projectDir = path.join(cortexPath, project);
      const archiveDir = path.join(cortexPath, `${project}.archived`);

      if (action === "archive") {
        if (!fs.existsSync(projectDir)) {
          return jsonResponse({ ok: false, error: `Project "${project}" not found.` });
        }
        if (fs.existsSync(archiveDir)) {
          return jsonResponse({ ok: false, error: `Archive "${project}.archived" already exists. Unarchive or remove it first.` });
        }

        fs.renameSync(projectDir, archiveDir);
        await rebuildIndex();
        return jsonResponse({
          ok: true,
          message: `Archived project "${project}". Data preserved at ${archiveDir}.`,
          data: { project, archivePath: archiveDir },
        });
      }

      // unarchive
      if (fs.existsSync(projectDir)) {
        return jsonResponse({ ok: false, error: `Project "${project}" already exists as an active project.` });
      }
      if (!fs.existsSync(archiveDir)) {
        const entries = fs.readdirSync(cortexPath).filter((e) => e.endsWith(".archived"));
        const available = entries.map((e) => e.replace(/\.archived$/, ""));
        return jsonResponse({ ok: false, error: `No archive found for "${project}".`, data: { availableArchives: available } });
      }

      fs.renameSync(archiveDir, projectDir);
      await rebuildIndex();
      return jsonResponse({
        ok: true,
        message: `Unarchived project "${project}". It is now active again.`,
        data: { project, path: projectDir },
      });
    }
  );
}

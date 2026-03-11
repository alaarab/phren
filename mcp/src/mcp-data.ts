import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpContext, mcpResponse } from "./mcp-types.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { isValidProjectName } from "./utils.js";
import { readFindings, readTasks, resolveTaskFilePath, TASKS_FILENAME } from "./data-access.js";
import { debugLog, findProjectNameCaseInsensitive, normalizeProjectNameForCreate } from "./shared.js";



const importPayloadSchema = z.object({
  project: z.string(),
  overwrite: z.boolean().optional(),
  summary: z.string().optional(),
  claudeMd: z.string().optional(),
  taskRaw: z.string().optional(),
  learnings: z
    .array(
      z.object({
        text: z.string(),
      }).passthrough()
    )
    .optional(),
  task: z
    .object({
      Active: z.array(z.object({ line: z.string(), checked: z.boolean().optional(), context: z.string().optional(), priority: z.string().optional(), pinned: z.boolean().optional(), id: z.string().optional(), githubIssue: z.number().optional(), githubUrl: z.string().optional() }).passthrough()).optional(),
      Queue: z.array(z.object({ line: z.string(), checked: z.boolean().optional(), context: z.string().optional(), priority: z.string().optional(), pinned: z.boolean().optional(), id: z.string().optional(), githubIssue: z.number().optional(), githubUrl: z.string().optional() }).passthrough()).optional(),
      Done: z.array(z.object({ line: z.string(), checked: z.boolean().optional(), context: z.string().optional(), priority: z.string().optional(), pinned: z.boolean().optional(), id: z.string().optional(), githubIssue: z.number().optional(), githubUrl: z.string().optional() }).passthrough()).optional(),
    })
    .partial()
    .optional(),
}).passthrough();

export function register(server: McpServer, ctx: McpContext): void {
  const { cortexPath, withWriteQueue, rebuildIndex } = ctx;

  server.registerTool(
    "export_project",
    {
      title: "◆ cortex · export",
      description: "Export a project's data (findings, task, summary) as portable JSON for sharing or backup.",
      inputSchema: z.object({
        project: z.string().describe("Project name to export."),
      }),
    },
    async ({ project }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      const projectDir = path.join(cortexPath, project);
      if (!fs.existsSync(projectDir)) return mcpResponse({ ok: false, error: `Project "${project}" not found.` });

      const exported: Record<string, unknown> = { project, exportedAt: new Date().toISOString(), version: 1 };

      const summaryPath = path.join(projectDir, "summary.md");
      if (fs.existsSync(summaryPath)) exported.summary = fs.readFileSync(summaryPath, "utf8");

      const learningsResult = readFindings(cortexPath, project);
      if (learningsResult.ok) exported.learnings = learningsResult.data;
      const findingsPath = path.join(projectDir, "FINDINGS.md");
      if (fs.existsSync(findingsPath)) exported.findingsRaw = fs.readFileSync(findingsPath, "utf8");

      const taskResult = readTasks(cortexPath, project);
      if (taskResult.ok) {
        exported.task = taskResult.data.items;
        // Also export the raw task file string for lossless round-trip (preserves priority/pinned/stable IDs)
        const taskRawPath = resolveTaskFilePath(cortexPath, project);
        if (taskRawPath && fs.existsSync(taskRawPath)) exported.taskRaw = fs.readFileSync(taskRawPath, "utf8");
      }

      const claudePath = path.join(projectDir, "CLAUDE.md");
      if (fs.existsSync(claudePath)) exported.claudeMd = fs.readFileSync(claudePath, "utf8");

      return mcpResponse({ ok: true, message: `Exported project "${project}".`, data: exported });
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
        let decoded: unknown;
        try {
          decoded = JSON.parse(rawData);
        } catch (err: unknown) {
          if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] import_project jsonParse: ${err instanceof Error ? err.message : String(err)}\n`);
          return mcpResponse({ ok: false, error: "Invalid JSON input." });
        }

        const parsedResult = importPayloadSchema.safeParse(decoded);
        if (!parsedResult.success) {
          return mcpResponse({ ok: false, error: `Invalid import payload: ${parsedResult.error.issues[0]?.message ?? "schema validation failed"}` });
        }

        const parsed = parsedResult.data;

        // Warn about unknown fields silently discarded by .passthrough()
        const knownTopLevel = new Set(["project", "overwrite", "summary", "claudeMd", "learnings", "task", "exportedAt", "version", "findingsRaw"]);
        const unknownFields = Object.keys(decoded as Record<string, unknown>).filter(k => !knownTopLevel.has(k));
        if (unknownFields.length > 0) {
          debugLog(`import_project: unknown fields will be ignored: ${unknownFields.join(", ")}`);
        }

        const projectName = normalizeProjectNameForCreate(parsed.project);
        if (!isValidProjectName(projectName)) {
          return mcpResponse({ ok: false, error: `Invalid project name: "${parsed.project}"` });
        }

        const existingProject = findProjectNameCaseInsensitive(cortexPath, projectName);
        if (existingProject && existingProject !== projectName) {
          return mcpResponse({
            ok: false,
            error: `Project "${existingProject}" already exists with different casing. Refusing to import "${projectName}" because it would split the same project on case-sensitive filesystems.`,
          });
        }

        const projectDir = path.join(cortexPath, projectName);
        const overwrite = parsed.overwrite === true;
        if (fs.existsSync(projectDir) && !overwrite) {
          return mcpResponse({
            ok: false,
            error: `Project "${projectName}" already exists. Re-run with "overwrite": true to replace it.`,
          });
        }

        const stagingRoot = fs.mkdtempSync(path.join(cortexPath, `.cortex-import-${projectName}-`));
        const stagedProjectDir = path.join(stagingRoot, projectName);
        const imported: string[] = [];
        const cleanupDir = (dir: string) => {
          if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        };

        const buildFindingsContent = () => {
          if (!parsed.learnings || parsed.learnings.length === 0) return null;
          const date = new Date().toISOString().slice(0, 10);
          const lines = [`# ${projectName} Findings`, "", `## ${date}`, ""];
          for (const item of parsed.learnings) {
            lines.push(`- ${item.text}`);
          }
          lines.push("");
          return lines.join("\n");
        };

        const buildTaskContent = () => {
          // Prefer the raw task string (lossless: preserves priority/pinned/stable IDs)
          const taskRaw = (parsed as Record<string, unknown>).taskRaw;
          if (typeof taskRaw === "string") return taskRaw;
          if (!parsed.task) return null;
          const sections = ["Active", "Queue", "Done"] as const;
          const lines = [`# ${projectName} tasks`, ""];
          for (const section of sections) {
            lines.push(`## ${section}`, "");
            const items = parsed.task[section];
            if (items) {
              for (const item of items) {
                const prefix = item.checked || section === "Done" ? "- [x] " : "- [ ] ";
                const priorityTag = item.priority ? ` [${item.priority}]` : "";
                lines.push(`${prefix}${item.line}${priorityTag}`);
                if (item.context) lines.push(`  Context: ${item.context}`);
                if (item.githubIssue || item.githubUrl) {
                  const githubRef = item.githubIssue && item.githubUrl
                    ? `#${item.githubIssue} ${item.githubUrl}`
                    : item.githubIssue
                      ? `#${item.githubIssue}`
                      : item.githubUrl!;
                  lines.push(`  GitHub: ${githubRef}`);
                }
              }
            }
            lines.push("");
          }
          return lines.join("\n");
        };

        try {
          fs.mkdirSync(stagedProjectDir, { recursive: true });

          if (parsed.summary) {
            fs.writeFileSync(path.join(stagedProjectDir, "summary.md"), parsed.summary);
            imported.push("summary.md");
          }

          if (parsed.claudeMd) {
            fs.writeFileSync(path.join(stagedProjectDir, "CLAUDE.md"), parsed.claudeMd);
            imported.push("CLAUDE.md");
          }

          const findingsRaw = (parsed as Record<string, unknown>).findingsRaw;
          const findingsContent = typeof findingsRaw === "string" ? findingsRaw : buildFindingsContent();
          if (findingsContent) {
            fs.writeFileSync(path.join(stagedProjectDir, "FINDINGS.md"), findingsContent);
            imported.push("FINDINGS.md");
          }

          const taskContent = buildTaskContent();
          if (taskContent) {
            fs.writeFileSync(path.join(stagedProjectDir, TASKS_FILENAME), taskContent);
            imported.push(TASKS_FILENAME);
          }

          const backupDir = overwrite ? path.join(cortexPath, `${projectName}.import-backup-${Date.now()}`) : null;

          try {
            if (overwrite && fs.existsSync(projectDir)) {
              fs.renameSync(projectDir, backupDir!);
            }
            fs.renameSync(stagedProjectDir, projectDir);
            cleanupDir(stagingRoot);
          } catch (error) {
            if (backupDir && fs.existsSync(backupDir) && !fs.existsSync(projectDir)) {
              fs.renameSync(backupDir, projectDir);
            }
            cleanupDir(stagingRoot);
            return mcpResponse({
              ok: false,
              error: error instanceof Error ? `Failed to finalize import: ${error.message}` : "Failed to finalize import.",
              errorCode: "INTERNAL_ERROR",
            });
          }
        } catch (error) {
          cleanupDir(stagingRoot);
          return mcpResponse({
            ok: false,
            error: error instanceof Error ? `Failed to stage import: ${error.message}` : "Failed to stage import.",
            errorCode: "INTERNAL_ERROR",
          });
        }

        // Wrap rebuildIndex in a try/catch so that indexing failures trigger backup restore.
        try {
          await rebuildIndex();
        } catch (indexError) {
          // Index rebuild failed — restore backup if we replaced the project dir
          if (overwrite) {
            // Find the backup dir that was created earlier
            try {
              for (const entry of fs.readdirSync(cortexPath)) {
                if (entry.startsWith(`${projectName}.import-backup-`)) {
                  const backupPath = path.join(cortexPath, entry);
                  if (fs.existsSync(backupPath) && !fs.existsSync(projectDir)) {
                    fs.renameSync(backupPath, projectDir);
                  } else if (fs.existsSync(backupPath)) {
                    // Active dir exists — remove imported dir then restore backup
                    fs.rmSync(projectDir, { recursive: true, force: true });
                    fs.renameSync(backupPath, projectDir);
                  }
                  break;
                }
              }
            } catch (err: unknown) {
              if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] import_project backupRestore: ${err instanceof Error ? err.message : String(err)}\n`);
            }
          }
          return mcpResponse({
            ok: false,
            error: indexError instanceof Error ? `Index rebuild failed after import: ${indexError.message}` : "Index rebuild failed after import.",
            errorCode: "INTERNAL_ERROR",
          });
        }

        // Backup is only deleted after successful rebuild so we can restore on failure
        if (overwrite) {
          try {
            for (const entry of fs.readdirSync(cortexPath)) {
              if (entry.startsWith(`${projectName}.import-backup-`)) {
                fs.rmSync(path.join(cortexPath, entry), { recursive: true, force: true });
              }
            }
          } catch (err: unknown) {
            if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] import_project backupCleanup: ${err instanceof Error ? err.message : String(err)}\n`);
          }
        }
        return mcpResponse({
          ok: true,
          message: `Imported project "${projectName}": ${imported.join(", ")}`,
          data: { project: projectName, files: imported, overwrite },
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
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      return withWriteQueue(async () => {
      const activeProject = findProjectNameCaseInsensitive(cortexPath, project);
      const projectDir = path.join(cortexPath, project);
      const archiveDir = path.join(cortexPath, `${project}.archived`);

      if (action === "archive") {
        if (!fs.existsSync(projectDir)) {
          return mcpResponse({ ok: false, error: `Project "${project}" not found.` });
        }
        if (fs.existsSync(archiveDir)) {
          return mcpResponse({ ok: false, error: `Archive "${project}.archived" already exists. Unarchive or remove it first.` });
        }

        fs.renameSync(projectDir, archiveDir);
        await rebuildIndex();
        return mcpResponse({
          ok: true,
          message: `Archived project "${project}". Data preserved at ${archiveDir}.`,
          data: { project, archivePath: archiveDir },
        });
      }

      // unarchive
      if (activeProject) {
        return mcpResponse({ ok: false, error: `Project "${activeProject}" already exists as an active project.` });
      }
      if (!fs.existsSync(archiveDir)) {
        const entries = fs.readdirSync(cortexPath).filter((e) => e.endsWith(".archived"));
        const available = entries.map((e) => e.replace(/\.archived$/, ""));
        return mcpResponse({ ok: false, error: `No archive found for "${project}".`, data: { availableArchives: available } });
      }

      fs.renameSync(archiveDir, projectDir);
      await rebuildIndex();
      return mcpResponse({
        ok: true,
        message: `Unarchived project "${project}". It is now active again.`,
        data: { project, path: projectDir },
      });
      }); // end withWriteQueue
    }
  );
}

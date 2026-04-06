import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpContext, mcpResponse, resolveStoreForProject } from "./types.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { isValidProjectName, errorMessage, safeProjectPath } from "../utils.js";
import { readFindings, readTasks, resolveTaskFilePath, TASKS_FILENAME, FINDINGS_FILENAME } from "../data/access.js";
import { debugLog, findArchivedProjectNameCaseInsensitive, findProjectNameCaseInsensitive, normalizeProjectNameForCreate } from "../shared.js";
import { logger } from "../logger.js";



const importPayloadSchema = z.object({
  project: z.string(),
  overwrite: z.boolean().optional(),
  summary: z.string().optional(),
  claudeMd: z.string().optional(),
  taskRaw: z.string().optional(),
  findingsRaw: z.string().optional(),
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
  const { phrenPath, withWriteQueue, rebuildIndex } = ctx;

  server.registerTool(
    "export_project",
    {
      title: "◆ phren · export",
      description: "Export a project's data (findings, task, summary) as portable JSON for sharing or backup.",
      inputSchema: z.object({
        project: z.string().describe("Project name to export."),
      }),
    },
    async ({ project: projectInput }) => {
      // Resolve store-qualified project names (e.g. "qualus-shared/arc")
      let resolvedPhrenPath: string;
      let project: string;
      try {
        const resolved = resolveStoreForProject(ctx, projectInput);
        resolvedPhrenPath = resolved.phrenPath;
        project = resolved.project;
      } catch (err: unknown) {
        return mcpResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      const projectDir = safeProjectPath(resolvedPhrenPath, project);
      if (!projectDir || !fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
        return mcpResponse({ ok: false, error: `Project "${project}" not found.` });
      }

      const exported: Record<string, unknown> = { project, exportedAt: new Date().toISOString(), version: 1 };

      const summaryPath = safeProjectPath(projectDir, "summary.md");
      if (summaryPath && fs.existsSync(summaryPath)) exported.summary = fs.readFileSync(summaryPath, "utf8");

      const learningsResult = readFindings(resolvedPhrenPath, project);
      if (learningsResult.ok) exported.learnings = learningsResult.data;
      const findingsPath = safeProjectPath(projectDir, FINDINGS_FILENAME);
      if (findingsPath && fs.existsSync(findingsPath)) exported.findingsRaw = fs.readFileSync(findingsPath, "utf8");

      const taskResult = readTasks(resolvedPhrenPath, project);
      if (taskResult.ok) {
        exported.task = taskResult.data.items;
        const taskRawPath = resolveTaskFilePath(resolvedPhrenPath, project);
        if (taskRawPath && fs.existsSync(taskRawPath)) exported.taskRaw = fs.readFileSync(taskRawPath, "utf8");
      }

      const claudePath = safeProjectPath(projectDir, "CLAUDE.md");
      if (claudePath && fs.existsSync(claudePath)) exported.claudeMd = fs.readFileSync(claudePath, "utf8");

      return mcpResponse({ ok: true, message: `Exported project "${project}".`, data: exported });
    }
  );

  server.registerTool(
    "import_project",
    {
      title: "◆ phren · import",
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
          logger.debug("data", `import_project jsonParse: ${errorMessage(err)}`);
          return mcpResponse({ ok: false, error: "Invalid JSON input." });
        }

        const parsedResult = importPayloadSchema.safeParse(decoded);
        if (!parsedResult.success) {
          return mcpResponse({ ok: false, error: `Invalid import payload: ${parsedResult.error.issues[0]?.message ?? "schema validation failed"}` });
        }

        const parsed = parsedResult.data;

        // Warn about unknown fields silently discarded by .passthrough()
        const knownTopLevel = new Set(["project", "overwrite", "summary", "claudeMd", "learnings", "task", "taskRaw", "exportedAt", "version", "findingsRaw"]);
        const unknownFields = Object.keys(decoded as Record<string, unknown>).filter(k => !knownTopLevel.has(k));
        if (unknownFields.length > 0) {
          debugLog(`import_project: unknown fields will be ignored: ${unknownFields.join(", ")}`);
        }

        const projectName = normalizeProjectNameForCreate(parsed.project);
        if (!isValidProjectName(projectName)) {
          return mcpResponse({ ok: false, error: `Invalid project name: "${parsed.project}"` });
        }

        const existingProject = findProjectNameCaseInsensitive(phrenPath, projectName);
        if (existingProject && existingProject !== projectName) {
          return mcpResponse({
            ok: false,
            error: `Project "${existingProject}" already exists with different casing. Refusing to import "${projectName}" because it would split the same project on case-sensitive filesystems.`,
          });
        }

        const projectDir = safeProjectPath(phrenPath, projectName);
        if (!projectDir) {
          return mcpResponse({ ok: false, error: `Invalid project name: "${parsed.project}"` });
        }
        const overwrite = parsed.overwrite === true;
        if (fs.existsSync(projectDir) && !overwrite) {
          return mcpResponse({
            ok: false,
            error: `Project "${projectName}" already exists. Re-run with "overwrite": true to replace it.`,
          });
        }

        const stagingRoot = fs.mkdtempSync(path.join(phrenPath, `.phren-import-${projectName}-`));
        const stagedProjectDir = path.join(stagingRoot, projectName);
        const imported: string[] = [];
        let backupDir: string | null = null;
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
          if (typeof parsed.taskRaw === "string") return parsed.taskRaw;
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

          const findingsContent = typeof parsed.findingsRaw === "string" ? parsed.findingsRaw : buildFindingsContent();
          if (findingsContent) {
            fs.writeFileSync(path.join(stagedProjectDir, FINDINGS_FILENAME), findingsContent);
            imported.push(FINDINGS_FILENAME);
          }

          const taskContent = buildTaskContent();
          if (taskContent) {
            fs.writeFileSync(path.join(stagedProjectDir, TASKS_FILENAME), taskContent);
            imported.push(TASKS_FILENAME);
          }

          backupDir = overwrite ? path.join(phrenPath, `${projectName}.import-backup-${Date.now()}`) : null;

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
          if (!overwrite) {
            // Non-overwrite case: no backup to restore — remove the orphaned project dir
            try { fs.rmSync(projectDir, { recursive: true }); } catch { /* best-effort */ }
          } else if (backupDir) {
            try {
              if (fs.existsSync(backupDir) && !fs.existsSync(projectDir)) {
                fs.renameSync(backupDir, projectDir);
              } else if (fs.existsSync(backupDir)) {
                fs.rmSync(projectDir, { recursive: true, force: true });
                fs.renameSync(backupDir, projectDir);
              }
            } catch (err: unknown) {
              logger.debug("data", `import_project backupRestore: ${errorMessage(err)}`);
            }
          }
          return mcpResponse({
            ok: false,
            error: indexError instanceof Error ? `Index rebuild failed after import: ${indexError.message}` : "Index rebuild failed after import.",
            errorCode: "INTERNAL_ERROR",
          });
        }

        // Backup is only deleted after successful rebuild so we can restore on failure
        if (backupDir && fs.existsSync(backupDir)) {
          try {
            fs.rmSync(backupDir, { recursive: true, force: true });
          } catch (err: unknown) {
            logger.debug("data", `import_project backupCleanup: ${errorMessage(err)}`);
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
      title: "◆ phren · manage project",
      description: "Archive or unarchive a project. Archive moves it out of the active index without deleting data (renamed with .archived suffix). Unarchive restores it.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        action: z.enum(["archive", "unarchive"]).describe("Action to perform."),
      }),
    },
    async ({ project, action }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      const resolved = resolveStoreForProject(ctx, project);
      return withWriteQueue(async () => {
      const activeProject = findProjectNameCaseInsensitive(resolved.phrenPath, project);
      const archivedProject = findArchivedProjectNameCaseInsensitive(resolved.phrenPath, project);

      if (action === "archive") {
        if (!activeProject) {
          return mcpResponse({ ok: false, error: `Project "${project}" not found.` });
        }
        const projectDir = path.join(resolved.phrenPath, activeProject);
        const archiveDir = path.join(resolved.phrenPath, `${activeProject}.archived`);
        if (!fs.existsSync(projectDir)) {
          return mcpResponse({ ok: false, error: `Project "${project}" not found.` });
        }
        if (fs.existsSync(archiveDir)) {
          return mcpResponse({ ok: false, error: `Archive "${project}.archived" already exists. Unarchive or remove it first.` });
        }

        fs.renameSync(projectDir, archiveDir);
        try {
          await rebuildIndex();
        } catch (err: unknown) {
          fs.renameSync(archiveDir, projectDir);
          return mcpResponse({ ok: false, error: `Index rebuild failed after archive rename, rolled back: ${errorMessage(err)}` });
        }
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
      if (!archivedProject) {
        const entries = fs.readdirSync(resolved.phrenPath).filter((e) => e.endsWith(".archived"));
        const available = entries.map((e) => e.replace(/\.archived$/, ""));
        return mcpResponse({ ok: false, error: `No archive found for "${project}".`, data: { availableArchives: available } });
      }
      const projectDir = path.join(resolved.phrenPath, archivedProject);
      const archiveDir = path.join(resolved.phrenPath, `${archivedProject}.archived`);

      fs.renameSync(archiveDir, projectDir);
      try {
        await rebuildIndex();
      } catch (err: unknown) {
        fs.renameSync(projectDir, archiveDir);
        return mcpResponse({ ok: false, error: `Index rebuild failed after unarchive rename, rolled back: ${errorMessage(err)}` });
      }
      return mcpResponse({
        ok: true,
        message: `Unarchived project "${archivedProject}". It is now active again.`,
        data: { project: archivedProject, path: projectDir },
      });
      }); // end withWriteQueue
    }
  );
}

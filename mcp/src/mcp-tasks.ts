import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpContext, type RegisterOptions, type ToolTier, mcpResponse } from "./mcp-types.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { isValidProjectName } from "./utils.js";
import {
  addTask as addTaskStore,
  addTasks as addTasksBatch,
  taskMarkdown,
  type TaskDoc,
  type TaskItem,
  type TaskSection,
  completeTask as completeTaskStore,
  completeTasks as completeTasksBatch,
  removeTask as removeTaskStore,
  removeTasks as removeTasksBatch,
  linkTaskIssue,
  pinTask,
  workNextTask,
  tidyDoneTasks,
  readTasks,
  readTasksAcrossProjects,
  resolveTaskItem,
  TASKS_FILENAME,
  updateTask as updateTaskStore,
  promoteTask,
} from "./data-access.js";
import { applyGravity } from "./data-tasks.js";
import {
  buildTaskIssueBody,
  createGithubIssueForTask,
  parseGithubIssueUrl,
  resolveProjectGithubRepo,
} from "./tasks-github.js";
import { clearTaskCheckpoint } from "./session-checkpoints.js";
import { incrementSessionTasksCompleted } from "./mcp-session.js";
import { normalizeMemoryScope } from "./shared.js";
import { permissionDeniedError } from "./governance-rbac.js";

type TaskStatus = "all" | "active" | "queue" | "done" | "active+queue";

const TASK_SECTION_ORDER: TaskSection[] = ["Active", "Queue", "Done"];

const DEFAULT_TASK_LIMIT = 20;
/** Done items are historical — cap tightly by default to avoid large responses. */
const DEFAULT_DONE_LIMIT = 5;

function refreshTaskIndex(updateFileInIndex: (filePath: string) => void, phrenPath: string, project: string): void {
  updateFileInIndex(path.join(phrenPath, project, TASKS_FILENAME));
}

function buildTaskView(doc: TaskDoc, status?: TaskStatus, limit?: number, doneLimit?: number, offset?: number): { doc: TaskDoc; includedSections: TaskSection[]; totalItems: number; totalUnpaged: number; truncated: boolean } {
  let includedSections: TaskSection[];
  if (status === "all") {
    includedSections = TASK_SECTION_ORDER;
  } else if (status === "done") {
    includedSections = ["Done"];
  } else if (status === "active") {
    includedSections = ["Active"];
  } else if (status === "queue") {
    includedSections = ["Queue"];
  } else {
    includedSections = ["Active", "Queue"];
  }

  const effectiveLimit = limit ?? DEFAULT_TASK_LIMIT;
  const effectiveDoneLimit = doneLimit ?? DEFAULT_DONE_LIMIT;
  const effectiveOffset = offset ?? 0;
  let truncated = false;

  const items: Record<TaskSection, TaskDoc["items"][TaskSection]> = {
    Active: [],
    Queue: [],
    Done: [],
  };

  let totalUnpaged = 0;

  for (const section of includedSections) {
    // Apply gravity to Active and Queue items so stale tasks drift down
    const rawItems = doc.items[section];
    const sectionItems = (section === "Active" || section === "Queue") ? applyGravity(rawItems) : rawItems;
    const cap = section === "Done" ? effectiveDoneLimit : effectiveLimit;
    const sliced = effectiveOffset > 0 ? sectionItems.slice(effectiveOffset) : sectionItems;
    totalUnpaged += sectionItems.length;
    if (sliced.length > cap) {
      items[section] = sliced.slice(0, cap);
      truncated = true;
    } else {
      items[section] = sliced;
    }
  }

  const totalItems = TASK_SECTION_ORDER.reduce((sum, section) => sum + items[section].length, 0);

  return {
    doc: { ...doc, items },
    includedSections,
    totalItems,
    totalUnpaged,
    truncated,
  };
}

function buildTaskSummary(doc: TaskDoc, includedSections: TaskSection[]): string {
  const lines: string[] = [`## ${doc.project}`];
  for (const section of includedSections) {
    const items = doc.items[section];
      const highCount = items.filter(i => i.priority === "high").length;
      const medCount = items.filter(i => i.priority === "medium").length;
      lines.push(`**${section}**: ${items.length} items${highCount ? ` (${highCount} high` + (medCount ? `, ${medCount} medium` : "") + ")" : ""}`);
      // Show first 3 items as preview
      for (const item of items.slice(0, 3)) {
        const prio = item.priority ? ` [${item.priority}]` : "";
        const bidPrefix = item.stableId ? `bid:${item.stableId} ` : "";
        const githubTag = item.githubIssue ? ` [gh:#${item.githubIssue}]` : item.githubUrl ? " [gh]" : "";
        lines.push(`  - ${bidPrefix}${item.line.slice(0, 80)}${item.line.length > 80 ? "\u2026" : ""}${prio}${githubTag}`);
      }
    if (items.length > 3) lines.push(`  ... and ${items.length - 3} more`);
  }
  return lines.join("\n");
}

const TOOL_TIER: Record<string, ToolTier> = {
  get_tasks: "core",
  add_task: "core",
  complete_task: "core",
  remove_task: "core",
  work_next_task: "core",
  update_task: "advanced",
  link_task_issue: "advanced",
  promote_task_to_issue: "advanced",
  pin_task: "advanced",
  promote_task: "advanced",
  tidy_done_tasks: "advanced",
};

function shouldRegister(toolName: string, options?: RegisterOptions): boolean {
  if (!options?.tier) return true;
  return options.tier.has(TOOL_TIER[toolName] ?? "advanced");
}

export function register(server: McpServer, ctx: McpContext, options?: RegisterOptions): void {
  const { phrenPath, profile, withWriteQueue, updateFileInIndex } = ctx;

  if (shouldRegister("get_tasks", options)) server.registerTool(
    "get_tasks",
    {
      title: "◆ phren · tasks",
      description: "Get tasks. Defaults to Active and Queue sections only. Pass status='all' to include Done items.",
      inputSchema: z.object({
        project: z.string().optional().describe("Project name. Omit to get all projects."),
        id: z.string().optional().describe("Task ID like A1, Q3, D2. Requires project."),
        item: z.string().optional().describe("Exact task text. Requires project."),
        status: z.enum(["all", "active", "queue", "done", "active+queue"]).optional().describe("Which task sections to include. Defaults to 'active+queue'."),
        limit: z.number().int().min(1).max(200).optional().describe("Max items per Active/Queue section to return. Default 20."),
        done_limit: z.number().int().min(1).max(200).optional().describe("Max Done items to return (most recent). Default 5. Done sections are capped tightly to avoid large responses."),
        offset: z.number().int().min(0).optional().describe("Skip the first N items in each section before applying limit. Use with limit for pagination (e.g. offset:20, limit:20 for page 2)."),
        summary: z.boolean().optional().describe("If true, return counts and titles only (no full content). Reduces token usage."),
      }),
    },
    async ({ project, id, item, status, limit, done_limit, offset, summary }) => {
      // Single item lookup
      if (id || item) {
        if (!project) return mcpResponse({ ok: false, error: "Provide `project` when looking up a single item." });
        if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
        const result = readTasks(phrenPath, project);
        if (!result.ok) return mcpResponse({ ok: false, error: result.error });
        const doc = result.data;
        const all = [...doc.items.Active, ...doc.items.Queue, ...doc.items.Done];
        const bidLookup = id && id.startsWith("bid:") ? id.slice(4) : null;
        const match = all.find((entry) =>
          (bidLookup && entry.stableId === bidLookup) ||
          (id && !bidLookup && entry.id.toLowerCase() === id.toLowerCase()) ||
          (item && entry.line.trim() === item.trim())
        );
        if (!match) return mcpResponse({ ok: false, error: `No task found in ${project} for ${id ? `id=${id}` : `item="${item}"`}.` });
        return mcpResponse({
          ok: true,
          message: `${match.id}: ${match.line} (${match.section})`,
          data: {
            project,
            id: match.id,
            stableId: match.stableId || null,
            section: match.section,
            checked: match.checked,
            line: match.line,
            context: match.context || null,
            priority: match.priority || null,
            githubIssue: match.githubIssue ?? null,
            githubUrl: match.githubUrl || null,
          },
        });
      }

      // Full task list for one project
      if (project) {
        if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
        const result = readTasks(phrenPath, project);
        if (!result.ok) return mcpResponse({ ok: false, error: result.error });
        const doc = result.data;
        const view = buildTaskView(doc, status, limit, done_limit, offset);
        if (!fs.existsSync(doc.path)) {
          return mcpResponse({
            ok: true,
            message: `No tasks found for "${project}".`,
            data: { project, items: view.doc.items, includedSections: view.includedSections, totalItems: view.totalItems },
          });
        }
        if (summary) {
          return mcpResponse({
            ok: true,
            message: buildTaskSummary(view.doc, view.includedSections),
            data: { project, includedSections: view.includedSections, totalItems: view.totalItems, summary: true },
          });
        }
        const sectionCounts = view.includedSections
          .map((s) => `${s}: ${view.doc.items[s].length}/${doc.items[s].length}`)
          .join(", ");
        const paginationNote = view.truncated
          ? `\n\n_${sectionCounts} (offset ${offset ?? 0}). Use offset/limit to page._`
          : (offset ? `\n\n_Page offset: ${offset}. ${sectionCounts}._` : "");
        return mcpResponse({
          ok: true,
          message: `## ${project}\n${taskMarkdown(view.doc)}${paginationNote}`,
          data: { project, items: view.doc.items, issues: doc.issues, includedSections: view.includedSections, totalItems: view.totalItems, totalUnpaged: view.totalUnpaged, offset: offset ?? 0, truncated: view.truncated },
        });
      }

      // All projects
      const docs = readTasksAcrossProjects(phrenPath, profile);
      if (!docs.length) return mcpResponse({ ok: true, message: "No tasks found.", data: { projects: [] } });
      const views = docs.map((doc) => ({ project: doc.project, doc, view: buildTaskView(doc, status, limit, done_limit, offset), issues: doc.issues }));
      const anyTruncated = views.some(({ view }) => view.truncated);
      let parts: string[];
      if (summary) {
        parts = views.map(({ view }) => buildTaskSummary(view.doc, view.includedSections));
      } else {
        parts = views.map(({ project, view }) => `## ${project}\n${taskMarkdown(view.doc)}`);
      }
      const truncationNote = anyTruncated && !summary ? `\n\n_Results capped (Active/Queue: ${limit ?? DEFAULT_TASK_LIMIT}, Done: ${done_limit ?? DEFAULT_DONE_LIMIT}). Pass limit/done_limit to see more._` : "";
      const projectData = views.map(({ project, view, issues }) => ({
        project,
        items: view.doc.items,
        issues,
        includedSections: view.includedSections,
        totalItems: view.totalItems,
        truncated: view.truncated,
      }));
      return mcpResponse({ ok: true, message: parts.join("\n\n") + truncationNote, data: { projects: projectData, summary: summary || false } });
    }
  );

  if (shouldRegister("add_task", options)) server.registerTool(
    "add_task",
    {
      title: "◆ phren · add task",
      description: "Append one or more tasks to a project's tasks.md file. Adds to the Queue section. Pass a single string or an array of strings.",
      inputSchema: z.object({
        project: z.string().describe("Project name (must match a directory in your phren)."),
        item: z.union([
          z.string().describe("A single task to add."),
          z.array(z.string()).describe("Multiple tasks to add in one call."),
        ]).describe("The task(s) to add. Pass a string for one task, or an array for bulk."),
        scope: z.string().optional().describe("Optional memory scope label. Defaults to 'shared'. Example: 'researcher' or 'builder'."),
      }),
    },
    async ({ project, item, scope }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      const addTaskDenied = permissionDeniedError(phrenPath, "add_task", project);
      if (addTaskDenied) return mcpResponse({ ok: false, error: addTaskDenied });

      if (Array.isArray(item)) {
        return withWriteQueue(async () => {
          const result = addTasksBatch(phrenPath, project, item);
          if (!result.ok) return mcpResponse({ ok: false, error: result.error });
          const { added, errors } = result.data;
          if (added.length > 0) refreshTaskIndex(updateFileInIndex, phrenPath, project);
          return mcpResponse({ ok: added.length > 0, ...(added.length === 0 ? { error: `No tasks added: ${errors.join("; ")}` } : {}), message: `Added ${added.length} of ${item.length} tasks to ${project}`, data: { project, added, errors } });
        });
      }

      const normalizedScope = normalizeMemoryScope(scope ?? "shared");
      if (!normalizedScope) return mcpResponse({ ok: false, error: `Invalid scope: "${scope}". Use lowercase letters/numbers with '-' or '_' (max 64 chars), e.g. "researcher".` });
      return withWriteQueue(async () => {
        const result = addTaskStore(phrenPath, project, item, { scope: normalizedScope });
        if (!result.ok) return mcpResponse({ ok: false, error: result.error });
        refreshTaskIndex(updateFileInIndex, phrenPath, project);
        return mcpResponse({ ok: true, message: `Task added: ${result.data.line}`, data: { project, item, scope: normalizedScope } });
      });
    }
  );

  if (shouldRegister("complete_task", options)) server.registerTool(
    "complete_task",
    {
      title: "◆ phren · done",
      description: "Move one or more tasks to the Done section by matching text. Pass a single string or an array of strings.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        item: z.union([
          z.string().describe("Exact or partial text of the item to complete."),
          z.array(z.string()).describe("List of partial item texts to complete."),
        ]).describe("The task(s) to complete. Pass a string for one, or an array for bulk."),
        sessionId: z.string().optional().describe("Optional session ID from session_start. Pass this to track per-session task completion metrics."),
      }),
    },
    async ({ project, item, sessionId }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      const completeTaskDenied = permissionDeniedError(phrenPath, "complete_task", project);
      if (completeTaskDenied) return mcpResponse({ ok: false, error: completeTaskDenied });

      if (Array.isArray(item)) {
        return withWriteQueue(async () => {
          const resolvedItems = item
            .map((match) => {
              const resolved = resolveTaskItem(phrenPath, project, match);
              return resolved.ok ? resolved.data : null;
            })
            .filter((task): task is TaskItem => task !== null);
          const result = completeTasksBatch(phrenPath, project, item);
          if (!result.ok) return mcpResponse({ ok: false, error: result.error });
          const { completed, errors } = result.data;
          if (completed.length > 0) {
            const completedSet = new Set(completed);
            for (const task of resolvedItems) {
              if (!completedSet.has(task.line)) continue;
              clearTaskCheckpoint(phrenPath, {
                project,
                taskId: task.stableId ?? task.id,
                stableId: task.stableId,
                positionalId: task.id,
                taskLine: task.line,
              });
            }
            incrementSessionTasksCompleted(phrenPath, completed.length, sessionId, project);
          }
          if (completed.length > 0) refreshTaskIndex(updateFileInIndex, phrenPath, project);
          return mcpResponse({ ok: completed.length > 0, ...(completed.length === 0 ? { error: `No tasks completed: ${errors.join("; ")}` } : {}), message: `Completed ${completed.length}/${item.length} items`, data: { project, completed, errors } });
        });
      }

      return withWriteQueue(async () => {
        const before = resolveTaskItem(phrenPath, project, item);
        const result = completeTaskStore(phrenPath, project, item);
        if (!result.ok) return mcpResponse({ ok: false, error: result.error });
        if (before.ok) {
          clearTaskCheckpoint(phrenPath, {
            project,
            taskId: before.data.stableId ?? before.data.id,
            stableId: before.data.stableId,
            positionalId: before.data.id,
            taskLine: before.data.line,
          });
        }
        incrementSessionTasksCompleted(phrenPath, 1, sessionId, project);
        refreshTaskIndex(updateFileInIndex, phrenPath, project);
        return mcpResponse({ ok: true, message: result.data, data: { project, item } });
      });
    }
  );

  if (shouldRegister("remove_task", options)) server.registerTool(
    "remove_task",
    {
      title: "◆ phren · remove task",
      description: "Remove one or more tasks from a project's tasks.md file by matching text or ID. Pass a single string or an array of strings.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        item: z.union([
          z.string().describe("Exact or partial text of the task, or a task ID like A1/Q3/D2."),
          z.array(z.string()).describe("List of partial item texts or IDs to remove."),
        ]).describe("The task(s) to remove. Pass a string for one, or an array for bulk."),
      }),
    },
    async ({ project, item }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      const removeTaskDenied = permissionDeniedError(phrenPath, "remove_task", project);
      if (removeTaskDenied) return mcpResponse({ ok: false, error: removeTaskDenied });

      if (Array.isArray(item)) {
        return withWriteQueue(async () => {
          const result = removeTasksBatch(phrenPath, project, item);
          if (!result.ok) return mcpResponse({ ok: false, error: result.error });
          const { removed, errors } = result.data;
          if (removed.length > 0) refreshTaskIndex(updateFileInIndex, phrenPath, project);
          return mcpResponse({ ok: removed.length > 0, ...(removed.length === 0 ? { error: `No tasks removed: ${errors.join("; ")}` } : {}), message: `Removed ${removed.length}/${item.length} items`, data: { project, removed, errors } });
        });
      }

      return withWriteQueue(async () => {
        const result = removeTaskStore(phrenPath, project, item);
        if (!result.ok) return mcpResponse({ ok: false, error: result.error });
        refreshTaskIndex(updateFileInIndex, phrenPath, project);
        return mcpResponse({ ok: true, message: result.data, data: { project, item } });
      });
    }
  );

  if (shouldRegister("update_task", options)) server.registerTool(
    "update_task",
    {
      title: "◆ phren · update task",
      description: "Update a task's text, priority, context, section, or GitHub metadata by matching text.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        item: z.string().describe("Partial text to match against existing tasks."),
        updates: z.object({
          text: z.string().optional().describe("Replacement text for the task line."),
          priority: z.enum(["high", "medium", "low"]).optional().describe("New priority tag: high, medium, or low."),
          context: z.string().optional().describe("Text to set on the Context: line below the task."),
          replace_context: z.boolean().optional().describe("If true, replace the existing Context: value instead of appending."),
          section: z.enum(["queue", "active", "done", "Queue", "Active", "Done"]).optional().describe("Move item to this section: Queue, Active, or Done."),
          github_issue: z.union([z.number().int().positive(), z.string()]).optional().describe("GitHub issue number (for example 14 or '#14')."),
          github_url: z.string().optional().describe("GitHub issue URL to associate with the task item."),
          unlink_github: z.boolean().optional().describe("If true, remove any linked GitHub issue metadata from the item."),
        }).describe("Fields to update. All are optional."),
      }),
    },
    async ({ project, item, updates }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      const updateTaskDenied = permissionDeniedError(phrenPath, "update_task", project);
      if (updateTaskDenied) return mcpResponse({ ok: false, error: updateTaskDenied });
      return withWriteQueue(async () => {
        const result = updateTaskStore(phrenPath, project, item, updates);
        if (!result.ok) return mcpResponse({ ok: false, error: result.error });
        refreshTaskIndex(updateFileInIndex, phrenPath, project);
        return mcpResponse({ ok: true, message: result.data, data: { project, item, updates } });
      });
    }
  );

  if (shouldRegister("link_task_issue", options)) server.registerTool(
    "link_task_issue",
    {
      title: "◆ phren · link task issue",
      description: "Link or unlink a task to an existing GitHub issue.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        item: z.string().describe("Task text, ID, or stable bid to link."),
        issue_number: z.union([z.number().int().positive(), z.string()]).optional().describe("Existing GitHub issue number (for example 14 or '#14')."),
        issue_url: z.string().optional().describe("Existing GitHub issue URL."),
        unlink: z.boolean().optional().describe("If true, remove any linked issue from the task item."),
      }),
    },
    async ({ project, item, issue_number, issue_url, unlink }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      return withWriteQueue(async () => {
        if (unlink && (issue_number !== undefined || issue_url)) {
          return mcpResponse({ ok: false, error: "Use either unlink=true or issue_number/issue_url, not both." });
        }
        if (!unlink && issue_number === undefined && !issue_url) {
          return mcpResponse({ ok: false, error: "Provide issue_number or issue_url to link, or unlink=true to remove the link." });
        }
        if (issue_url) {
          const parsed = parseGithubIssueUrl(issue_url);
          if (!parsed) return mcpResponse({ ok: false, error: "issue_url must be a valid GitHub issue URL." });
          if (issue_number !== undefined) {
            const normalizedIssue = Number.parseInt(String(issue_number).replace(/^#/, ""), 10);
            if (normalizedIssue !== parsed.issueNumber) {
              return mcpResponse({ ok: false, error: "issue_number and issue_url refer to different issues." });
            }
          }
        }

        const result = linkTaskIssue(phrenPath, project, item, {
          github_issue: issue_number,
          github_url: issue_url,
          unlink: unlink ?? false,
        });
        if (!result.ok) return mcpResponse({ ok: false, error: result.error, errorCode: result.code });
        refreshTaskIndex(updateFileInIndex, phrenPath, project);
        return mcpResponse({
          ok: true,
          message: unlink
            ? `Removed GitHub link from ${project} task.`
            : `Linked ${project} task to ${result.data.githubIssue ? `#${result.data.githubIssue}` : result.data.githubUrl}.`,
          data: {
            project,
            item,
            stableId: result.data.stableId || null,
            githubIssue: result.data.githubIssue ?? null,
            githubUrl: result.data.githubUrl || null,
          },
        });
      });
    },
  );

  if (shouldRegister("promote_task_to_issue", options)) server.registerTool(
    "promote_task_to_issue",
    {
      title: "◆ phren · promote task",
      description: "Create a GitHub issue from a task and link it back into the task list.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        item: z.string().describe("Task text, ID, or stable bid to promote."),
        repo: z.string().optional().describe("Target GitHub repo in owner/name form. If omitted, phren tries to infer it from CLAUDE.md or summary.md."),
        title: z.string().optional().describe("Optional GitHub issue title. Defaults to the task text."),
        body: z.string().optional().describe("Optional GitHub issue body. Defaults to a body built from the task plus context."),
        mark_done: z.boolean().optional().describe("If true, mark the task Done after creating and linking the issue."),
      }),
    },
    async ({ project, item, repo, title, body, mark_done }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      return withWriteQueue(async () => {
        const match = resolveTaskItem(phrenPath, project, item);
        if (!match.ok) return mcpResponse({ ok: false, error: match.error, errorCode: match.code });

        const targetRepo = repo || resolveProjectGithubRepo(phrenPath, project);
        if (!targetRepo) {
          return mcpResponse({ ok: false, error: "Could not infer a GitHub repo for this project. Provide repo in owner/name form or add a GitHub URL to CLAUDE.md/summary.md." });
        }

        const created = createGithubIssueForTask({
          repo: targetRepo,
          title: title?.trim() || match.data.line.replace(/\s*\[(high|medium|low)\]\s*$/i, "").trim(),
          body: body?.trim() || buildTaskIssueBody(project, match.data),
        });
        if (!created.ok) return mcpResponse({ ok: false, error: created.error, errorCode: created.code });

        const linked = linkTaskIssue(phrenPath, project, match.data.stableId ? `bid:${match.data.stableId}` : match.data.id, {
          github_issue: created.data.issueNumber,
          github_url: created.data.url,
        });
        if (!linked.ok) return mcpResponse({ ok: false, error: linked.error, errorCode: linked.code });

        if (mark_done) {
          const completionMatch = linked.data.stableId ? `bid:${linked.data.stableId}` : linked.data.id;
          const completed = completeTaskStore(phrenPath, project, completionMatch);
          if (!completed.ok) return mcpResponse({ ok: false, error: completed.error, errorCode: completed.code });
          clearTaskCheckpoint(phrenPath, {
            project,
            taskId: match.data.stableId ?? match.data.id,
            stableId: match.data.stableId,
            positionalId: match.data.id,
            taskLine: match.data.line,
          });
        }

        refreshTaskIndex(updateFileInIndex, phrenPath, project);
        return mcpResponse({
          ok: true,
          message: `Created GitHub issue ${created.data.issueNumber ? `#${created.data.issueNumber}` : created.data.url} for ${project} task.`,
          data: {
            project,
            item,
            repo: targetRepo,
            githubIssue: created.data.issueNumber ?? null,
            githubUrl: created.data.url,
            markDone: mark_done ?? false,
          },
        });
      });
    },
  );

  if (shouldRegister("pin_task", options)) server.registerTool(
    "pin_task",
    {
      title: "◆ phren · pin task",
      description: "Pin a task so it floats to the top of its section.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        item: z.string().describe("Partial item text or ID to pin."),
      }),
    },
    async ({ project, item }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      return withWriteQueue(async () => {
        const result = pinTask(phrenPath, project, item);
        if (!result.ok) return mcpResponse({ ok: false, error: result.error });
        refreshTaskIndex(updateFileInIndex, phrenPath, project);
        return mcpResponse({ ok: true, message: result.data, data: { project, item } });
      });
    }
  );

  if (shouldRegister("work_next_task", options)) server.registerTool(
    "work_next_task",
    {
      title: "◆ phren · work next",
      description: "Move the highest-priority Queue item to Active so it becomes the next task to work on.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
      }),
    },
    async ({ project }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      return withWriteQueue(async () => {
        const result = workNextTask(phrenPath, project);
        if (!result.ok) return mcpResponse({ ok: false, error: result.error });
        refreshTaskIndex(updateFileInIndex, phrenPath, project);
        return mcpResponse({ ok: true, message: result.data, data: { project } });
      });
    }
  );

  if (shouldRegister("promote_task", options)) server.registerTool(
    "promote_task",
    {
      title: "◆ phren · promote task",
      description:
        "Promote a speculative task to committed by clearing the speculative flag. " +
        "Use this when the user says 'yes do it', 'let's work on that', or otherwise confirms " +
        "they want to commit to a suggested task. Optionally moves it to Active.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        item: z.string().describe("Partial text, stable ID (bid:XXXX), or positional ID of the speculative task."),
        move_to_active: z.boolean().optional().describe("If true, also move the task to the Active section. Default false."),
      }),
    },
    async ({ project, item, move_to_active }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      return withWriteQueue(async () => {
        const result = promoteTask(phrenPath, project, item, move_to_active ?? false);
        if (!result.ok) return mcpResponse({ ok: false, error: result.error });
        refreshTaskIndex(updateFileInIndex, phrenPath, project);
        return mcpResponse({
          ok: true,
          message: `Promoted task "${result.data.line}" in ${project}${move_to_active ? " (moved to Active)" : ""}.`,
          data: { project, item: result.data },
        });
      });
    }
  );

  if (shouldRegister("tidy_done_tasks", options)) server.registerTool(
    "tidy_done_tasks",
    {
      title: "◆ phren · tidy done",
      description: "Archive old Done items beyond the keep limit to keep the task list tidy.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        keep: z.number().optional().describe("Number of recent Done items to keep. Default 30."),
        dry_run: z.boolean().optional().describe("If true, preview changes without writing."),
      }),
    },
    async ({ project, keep, dry_run }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      return withWriteQueue(async () => {
        const result = tidyDoneTasks(phrenPath, project, keep ?? 30, dry_run ?? false);
        if (!result.ok) return mcpResponse({ ok: false, error: result.error });
        if (!dry_run) refreshTaskIndex(updateFileInIndex, phrenPath, project);
        return mcpResponse({ ok: true, message: result.data, data: { project, keep: keep ?? 30, dryRun: dry_run ?? false } });
      });
    }
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpContext, mcpResponse } from "./mcp-types.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { isValidProjectName } from "./utils.js";
import {
  addBacklogItem as addBacklogItemStore,
  addBacklogItems as addBacklogItemsBatch,
  backlogMarkdown,
  type BacklogDoc,
  type BacklogSection,
  completeBacklogItem as completeBacklogItemStore,
  completeBacklogItems as completeBacklogItemsBatch,
  readBacklog,
  readBacklogs,
  updateBacklogItem as updateBacklogItemStore,
} from "./data-access.js";

type BacklogStatus = "all" | "active" | "queue" | "done" | "active+queue";

const BACKLOG_SECTION_ORDER: BacklogSection[] = ["Active", "Queue", "Done"];

function buildBacklogView(doc: BacklogDoc, status?: BacklogStatus): { doc: BacklogDoc; includedSections: BacklogSection[]; totalItems: number } {
  let includedSections: BacklogSection[];
  if (status === "all") {
    includedSections = BACKLOG_SECTION_ORDER;
  } else if (status === "done") {
    includedSections = ["Done"];
  } else if (status === "active") {
    includedSections = ["Active"];
  } else if (status === "queue") {
    includedSections = ["Queue"];
  } else {
    includedSections = ["Active", "Queue"];
  }

  const items: Record<BacklogSection, BacklogDoc["items"][BacklogSection]> = {
    Active: includedSections.includes("Active") ? doc.items.Active : [],
    Queue: includedSections.includes("Queue") ? doc.items.Queue : [],
    Done: includedSections.includes("Done") ? doc.items.Done : [],
  };

  const totalItems = BACKLOG_SECTION_ORDER.reduce((sum, section) => sum + items[section].length, 0);

  return {
    doc: {
      ...doc,
      items,
    },
    includedSections,
    totalItems,
  };
}

export function register(server: McpServer, ctx: McpContext): void {
  const { cortexPath, profile, withWriteQueue, updateFileInIndex } = ctx;

  server.registerTool(
    "get_backlog",
    {
      title: "◆ cortex · backlog",
      description: "Get backlog items. Defaults to Active and Queue sections only. Pass status='all' to include Done items.",
      inputSchema: z.object({
        project: z.string().optional().describe("Project name. Omit to get all projects."),
        id: z.string().optional().describe("Backlog item ID like A1, Q3, D2. Requires project."),
        item: z.string().optional().describe("Exact backlog item text. Requires project."),
        status: z.enum(["all", "active", "queue", "done", "active+queue"]).optional().describe("Which backlog sections to include. Defaults to 'active+queue'."),
      }),
    },
    async ({ project, id, item, status }) => {
      // Single item lookup
      if (id || item) {
        if (!project) return mcpResponse({ ok: false, error: "Provide `project` when looking up a single item." });
        if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
        const result = readBacklog(cortexPath, project);
        if (!result.ok) return mcpResponse({ ok: false, error: result.error });
        const doc = result.data;
        const all = [...doc.items.Active, ...doc.items.Queue, ...doc.items.Done];
        const match = all.find((entry) =>
          (id && entry.id.toLowerCase() === id.toLowerCase()) ||
          (item && entry.line.trim() === item.trim())
        );
        if (!match) return mcpResponse({ ok: false, error: `No backlog item found in ${project} for ${id ? `id=${id}` : `item="${item}"`}.` });
        return mcpResponse({
          ok: true,
          message: `${match.id}: ${match.line} (${match.section})`,
          data: { project, id: match.id, section: match.section, checked: match.checked, line: match.line, context: match.context || null, priority: match.priority || null },
        });
      }

      // Full backlog for one project
      if (project) {
        if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
        const result = readBacklog(cortexPath, project);
        if (!result.ok) return mcpResponse({ ok: false, error: result.error });
        const doc = result.data;
        const view = buildBacklogView(doc, status);
        if (!fs.existsSync(doc.path)) {
          return mcpResponse({
            ok: true,
            message: `No backlog found for "${project}".`,
            data: { project, items: view.doc.items, includedSections: view.includedSections, totalItems: view.totalItems },
          });
        }
        return mcpResponse({
          ok: true,
          message: `## ${project}\n${backlogMarkdown(view.doc)}`,
          data: { project, items: view.doc.items, issues: doc.issues, includedSections: view.includedSections, totalItems: view.totalItems },
        });
      }

      // All projects
      const docs = readBacklogs(cortexPath, profile);
      if (!docs.length) return mcpResponse({ ok: true, message: "No backlogs found.", data: { projects: [] } });
      const views = docs.map((doc) => ({ project: doc.project, view: buildBacklogView(doc, status), issues: doc.issues }));
      const parts = views.map(({ project, view }) => `## ${project}\n${backlogMarkdown(view.doc)}`);
      const projectData = views.map(({ project, view, issues }) => ({
        project,
        items: view.doc.items,
        issues,
        includedSections: view.includedSections,
        totalItems: view.totalItems,
      }));
      return mcpResponse({ ok: true, message: parts.join("\n\n"), data: { projects: projectData } });
    }
  );

  server.registerTool(
    "add_backlog_item",
    {
      title: "◆ cortex · add task",
      description: "Append a task to a project's backlog.md. Adds to the Queue section.",
      inputSchema: z.object({
        project: z.string().describe("Project name (must match a directory in your cortex)."),
        item: z.string().describe("The task to add."),
      }),
    },
    async ({ project, item }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      return withWriteQueue(async () => {
        const result = addBacklogItemStore(cortexPath, project, item);
        if (!result.ok) return mcpResponse({ ok: false, error: result.error });
        updateFileInIndex(path.join(cortexPath, project, "BACKLOG.md"));
        return mcpResponse({ ok: true, message: result.data, data: { project, item } });
      });
    }
  );

  server.registerTool(
    "add_backlog_items",
    {
      title: "◆ cortex · add tasks (bulk)",
      description: "Append multiple tasks to a project's backlog.md in one call. Adds to the Queue section.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        items: z.array(z.string()).describe("List of tasks to add."),
      }),
    },
    async ({ project, items }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      return withWriteQueue(async () => {
        const result = addBacklogItemsBatch(cortexPath, project, items);
        if (!result.ok) return mcpResponse({ ok: false, error: result.error });
        const { added, errors } = result.data;
        if (added.length > 0) updateFileInIndex(path.join(cortexPath, project, "BACKLOG.md"));
        return mcpResponse({ ok: added.length > 0, message: `Added ${added.length} of ${items.length} items to ${project} backlog`, data: { project, added, errors } });
      });
    }
  );

  server.registerTool(
    "complete_backlog_item",
    {
      title: "◆ cortex · done",
      description: "Move a backlog item to the Done section by matching text.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        item: z.string().describe("Exact or partial text of the item to complete."),
      }),
    },
    async ({ project, item }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      return withWriteQueue(async () => {
        const result = completeBacklogItemStore(cortexPath, project, item);
        if (!result.ok) return mcpResponse({ ok: false, error: result.error });
        updateFileInIndex(path.join(cortexPath, project, "BACKLOG.md"));
        return mcpResponse({ ok: true, message: result.data, data: { project, item } });
      });
    }
  );

  server.registerTool(
    "complete_backlog_items",
    {
      title: "◆ cortex · done (bulk)",
      description: "Move multiple backlog items to Done in one call. Pass an array of partial item texts.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        items: z.array(z.string()).describe("List of partial item texts to complete."),
      }),
    },
    async ({ project, items }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      return withWriteQueue(async () => {
        const result = completeBacklogItemsBatch(cortexPath, project, items);
        if (!result.ok) return mcpResponse({ ok: false, error: result.error });
        const { completed, errors } = result.data;
        if (completed.length > 0) updateFileInIndex(path.join(cortexPath, project, "BACKLOG.md"));
        return mcpResponse({ ok: completed.length > 0, message: `Completed ${completed.length}/${items.length} items`, data: { project, completed, errors } });
      });
    }
  );

  server.registerTool(
    "update_backlog_item",
    {
      title: "◆ cortex · update task",
      description: "Update a backlog item's priority, context, or section by matching text.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        item: z.string().describe("Partial text to match against existing backlog items."),
        updates: z.object({
          priority: z.enum(["high", "medium", "low"]).optional().describe("New priority tag: high, medium, or low."),
          context: z.string().optional().describe("Text to append to (or create) the Context: line below the item."),
          section: z.enum(["queue", "active", "done", "Queue", "Active", "Done"]).optional().describe("Move item to this section: Queue, Active, or Done."),
        }).describe("Fields to update. All are optional."),
      }),
    },
    async ({ project, item, updates }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      return withWriteQueue(async () => {
        const result = updateBacklogItemStore(cortexPath, project, item, updates);
        if (!result.ok) return mcpResponse({ ok: false, error: result.error });
        updateFileInIndex(path.join(cortexPath, project, "BACKLOG.md"));
        return mcpResponse({ ok: true, message: result.data, data: { project, item, updates } });
      });
    }
  );
}

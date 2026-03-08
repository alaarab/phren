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
  pinBacklogItem,
  unpinBacklogItem,
  workNextBacklogItem,
  tidyBacklogDone,
  readBacklog,
  readBacklogs,
  updateBacklogItem as updateBacklogItemStore,
} from "./data-access.js";

type BacklogStatus = "all" | "active" | "queue" | "done" | "active+queue";

const BACKLOG_SECTION_ORDER: BacklogSection[] = ["Active", "Queue", "Done"];

const DEFAULT_BACKLOG_LIMIT = 20;
/** Done items are historical — cap tightly by default to avoid large responses. */
const DEFAULT_DONE_LIMIT = 5;

function buildBacklogView(doc: BacklogDoc, status?: BacklogStatus, limit?: number, doneLimit?: number, offset?: number): { doc: BacklogDoc; includedSections: BacklogSection[]; totalItems: number; totalUnpaged: number; truncated: boolean } {
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

  const effectiveLimit = limit ?? DEFAULT_BACKLOG_LIMIT;
  const effectiveDoneLimit = doneLimit ?? DEFAULT_DONE_LIMIT;
  const effectiveOffset = offset ?? 0;
  let truncated = false;

  const items: Record<BacklogSection, BacklogDoc["items"][BacklogSection]> = {
    Active: [],
    Queue: [],
    Done: [],
  };

  let totalUnpaged = 0;

  for (const section of includedSections) {
    const sectionItems = doc.items[section];
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

  const totalItems = BACKLOG_SECTION_ORDER.reduce((sum, section) => sum + items[section].length, 0);

  return {
    doc: { ...doc, items },
    includedSections,
    totalItems,
    totalUnpaged,
    truncated,
  };
}

function buildBacklogSummary(doc: BacklogDoc, includedSections: BacklogSection[]): string {
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
      lines.push(`  - ${bidPrefix}${item.line.slice(0, 80)}${item.line.length > 80 ? "\u2026" : ""}${prio}`);
    }
    if (items.length > 3) lines.push(`  ... and ${items.length - 3} more`);
  }
  return lines.join("\n");
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
        const result = readBacklog(cortexPath, project);
        if (!result.ok) return mcpResponse({ ok: false, error: result.error });
        const doc = result.data;
        const all = [...doc.items.Active, ...doc.items.Queue, ...doc.items.Done];
        const bidLookup = id && id.startsWith("bid:") ? id.slice(4) : null;
        const match = all.find((entry) =>
          (bidLookup && entry.stableId === bidLookup) ||
          (id && !bidLookup && entry.id.toLowerCase() === id.toLowerCase()) ||
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
        const view = buildBacklogView(doc, status, limit, done_limit, offset);
        if (!fs.existsSync(doc.path)) {
          return mcpResponse({
            ok: true,
            message: `No backlog found for "${project}".`,
            data: { project, items: view.doc.items, includedSections: view.includedSections, totalItems: view.totalItems },
          });
        }
        if (summary) {
          return mcpResponse({
            ok: true,
            message: buildBacklogSummary(view.doc, view.includedSections),
            data: { project, includedSections: view.includedSections, totalItems: view.totalItems, summary: true },
          });
        }
        const paginationNote = view.truncated
          ? `\n\n_Showing ${offset ?? 0}–${(offset ?? 0) + view.totalItems} of ${view.totalUnpaged} items. Use offset/limit to page._`
          : (offset ? `\n\n_Page offset: ${offset}. ${view.totalItems} items returned._` : "");
        return mcpResponse({
          ok: true,
          message: `## ${project}\n${backlogMarkdown(view.doc)}${paginationNote}`,
          data: { project, items: view.doc.items, issues: doc.issues, includedSections: view.includedSections, totalItems: view.totalItems, totalUnpaged: view.totalUnpaged, offset: offset ?? 0, truncated: view.truncated },
        });
      }

      // All projects
      const docs = readBacklogs(cortexPath, profile);
      if (!docs.length) return mcpResponse({ ok: true, message: "No backlogs found.", data: { projects: [] } });
      const views = docs.map((doc) => ({ project: doc.project, doc, view: buildBacklogView(doc, status, limit, done_limit, offset), issues: doc.issues }));
      const anyTruncated = views.some(({ view }) => view.truncated);
      let parts: string[];
      if (summary) {
        parts = views.map(({ view }) => buildBacklogSummary(view.doc, view.includedSections));
      } else {
        parts = views.map(({ project, view }) => `## ${project}\n${backlogMarkdown(view.doc)}`);
      }
      const truncationNote = anyTruncated && !summary ? `\n\n_Results capped (Active/Queue: ${limit ?? DEFAULT_BACKLOG_LIMIT}, Done: ${done_limit ?? DEFAULT_DONE_LIMIT}). Pass limit/done_limit to see more._` : "";
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
        updateFileInIndex(path.join(cortexPath, project, "backlog.md"));
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
        if (added.length > 0) updateFileInIndex(path.join(cortexPath, project, "backlog.md"));
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
        updateFileInIndex(path.join(cortexPath, project, "backlog.md"));
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
        if (completed.length > 0) updateFileInIndex(path.join(cortexPath, project, "backlog.md"));
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
        updateFileInIndex(path.join(cortexPath, project, "backlog.md"));
        return mcpResponse({ ok: true, message: result.data, data: { project, item, updates } });
      });
    }
  );

  server.registerTool(
    "pin_backlog_item",
    {
      title: "◆ cortex · pin task",
      description: "Pin a backlog item so it floats to the top of its section.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        item: z.string().describe("Partial item text or ID to pin."),
      }),
    },
    async ({ project, item }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      return withWriteQueue(async () => {
        const result = pinBacklogItem(cortexPath, project, item);
        if (!result.ok) return mcpResponse({ ok: false, error: result.error });
        updateFileInIndex(path.join(cortexPath, project, "backlog.md"));
        return mcpResponse({ ok: true, message: result.data, data: { project, item } });
      });
    }
  );

  server.registerTool(
    "work_next_backlog_item",
    {
      title: "◆ cortex · work next",
      description: "Move the highest-priority Queue item to Active so it becomes the next task to work on.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
      }),
    },
    async ({ project }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      return withWriteQueue(async () => {
        const result = workNextBacklogItem(cortexPath, project);
        if (!result.ok) return mcpResponse({ ok: false, error: result.error });
        updateFileInIndex(path.join(cortexPath, project, "backlog.md"));
        return mcpResponse({ ok: true, message: result.data, data: { project } });
      });
    }
  );

  server.registerTool(
    "tidy_backlog_done",
    {
      title: "◆ cortex · tidy done",
      description: "Archive old Done items beyond the keep limit to keep the backlog tidy.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        keep: z.number().optional().describe("Number of recent Done items to keep. Default 30."),
        dry_run: z.boolean().optional().describe("If true, preview changes without writing."),
      }),
    },
    async ({ project, keep, dry_run }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      return withWriteQueue(async () => {
        const result = tidyBacklogDone(cortexPath, project, keep ?? 30, dry_run ?? false);
        if (!result.ok) return mcpResponse({ ok: false, error: result.error });
        if (!dry_run) updateFileInIndex(path.join(cortexPath, project, "backlog.md"));
        return mcpResponse({ ok: true, message: result.data, data: { project, keep: keep ?? 30, dryRun: dry_run ?? false } });
      });
    }
  );
}

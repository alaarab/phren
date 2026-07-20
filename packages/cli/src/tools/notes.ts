import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as path from "path";
import { FINDING_TYPES } from "../shared.js";
import { FINDINGS_FILENAME } from "../data/access.js";
import { addNote, editNote, listNotes, removeNote, type NoteItem } from "../data/notes.js";
import { promoteNote } from "../core/note.js";
import { permissionDeniedError } from "../governance/rbac.js";
import { mcpResponse, resolveStoreForProject, type McpContext } from "./types.js";

function resolve(ctx: McpContext, projectInput: string) {
  try {
    return { ok: true as const, value: resolveStoreForProject(ctx, projectInput) };
  } catch (err: unknown) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
  }
}

function noteSummary(note: NoteItem): string {
  const promoted = note.promoted ? " · promoted" : "";
  return `- ${note.date} ${note.time.slice(0, 5)} · ${note.id}${promoted}\n  ${note.text.replace(/\n/g, "\n  ")}`;
}

async function refreshIndex(ctx: McpContext, storeRole: string, ...files: string[]): Promise<void> {
  if (storeRole === "primary") {
    for (const file of files) ctx.updateFileInIndex(file);
    return;
  }
  // Incremental indexing is rooted at the primary store. A federated/team-store
  // write therefore needs a rebuild so the file retains its real project/store identity.
  await ctx.rebuildIndex();
}

export function register(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    "get_notes",
    {
      title: "◆ phren · notes",
      description: "List lightweight daily notes for a project. Notes are searchable scratch context and are not injected into agent prompts automatically.",
      inputSchema: z.object({
        project: z.string().describe("Project name, optionally store-qualified (for example team/project)."),
        date: z.string().optional().describe("Optional YYYY-MM-DD date filter."),
        limit: z.number().int().min(1).max(500).optional().describe("Maximum notes to return. Defaults to 100."),
      }),
    },
    async ({ project: projectInput, date, limit }) => {
      const target = resolve(ctx, projectInput);
      if (!target.ok) return mcpResponse({ ok: false, error: target.error });
      const { phrenPath, project } = target.value;
      const result = listNotes(phrenPath, project, { date, limit: limit ?? 100 });
      if (!result.ok) return mcpResponse({ ok: false, error: result.error, errorCode: result.code });
      return mcpResponse({
        ok: true,
        message: result.data.length ? result.data.map(noteSummary).join("\n\n") : `No notes found for ${project}${date ? ` on ${date}` : ""}.`,
        data: { project, notes: result.data },
      });
    },
  );

  server.registerTool(
    "add_note",
    {
      title: "◆ phren · add note",
      description: "Add a lightweight Markdown note to a project's daily notes. Use findings instead for durable, agent-curated knowledge.",
      inputSchema: z.object({
        project: z.string().describe("Project name, optionally store-qualified."),
        text: z.string().min(1).describe("Note text; Markdown and multiple lines are supported."),
        date: z.string().optional().describe("Optional YYYY-MM-DD date. Defaults to today."),
      }),
    },
    async ({ project: projectInput, text, date }) => {
      const target = resolve(ctx, projectInput);
      if (!target.ok) return mcpResponse({ ok: false, error: target.error });
      const { phrenPath, project, storeRole } = target.value;
      const denied = permissionDeniedError(phrenPath, "add_note", project);
      if (denied) return mcpResponse({ ok: false, error: denied });
      return ctx.withWriteQueue(async () => {
        const result = addNote(phrenPath, project, text, { date });
        if (!result.ok) return mcpResponse({ ok: false, error: result.error, errorCode: result.code });
        await refreshIndex(ctx, storeRole, result.data.path);
        return mcpResponse({ ok: true, message: `Note added to ${project}: ${result.data.id}`, data: { project, note: result.data } });
      });
    },
  );

  server.registerTool(
    "edit_note",
    {
      title: "◆ phren · edit note",
      description: "Replace the text of one daily note. Identify it with the stable nid returned by get_notes.",
      inputSchema: z.object({
        project: z.string(),
        note: z.string().min(1).describe("Stable nid (preferred) or an unambiguous text match."),
        text: z.string().min(1).describe("Replacement Markdown text."),
      }),
    },
    async ({ project: projectInput, note, text }) => {
      const target = resolve(ctx, projectInput);
      if (!target.ok) return mcpResponse({ ok: false, error: target.error });
      const { phrenPath, project, storeRole } = target.value;
      const denied = permissionDeniedError(phrenPath, "edit_note", project);
      if (denied) return mcpResponse({ ok: false, error: denied });
      return ctx.withWriteQueue(async () => {
        const result = editNote(phrenPath, project, note, text);
        if (!result.ok) return mcpResponse({ ok: false, error: result.error, errorCode: result.code });
        await refreshIndex(ctx, storeRole, result.data.path);
        return mcpResponse({ ok: true, message: `Updated ${result.data.id}.`, data: { project, note: result.data } });
      });
    },
  );

  server.registerTool(
    "remove_note",
    {
      title: "◆ phren · remove note",
      description: "Remove one daily note by stable nid or unambiguous text match.",
      inputSchema: z.object({ project: z.string(), note: z.string().min(1) }),
    },
    async ({ project: projectInput, note }) => {
      const target = resolve(ctx, projectInput);
      if (!target.ok) return mcpResponse({ ok: false, error: target.error });
      const { phrenPath, project, storeRole } = target.value;
      const denied = permissionDeniedError(phrenPath, "remove_note", project);
      if (denied) return mcpResponse({ ok: false, error: denied });
      return ctx.withWriteQueue(async () => {
        const result = removeNote(phrenPath, project, note);
        if (!result.ok) return mcpResponse({ ok: false, error: result.error, errorCode: result.code });
        await refreshIndex(ctx, storeRole, result.data.path);
        return mcpResponse({ ok: true, message: `Removed ${result.data.id}.`, data: { project, note: result.data } });
      });
    },
  );

  server.registerTool(
    "promote_note",
    {
      title: "◆ phren · promote note",
      description: "Copy a daily note into durable findings and mark the source note as promoted. The note remains in the daily record.",
      inputSchema: z.object({
        project: z.string(),
        note: z.string().min(1),
        findingType: z.enum(FINDING_TYPES).optional(),
      }),
    },
    async ({ project: projectInput, note, findingType }) => {
      const target = resolve(ctx, projectInput);
      if (!target.ok) return mcpResponse({ ok: false, error: target.error });
      const { phrenPath, project, storeRole } = target.value;
      const denied = permissionDeniedError(phrenPath, "promote_note", project);
      if (denied) return mcpResponse({ ok: false, error: denied });
      return ctx.withWriteQueue(async () => {
        const result = promoteNote(phrenPath, project, note, findingType);
        if (!result.ok) return mcpResponse({ ok: false, error: result.error, errorCode: result.code });
        await refreshIndex(ctx, storeRole, result.data.note.path, path.join(phrenPath, project, FINDINGS_FILENAME));
        return mcpResponse({ ok: true, message: `Promoted ${result.data.note.id} to a finding.`, data: { project, ...result.data } });
      });
    },
  );
}

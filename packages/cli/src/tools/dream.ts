import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { applyDreamProposals, pendingDreamProposals } from "../dream/apply.js";
import { redactSecretsForLog } from "../content/secrets.js";
import { z } from "zod";
import { type McpContext, mcpResponse, resolveStoreForProject } from "./types.js";
import { permissionDeniedError } from "../governance/rbac.js";
import { DREAM_LOG_DEFAULT_LIMIT, DREAM_LOG_MAX_LIMIT, dreamStatuses, readDreamJournal, runDream } from "../cli/dream.js";

/**
 * Dreaming over MCP: `dream_run`, `dream_apply`, `dream_status` and `dream_log`, with the
 * parameters of `phren dream run|apply|status|log`. They are full-profile tools, so
 * the core profile reaches them as phren_admin actions.
 */

function target(ctx: McpContext, project: string, mode: "read" | "write") {
  try {
    return { ok: true as const, value: resolveStoreForProject(ctx, project, mode) };
  } catch (err: unknown) {
    return { ok: false as const, error: redactSecretsForLog(err instanceof Error ? err.message : String(err)) };
  }
}

const projectParam = z.string().describe("Project name, optionally store-qualified.");

export function register(server: McpServer, ctx: McpContext): void {
  server.registerTool("dream_apply", {
    title: "◆ phren · dream apply",
    description: "Apply pending structured proposals from a stored dream, refusing missing or changed target findings. Indices are zero-based; adds are approved through the review queue.",
    inputSchema: z.object({ project: projectParam, runId: z.string(), only: z.array(z.number().int().nonnegative()).optional() }),
  }, async ({ project: projectInput, runId, only }) => {
    const resolved = target(ctx, projectInput, "write");
    if (!resolved.ok) return mcpResponse({ ok: false, error: resolved.error });
    const { phrenPath, project } = resolved.value;
    const denied = permissionDeniedError(phrenPath, "edit_finding", project);
    if (denied) return mcpResponse({ ok: false, error: denied });
    try {
      const record = await applyDreamProposals(phrenPath, project, runId, only);
      await ctx.rebuildIndex().catch(() => {});
      return mcpResponse({ ok: true, data: record });
    } catch (err) { return mcpResponse({ ok: false, error: redactSecretsForLog(err instanceof Error ? err.message : String(err)) }); }
  });
  server.registerTool(
    "dream_run",
    {
      title: "◆ phren · dream run",
      description:
        "Run a dream now for one project: an offline pass that reads recent transcripts, findings, truths, pages and git, " +
        "then corrects, merges and reorganizes memory. Propose mode queues adds and stores other operations for dream_apply; apply mode makes " +
        "the changes and logs them in dreams/journal.md. Refused while dreaming is off unless force; returns busy while another " +
        "dream for the project runs. Uses the project's helper account; can take minutes.",
      inputSchema: z.object({
        project: projectParam,
        dryRun: z.boolean().optional().describe("Return the changeset without writing anything."),
        mode: z.enum(["propose", "apply"]).optional().describe("Override dreaming.mode for this run."),
        force: z.boolean().optional().describe("Run even when dreaming is disabled for the project."),
      }),
    },
    async ({ project: projectInput, dryRun, mode, force }) => {
      const resolved = target(ctx, projectInput, dryRun ? "read" : "write");
      if (!resolved.ok) return mcpResponse({ ok: false, error: resolved.error });
      const { phrenPath, project } = resolved.value;
      if (!dryRun) {
        const denied = permissionDeniedError(phrenPath, "edit_finding", project);
        if (denied) return mcpResponse({ ok: false, error: denied });
      }
      try {
        // Not under the write queue: a dream takes minutes, and its writes go through the finding APIs' own locks.
        const outcome = await runDream(phrenPath, project, { dryRun, mode, force, trigger: "manual" });
        if (!dryRun && outcome.status === "ok") await ctx.rebuildIndex().catch(() => {});
        return mcpResponse({
          ok: outcome.status !== "error",
          message: `Dream for ${project}: ${outcome.status}${dryRun ? " (dry run)" : ""}.`,
          data: outcome,
          ...(outcome.status === "error" ? { error: typeof outcome.result.error === "string" ? outcome.result.error : "The dream failed." } : {}),
        });
      } catch (err: unknown) {
        return mcpResponse({ ok: false, error: redactSecretsForLog(err instanceof Error ? err.message : "The dream failed.") });
      }
    },
  );

  server.registerTool(
    "dream_status",
    {
      title: "◆ phren · dream status",
      description:
        "Dreaming status: enabled, mode, cadence, window, last run, next eligible time and the last run's outcome counts. " +
        "Without project, every project in the active profile.",
      inputSchema: z.object({ project: projectParam.optional() }),
    },
    async ({ project: projectInput }) => {
      let phrenPath = ctx.phrenPath;
      let project: string | undefined;
      if (projectInput) {
        const resolved = target(ctx, projectInput, "read");
        if (!resolved.ok) return mcpResponse({ ok: false, error: resolved.error });
        ({ phrenPath, project } = resolved.value);
      }
      const statuses = dreamStatuses(phrenPath, project, ctx.profile);
      const on = statuses.filter((status) => status.enabled).length;
      return mcpResponse({
        ok: true,
        message: project ? `${project}: dreaming ${statuses[0]?.enabled ? "on" : "off"}. ${statuses[0]?.reason ?? ""}`.trim()
          : `Dreaming is on for ${on} of ${statuses.length} projects.`,
        data: project ? statuses[0] : { projects: statuses },
      });
    },
  );

  server.registerTool(
    "dream_log",
    {
      title: "◆ phren · dream log",
      description: "The latest entries of a project's dream journal (dreams/journal.md), newest first: what each dream did.",
      inputSchema: z.object({
        project: projectParam,
        limit: z.number().int().min(1).max(DREAM_LOG_MAX_LIMIT).optional().describe(`Entries to return. Defaults to ${DREAM_LOG_DEFAULT_LIMIT}.`),
      }),
    },
    async ({ project: projectInput, limit }) => {
      const resolved = target(ctx, projectInput, "read");
      if (!resolved.ok) return mcpResponse({ ok: false, error: resolved.error });
      const { phrenPath, project } = resolved.value;
      const entries = readDreamJournal(phrenPath, project, limit ?? DREAM_LOG_DEFAULT_LIMIT);
      return mcpResponse({
        ok: true,
        message: entries.length ? `${entries.length} dream journal entries for ${project}.` : `No dreams recorded for ${project} yet.`,
        data: { project, entries, pendingProposals: pendingDreamProposals(phrenPath, project) },
      });
    },
  );
}

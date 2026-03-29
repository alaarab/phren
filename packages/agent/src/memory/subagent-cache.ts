/**
 * Cross-session subagent result caching.
 *
 * When a subagent discovers something useful, its result is saved as a finding.
 * Next session, if a similar task comes up, the prior result is injected
 * instead of re-running the subagent — saving time and cost.
 */
import type { PhrenContext } from "./context.js";

/**
 * Search phren for a cached subagent result matching the given task.
 * Returns the cached result text if found, or null.
 */
export async function findCachedSubagentResult(
  ctx: PhrenContext,
  task: string,
): Promise<string | null> {
  try {
    const { buildIndex } = await import("@phren/cli/shared");
    const { searchKnowledgeRows } = await import("@phren/cli/shared/retrieval");

    // Search for prior subagent findings about this topic
    const db = await buildIndex(ctx.phrenPath, ctx.profile);
    const result = await searchKnowledgeRows(db, {
      query: `subagent: ${task}`,
      maxResults: 3,
      filterProject: ctx.project || null,
      filterType: null,
      phrenPath: ctx.phrenPath,
    });

    const rows = result.rows ?? [];
    if (rows.length === 0) return null;

    // Check if any result is a subagent cache hit (tagged with <!-- subagent_cache -->)
    for (const row of rows) {
      const content = (row as { content?: string }).content ?? "";
      if (content.includes("<!-- subagent_cache -->")) {
        // Extract the cached result
        const match = content.match(/Result:\s*([\s\S]*?)(?:<!-- |$)/);
        if (match) {
          return match[1].trim();
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Save a subagent result to phren for future cache hits.
 * The finding is tagged with <!-- subagent_cache --> for identification.
 */
export async function cacheSubagentResult(
  ctx: PhrenContext,
  task: string,
  result: string,
  sessionId?: string | null,
): Promise<void> {
  try {
    const { addFinding } = await import("@phren/cli/core/finding");

    const project = ctx.project;
    if (!project) return;

    // Truncate result to keep findings manageable
    const truncated = result.length > 1000 ? result.slice(0, 1000) + "\n[truncated]" : result;

    const finding = [
      `Subagent result for: ${task.slice(0, 200)}`,
      `Result: ${truncated}`,
      `<!-- subagent_cache -->`,
    ].join("\n");

    addFinding(ctx.phrenPath, project, finding);
  } catch {
    // Best effort — don't fail the agent if caching fails
  }
}

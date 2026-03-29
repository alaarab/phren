import type { AgentTool } from "./types.js";
import type { PhrenContext } from "../memory/context.js";
import { buildIndex } from "@phren/cli/shared";
import { searchKnowledgeRows, rankResults } from "@phren/cli/shared/retrieval";

export function createPhrenSearchTool(ctx: PhrenContext): AgentTool {
  return {
    name: "phren_search",
    description: "Search phren knowledge base for relevant findings, tasks, and reference docs. Use this to recall past decisions, patterns, and context.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        project: { type: "string", description: "Limit to a specific project." },
        limit: { type: "number", description: "Max results. Default: 10." },
      },
      required: ["query"],
    },
    async execute(input) {
      const query = input.query as string;
      const project = (input.project as string) || ctx.project;
      const limit = (input.limit as number) || 10;

      try {
        const db = await buildIndex(ctx.phrenPath, ctx.profile);
        const result = await searchKnowledgeRows(db, {
          query,
          maxResults: limit,
          filterProject: project || null,
          filterType: null,
          phrenPath: ctx.phrenPath,
        });
        const ranked = rankResults(result.rows ?? [], query, null, project || null, ctx.phrenPath, db);

        if (ranked.length === 0) return { output: "No results found." };

        const lines = ranked.slice(0, limit).map((r: { project: string; filename: string; content?: string }, i: number) => {
          const snippet = r.content?.slice(0, 300) ?? "";
          return `${i + 1}. [${r.project}/${r.filename}] ${snippet}`;
        });
        return { output: lines.join("\n\n") };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `Search failed: ${msg}`, is_error: true };
      }
    },
  };
}

import type { AgentTool } from "./types.js";
import type { PhrenContext } from "../memory/context.js";
import { addFinding } from "../../core/finding.js";
import { incrementSessionCounter } from "../memory/session.js";

export function createPhrenFindingTool(ctx: PhrenContext, sessionId?: string | null): AgentTool {
  return {
    name: "phren_add_finding",
    description: "Save a non-obvious finding to phren memory. Use for patterns, decisions, pitfalls, bugs, or tradeoffs worth remembering next session.",
    input_schema: {
      type: "object",
      properties: {
        finding: { type: "string", description: "The finding to save." },
        project: { type: "string", description: "Project name. Default: detected project." },
      },
      required: ["finding"],
    },
    async execute(input) {
      const finding = input.finding as string;
      const project = (input.project as string) || ctx.project;
      if (!project) return { output: "No project context. Specify a project name.", is_error: true };

      try {
        const result = await addFinding(ctx.phrenPath, project, finding);
        if (result.ok) {
          if (sessionId) incrementSessionCounter(ctx.phrenPath, sessionId, "findingsAdded");
          return { output: `Finding saved to ${project}.` };
        }
        return { output: result.message ?? "Failed to save finding.", is_error: true };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `Failed: ${msg}`, is_error: true };
      }
    },
  };
}

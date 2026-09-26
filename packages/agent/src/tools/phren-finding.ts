import type { AgentTool } from "./types.js";
import type { PhrenContext } from "../memory/context.js";
import { addFindingToFile } from "@phren/cli/shared/content";
import { incrementSessionCounter } from "../memory/session.js";
import { agentProvenance } from "../memory/provenance.js";

export function createPhrenFindingTool(ctx: PhrenContext, sessionId?: string | null): AgentTool {
  return {
    name: "phren_add_finding",
    description: "Save a finding to phren memory for future sessions. Good: architecture decisions with rationale, non-obvious bug causes, workarounds, gotchas, tradeoffs. Bad: obvious facts, narration of steps taken, secrets/PII. Keep findings concise and actionable.",
    input_schema: {
      type: "object",
      properties: {
        finding: { type: "string", description: "The finding to save." },
        project: { type: "string", description: "Project name. Default: detected project." },
        file: { type: "string", description: "Source file the finding is about, for the citation." },
      },
      required: ["finding"],
    },
    async execute(input) {
      const finding = input.finding as string;
      const project = (input.project as string) || ctx.project;
      const file = (input.file as string) || undefined;
      if (!project) return { output: "No project context. Specify a project name.", is_error: true };

      try {
        // addFindingToFile infers repo root + HEAD commit for the citation itself;
        // we add the session provenance so the finding is traceable and age-able.
        const result = addFindingToFile(ctx.phrenPath, project, finding, file ? { file } : undefined, {
          provenance: agentProvenance(sessionId),
          ...(sessionId ? { sessionId } : {}),
        });
        if (result.ok) {
          if (sessionId) incrementSessionCounter(ctx.phrenPath, sessionId, "findingsAdded");
          return { output: result.data?.message ?? `Finding saved to ${project}.` };
        }
        return { output: result.error ?? "Failed to save finding.", is_error: true };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `Failed: ${msg}`, is_error: true };
      }
    },
  };
}

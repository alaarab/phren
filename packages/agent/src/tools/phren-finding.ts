import type { AgentTool } from "./types.js";
import type { PhrenContext } from "../memory/context.js";
import { addFinding } from "@phren/cli/core/finding";
import { incrementSessionCounter } from "../memory/session.js";
import { scrubFinding, validateFindingSafety } from "../permissions/privacy.js";

export function createPhrenFindingTool(ctx: PhrenContext, sessionId?: string | null): AgentTool {
  return {
    name: "phren_add_finding",
    description: "Save a finding to phren memory for future sessions. Good: architecture decisions with rationale, non-obvious bug causes, workarounds, gotchas, tradeoffs. Bad: obvious facts, narration of steps taken, secrets/PII. Keep findings concise and actionable.",
    input_schema: {
      type: "object",
      properties: {
        finding: { type: "string", description: "The finding to save." },
        project: { type: "string", description: "Project name. Default: detected project." },
      },
      required: ["finding"],
    },
    async execute(input) {
      const rawFinding = input.finding as string;
      const project = (input.project as string) || ctx.project;
      if (!project) return { output: "No project context. Specify a project name.", is_error: true };

      // Privacy: scrub secrets before saving to persistent memory
      const finding = scrubFinding(rawFinding);
      const safetyWarning = validateFindingSafety(rawFinding);

      try {
        const result = await addFinding(ctx.phrenPath, project, finding);
        if (result.ok) {
          if (sessionId) incrementSessionCounter(ctx.phrenPath, sessionId, "findingsAdded");
          const warning = safetyWarning ? ` Warning: ${safetyWarning}` : "";
          return { output: `Finding saved to ${project}.${warning}` };
        }
        return { output: result.message ?? "Failed to save finding.", is_error: true };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `Failed: ${msg}`, is_error: true };
      }
    },
  };
}

import type { AgentTool } from "./types.js";
import type { PhrenContext } from "../memory/context.js";
import { findSkill } from "@phren/cli/skill/registry";
import * as fs from "fs";

export function createSkillTool(phrenCtx: PhrenContext | null): AgentTool {
  return {
    name: "run_skill",
    description: "Execute a phren skill by name. Skills are prompt templates stored in the phren store (global/skills/ and per-project skills/). Returns the skill content which you should follow as instructions.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name (e.g. 'commit', 'review-pr', 'consolidate')" },
        args: { type: "string", description: "Optional arguments to pass to the skill" },
      },
      required: ["name"],
    },
    async execute(input) {
      const name = input.name as string;
      const args = (input.args as string) || "";

      if (!phrenCtx) {
        return { output: "No phren context available.", is_error: true };
      }

      try {
        // The CLI's registry resolves precedence (project over global), folder
        // vs flat layout, and enable state — the same view `phren skills` shows.
        const result = findSkill(phrenCtx.phrenPath, phrenCtx.profile, phrenCtx.project ?? undefined, name);
        if (!result) {
          return { output: `Skill "${name}" not found. Use the skills listed in the system prompt, or check \`phren skills\`.`, is_error: true };
        }
        if ("error" in result) {
          return { output: result.error, is_error: true };
        }
        if (!result.enabled) {
          return { output: `Skill "${result.name}" exists but is disabled for this scope.`, is_error: true };
        }

        const content = fs.readFileSync(result.path, "utf-8");
        const stripped = content.replace(/^---\n[\s\S]*?\n---\n/, "");
        return { output: `[Skill: ${result.name}${args ? ` ${args}` : ""}]\n\n${stripped}` };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `Failed to load skill "${name}": ${msg}`, is_error: true };
      }
    },
  };
}

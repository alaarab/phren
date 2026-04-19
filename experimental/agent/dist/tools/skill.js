import * as fs from "fs";
import * as path from "path";
export function createSkillTool(phrenCtx) {
    return {
        name: "run_skill",
        description: "Execute a phren skill by name. Skills are prompt templates stored in ~/.phren/skills/. Returns the skill content which you should follow as instructions.",
        input_schema: {
            type: "object",
            properties: {
                name: { type: "string", description: "Skill name (e.g. 'commit', 'review-pr', 'consolidate')" },
                args: { type: "string", description: "Optional arguments to pass to the skill" },
            },
            required: ["name"],
        },
        async execute(input) {
            const name = input.name;
            const args = input.args || "";
            if (!phrenCtx) {
                return { output: "No phren context available.", is_error: true };
            }
            // Look for skill in global and project locations
            const locations = [
                path.join(phrenCtx.phrenPath, "skills", `${name}.md`),
                path.join(phrenCtx.phrenPath, "skills", name, "index.md"),
            ];
            // Also check project-specific skills (higher priority)
            if (phrenCtx.project) {
                locations.unshift(path.join(phrenCtx.phrenPath, phrenCtx.project, "skills", `${name}.md`));
            }
            for (const loc of locations) {
                try {
                    const content = fs.readFileSync(loc, "utf-8");
                    // Strip YAML frontmatter
                    const stripped = content.replace(/^---\n[\s\S]*?\n---\n/, "");
                    return { output: `[Skill: ${name}${args ? ` ${args}` : ""}]\n\n${stripped}` };
                }
                catch {
                    continue;
                }
            }
            return { output: `Skill "${name}" not found. Check ~/.phren/skills/ for available skills.`, is_error: true };
        },
    };
}

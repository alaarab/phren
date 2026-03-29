import { importTasks } from "../phren-imports.js";
import { incrementSessionCounter } from "../memory/session.js";
export function createPhrenGetTasksTool(ctx) {
    return {
        name: "phren_get_tasks",
        description: "Read the current task list from phren. Shows active and queued tasks for a project.",
        input_schema: {
            type: "object",
            properties: {
                project: { type: "string", description: "Project name. Omit to use current project." },
            },
        },
        async execute(input) {
            const project = input.project || ctx.project;
            if (!project)
                return { output: "No project context. Specify a project name.", is_error: true };
            try {
                const { readTasks } = await importTasks();
                const result = readTasks(ctx.phrenPath, project);
                if (!result.ok)
                    return { output: result.error ?? "Failed to read tasks.", is_error: true };
                const sections = [];
                for (const [section, items] of Object.entries(result.data.items)) {
                    if (section === "Done")
                        continue;
                    if (items.length === 0)
                        continue;
                    const lines = items.map((t) => `- [${t.checked ? "x" : " "}] ${t.line}`);
                    sections.push(`## ${section}\n${lines.join("\n")}`);
                }
                return { output: sections.length > 0 ? sections.join("\n\n") : "No active tasks." };
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { output: `Failed: ${msg}`, is_error: true };
            }
        },
    };
}
export function createPhrenCompleteTaskTool(ctx, sessionId) {
    return {
        name: "phren_complete_task",
        description: "Mark a task as completed in phren by matching its text.",
        input_schema: {
            type: "object",
            properties: {
                item: { type: "string", description: "Task text to match." },
                project: { type: "string", description: "Project name. Omit to use current project." },
            },
            required: ["item"],
        },
        async execute(input) {
            const item = input.item;
            const project = input.project || ctx.project;
            if (!project)
                return { output: "No project context. Specify a project name.", is_error: true };
            try {
                const { completeTasks } = await importTasks();
                const result = completeTasks(ctx.phrenPath, project, [item]);
                if (result.ok) {
                    if (sessionId)
                        incrementSessionCounter(ctx.phrenPath, sessionId, "tasksCompleted");
                    return { output: `Task completed in ${project}.` };
                }
                return { output: result.error ?? "Failed to complete task.", is_error: true };
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { output: `Failed: ${msg}`, is_error: true };
            }
        },
    };
}

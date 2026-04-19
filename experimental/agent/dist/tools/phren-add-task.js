import { addTasks } from "@phren/cli/data/tasks";
export function createPhrenAddTaskTool(ctx, sessionId) {
    return {
        name: "phren_add_task",
        description: "Add a new task to the phren task list for a project. " +
            "Use this to track work items discovered during execution that should be addressed later. " +
            "Good tasks: TODOs found in code, follow-up work, bugs to fix, tech debt. " +
            "Bad tasks: obvious next steps, tasks you'll complete in this session.",
        input_schema: {
            type: "object",
            properties: {
                item: {
                    type: "string",
                    description: "Task description. Be specific — include file paths, function names, or error context.",
                },
                project: {
                    type: "string",
                    description: "Project name. Omit to use current project.",
                },
                priority: {
                    type: "string",
                    enum: ["high", "medium", "low"],
                    description: "Task priority. Default: medium.",
                },
            },
            required: ["item"],
        },
        async execute(input) {
            const item = input.item;
            const project = input.project || ctx.project;
            const priority = input.priority || "medium";
            if (!project)
                return { output: "No project context. Specify a project name.", is_error: true };
            try {
                // Format with priority prefix if not medium
                const taskText = priority !== "medium" ? `[${priority}] ${item}` : item;
                const result = addTasks(ctx.phrenPath, project, [taskText]);
                if (result.ok) {
                    return { output: `Task added to ${project}: ${item}` };
                }
                return { output: result.error ?? "Failed to add task.", is_error: true };
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { output: `Failed: ${msg}`, is_error: true };
            }
        },
    };
}

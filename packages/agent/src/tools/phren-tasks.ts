import type { AgentTool } from "./types.js";
import type { PhrenContext } from "../memory/context.js";
import { readTasks, completeTasks } from "@phren/cli/data/tasks";
import { TASKS_RETIRED, TASKS_RETIRED_MESSAGE } from "@phren/cli/task/retired";
import { incrementSessionCounter } from "../memory/session.js";

export function createPhrenGetTasksTool(ctx: PhrenContext): AgentTool {
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
      const project = (input.project as string) || ctx.project;
      if (!project) return { output: "No project context. Specify a project name.", is_error: true };

      try {
        const result = readTasks(ctx.phrenPath, project);
        if (!result.ok) return { output: result.error ?? "Failed to read tasks.", is_error: true };

        const sections: string[] = [];
        for (const [section, items] of Object.entries(result.data!.items)) {
          if (section === "Done") continue;
          if (items.length === 0) continue;
          const lines = items.map((t) => `- [${t.checked ? "x" : " "}] ${t.line}`);
          sections.push(`## ${section}\n${lines.join("\n")}`);
        }
        return { output: sections.length > 0 ? sections.join("\n\n") : "No active tasks." };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `Failed: ${msg}`, is_error: true };
      }
    },
  };
}

export function createPhrenCompleteTaskTool(ctx: PhrenContext, sessionId?: string | null): AgentTool {
  return {
    name: "phren_complete_task",
    description: "Deprecated: phren tasks are retired, so this returns the retirement message and writes nothing. Read tasks with phren_get_tasks; work lives in forge issues.",
    input_schema: {
      type: "object",
      properties: {
        item: { type: "string", description: "Task text to match." },
        project: { type: "string", description: "Project name. Omit to use current project." },
      },
      required: ["item"],
    },
    async execute(input) {
      // tasks retired (0.4.0): completion is read-only work now; the read tool above still works.
      if (TASKS_RETIRED) return { output: TASKS_RETIRED_MESSAGE, is_error: true };
      const item = input.item as string;
      const project = (input.project as string) || ctx.project;
      if (!project) return { output: "No project context. Specify a project name.", is_error: true };

      try {
        const result = completeTasks(ctx.phrenPath, project, [item]);
        if (result.ok) {
          if (sessionId) incrementSessionCounter(ctx.phrenPath, sessionId, "tasksCompleted");
          return { output: `Task completed in ${project}.` };
        }
        return { output: result.error ?? "Failed to complete task.", is_error: true };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `Failed: ${msg}`, is_error: true };
      }
    },
  };
}

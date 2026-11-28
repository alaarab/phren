/**
 * phren_add_task tool — lets the agent create new tasks in phren.
 */
import type { AgentTool } from "./types.js";
import type { PhrenContext } from "../memory/context.js";
import { addTasks } from "@phren/cli/data/tasks";
import { TASKS_RETIRED, TASKS_RETIRED_MESSAGE } from "@phren/cli/task/retired";

export function createPhrenAddTaskTool(ctx: PhrenContext, sessionId?: string | null): AgentTool {
  return {
    name: "phren_add_task",
    description:
      "Deprecated: phren tasks are retired, so this tool returns the retirement message and writes nothing. " +
      "Use forge issues (`phren issue`, `create_issue`) for work and the owner Inbox for owner actions.",
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
      // tasks retired (0.4.0): work belongs in forge issues, so this tool stops writing.
      if (TASKS_RETIRED) return { output: TASKS_RETIRED_MESSAGE, is_error: true };
      const item = input.item as string;
      const project = (input.project as string) || ctx.project;
      const priority = (input.priority as string) || "medium";
      if (!project) return { output: "No project context. Specify a project name.", is_error: true };

      try {
        // Format with priority prefix if not medium
        const taskText = priority !== "medium" ? `[${priority}] ${item}` : item;
        const result = addTasks(ctx.phrenPath, project, [taskText]);
        if (result.ok) {
          return { output: `Task added to ${project}: ${item}` };
        }
        return { output: result.error ?? "Failed to add task.", is_error: true };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `Failed: ${msg}`, is_error: true };
      }
    },
  };
}

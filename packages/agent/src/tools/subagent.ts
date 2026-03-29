/**
 * Subagent tool — lets the LLM spawn isolated child agents for subtasks.
 *
 * Each subagent gets a fresh context window with scoped tools, executes its task,
 * and returns a summary to the parent. This keeps the parent context clean.
 */
import type { AgentTool, AgentToolResult } from "./types.js";
import type { AgentConfig } from "../agent-loop.js";
import { runAgent } from "../agent-loop.js";

export interface SubagentConfig {
  /** Parent agent config to inherit provider, phrenCtx, etc. */
  parentConfig: AgentConfig;
  /** Max turns for subagents (lower than parent). */
  maxTurns?: number;
  /** Max concurrent subagents. */
  maxConcurrent?: number;
}

let activeSubagents = 0;

export function createSubagentTool(config: SubagentConfig): AgentTool {
  const maxTurns = config.maxTurns ?? 20;
  const maxConcurrent = config.maxConcurrent ?? 3;

  return {
    name: "subagent",
    description:
      "Spawn an isolated subagent to handle a focused subtask. The subagent gets a fresh context window, " +
      "executes the task autonomously using the same tools, and returns a summary. " +
      "Use this for: (1) research/exploration that would bloat your context, " +
      "(2) independent subtasks that can run in parallel with your main work, " +
      "(3) tasks requiring deep file reading that you don't need in your own context. " +
      "The subagent inherits your tools and phren context but NOT your conversation history.",
    input_schema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Clear, self-contained task description for the subagent. Include all necessary context since it has no access to your conversation.",
        },
        scope: {
          type: "string",
          enum: ["research", "code", "test"],
          description: "Scope hint. 'research' = read-only exploration, 'code' = may edit files, 'test' = run tests/checks. Default: research.",
        },
      },
      required: ["task"],
    },
    async execute(input): Promise<AgentToolResult> {
      const task = input.task as string;
      const scope = (input.scope as string) || "research";

      if (activeSubagents >= maxConcurrent) {
        return {
          output: `Too many concurrent subagents (${activeSubagents}/${maxConcurrent}). Wait for one to finish.`,
          is_error: true,
        };
      }

      activeSubagents++;
      try {
        // Build a scoped system prompt for the subagent
        const subSystemPrompt = buildSubagentPrompt(scope, config.parentConfig.systemPrompt);

        // Create a scoped registry — research subagents get read-only tools
        const { ToolRegistry } = await import("./registry.js");
        const subRegistry = new ToolRegistry();
        subRegistry.setPermissions(config.parentConfig.registry.permissionConfig);

        // Copy tools from parent, but filter by scope
        const parentDefs = config.parentConfig.registry.getDefinitions();
        const readOnlyTools = new Set([
          "read_file", "glob", "grep", "git_status", "git_diff",
          "phren_search", "phren_get_tasks", "web_fetch", "web_search",
        ]);
        const codeTools = new Set([
          ...readOnlyTools, "edit_file", "write_file", "shell",
          "phren_add_finding", "phren_complete_task", "phren_add_task", "git_commit",
        ]);

        const allowedTools = scope === "research" ? readOnlyTools
          : scope === "test" ? new Set([...readOnlyTools, "shell"])
          : codeTools;

        // We need to re-register tools from parent — access private map via getDefinitions
        // Since we can't directly clone tools, we create a proxy registry
        for (const def of parentDefs) {
          if (allowedTools.has(def.name)) {
            // Wrap parent's execute through registry
            const parentRegistry = config.parentConfig.registry;
            subRegistry.register({
              name: def.name,
              description: def.description,
              input_schema: def.input_schema,
              async execute(toolInput) {
                return parentRegistry.execute(def.name, toolInput);
              },
            });
          }
        }

        const subConfig: AgentConfig = {
          provider: config.parentConfig.provider,
          registry: subRegistry,
          systemPrompt: subSystemPrompt,
          maxTurns,
          verbose: false,
          phrenCtx: config.parentConfig.phrenCtx,
          costTracker: config.parentConfig.costTracker, // share cost tracker
        };

        const result = await runAgent(task, subConfig);

        // Return a concise summary
        const summary = result.finalText.length > 3000
          ? result.finalText.slice(0, 3000) + "\n\n[subagent output truncated]"
          : result.finalText;

        return {
          output: `[Subagent completed: ${result.turns} turns, ${result.toolCalls} tool calls]\n\n${summary}`,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `Subagent failed: ${msg}`, is_error: true };
      } finally {
        activeSubagents--;
      }
    },
  };
}

function buildSubagentPrompt(scope: string, parentSystemPrompt: string): string {
  const scopeInstructions = scope === "research"
    ? "You are in RESEARCH mode. You can only read files, search, and browse. You cannot modify any files. Focus on gathering information and providing a clear, detailed answer."
    : scope === "test"
    ? "You are in TEST mode. You can read files and run shell commands to execute tests and checks. Report results clearly."
    : "You are in CODE mode. You can read, write, and edit files. Make targeted changes and verify them.";

  // Extract phren context from parent prompt if present
  const phrenCtxMatch = parentSystemPrompt.match(/## Project Context[\s\S]*$/);
  const phrenCtx = phrenCtxMatch ? phrenCtxMatch[0] : "";

  return [
    "You are a focused subagent spawned to complete a specific task. Work autonomously and return a clear, concise result.",
    "",
    scopeInstructions,
    "",
    "## Rules",
    "- Stay focused on the assigned task. Don't explore unrelated areas.",
    "- Be concise in your final response — the parent agent will read your output.",
    "- Save important discoveries with phren_add_finding if they'd help future sessions.",
    "",
    phrenCtx,
  ].join("\n");
}

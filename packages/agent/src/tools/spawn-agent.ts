/**
 * spawn_agent tool — lets the LLM naturally spawn child agents.
 *
 * The LLM calls this tool when the user asks to "spawn agents", "create a team",
 * "spin up workers", etc. The LLM decides the name, task, and count itself.
 */
import type { AgentTool, AgentToolResult } from "./types.js";
import type { AgentSpawner } from "../multi/spawner.js";

export function createSpawnAgentTool(spawner: AgentSpawner): AgentTool {
  return {
    name: "spawn_agent",
    description: `Spawn a child agent to work on a task in parallel. The agent runs autonomously with its own LLM session and tool access. Use this when the user asks you to spawn agents, create a team, or delegate work. You can spawn multiple agents by calling this tool multiple times. If the user says "spawn on idle" or "spawn without a task", set idle to true — the agent will start but wait for instructions.`,
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Short descriptive name for the agent (e.g. 'fixer', 'explorer', 'tester', 'reviewer')",
        },
        task: {
          type: "string",
          description: "The task for the agent to work on. If idle is true, this is optional — the agent will wait for instructions.",
        },
        idle: {
          type: "boolean",
          description: "If true, spawn the agent but don't give it a task yet — it starts idle and waits for messages. Default: false.",
        },
      },
      required: ["name"],
    },

    async execute(input: Record<string, unknown>): Promise<AgentToolResult> {
      const name = input.name as string;
      const task = (input.task as string) || "";
      const idle = input.idle as boolean;

      if (!name) {
        return { output: "Agent name is required.", is_error: true };
      }

      const agentTask = idle
        ? `You are agent "${name}". You have been spawned on idle. Wait for instructions from the user or other agents. When you receive a message, work on it and report back.`
        : task || `You are agent "${name}". Work on any tasks assigned to you.`;

      const agentId = spawner.spawn({
        task: agentTask,
        cwd: process.cwd(),
        verbose: false,
      });

      const status = idle ? "idle (waiting for instructions)" : "running";
      return {
        output: `Spawned agent "${name}" (${agentId}) — ${status}${task ? `: ${task}` : ""}`,
      };
    },
  };
}

/**
 * spawn_agent tool — lets the LLM naturally spawn child agents.
 *
 * The LLM calls this tool when the user asks to "spawn agents", "create a team",
 * "spin up workers", etc. The LLM decides the name, task, and count itself.
 */
import type { AgentTool, AgentToolResult } from "./types.js";
import type { AgentSpawner } from "../multi/spawner.js";

export function createSendMessageTool(spawner: AgentSpawner): AgentTool {
  return {
    name: "send_message_to_agent",
    description: `Send a message to an existing spawned agent. Use this to give instructions to idle agents, ask them questions, or assign new tasks. The agent will process the message and respond.`,
    input_schema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "The agent ID to send the message to (e.g. 'agent-1')",
        },
        message: {
          type: "string",
          description: "The message to send to the agent",
        },
      },
      required: ["agent_id", "message"],
    },

    async execute(input: Record<string, unknown>): Promise<AgentToolResult> {
      const agentId = input.agent_id as string;
      const message = input.message as string;

      if (!agentId || !message) {
        return { output: "Both agent_id and message are required.", is_error: true };
      }

      const agent = spawner.getAgent(agentId);
      if (!agent) {
        // Try to find by display name
        const allAgents = spawner.listAgents();
        const byName = allAgents.find((a) => a.displayName === agentId || a.id === agentId);
        if (!byName) {
          const available = allAgents.map((a) => `${a.id} (${a.displayName || a.task.slice(0, 30)})`).join(", ");
          return { output: `Agent "${agentId}" not found. Available: ${available || "none"}`, is_error: true };
        }
        // Use the found agent
        if (byName.status === "idle") {
          spawner.wakeAgent(byName.id, { message, from: "orchestrator" });
          return { output: `Sent message to ${byName.displayName || byName.id} (woke from idle): "${message}"` };
        }
        spawner.sendToAgent(byName.id, message, "orchestrator");
        return { output: `Sent message to ${byName.displayName || byName.id}: "${message}"` };
      }

      if (agent.status === "idle") {
        spawner.wakeAgent(agentId, { message, from: "orchestrator" });
        return { output: `Sent message to ${agent.displayName || agentId} (woke from idle): "${message}"` };
      }

      if (agent.status === "done" || agent.status === "error" || agent.status === "cancelled") {
        return { output: `Agent "${agentId}" is ${agent.status} and cannot receive messages.`, is_error: true };
      }

      spawner.sendToAgent(agentId, message, "orchestrator");
      return { output: `Sent message to ${agent.displayName || agentId}: "${message}"` };
    },
  };
}

export function createListAgentsTool(spawner: AgentSpawner): AgentTool {
  return {
    name: "list_agents",
    description: `List all spawned agents and their current status (running, idle, done, error).`,
    input_schema: { type: "object", properties: {} },

    async execute(): Promise<AgentToolResult> {
      const agents = spawner.listAgents();
      if (agents.length === 0) {
        return { output: "No agents spawned." };
      }
      const lines = agents.map((a) => {
        const name = a.displayName || a.id;
        const elapsed = a.finishedAt
          ? `${((a.finishedAt - a.startedAt) / 1000).toFixed(1)}s`
          : `${((Date.now() - a.startedAt) / 1000).toFixed(0)}s`;
        return `${a.id} [${a.status}] "${name}" — ${elapsed} — ${a.task.slice(0, 60)}`;
      });
      return { output: lines.join("\n") };
    },
  };
}

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
        displayName: name,
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

/**
 * TeamAgent — A lead agent that coordinates multiple child agents as a team.
 *
 * Inspired by Claude Code's agent orchestration model where:
 * - The lead agent plans and delegates subtasks to specialized child agents
 * - Child agents can message each other directly via IPC
 * - The lead agent monitors progress and synthesizes results
 * - Shared task coordination prevents conflicts
 *
 * Usage:
 *   const team = new TeamAgent(spawner, coordinator, config);
 *   await team.run("Build feature X with tests");
 */

import type { AgentSpawner, SpawnOptions } from "./spawner.js";
import type { TeamCoordinator, TeamTask } from "./coordinator.js";
import type { AgentConfig } from "../agent-loop.js";
import type { AgentTool } from "../tools/types.js";
import { runAgent, createSession, runTurn } from "../agent-loop.js";
import { ToolRegistry } from "../tools/registry.js";

/** Configuration for a team agent. */
export interface TeamAgentConfig {
  /** The parent agent config to inherit provider, tools, etc. */
  agentConfig: AgentConfig;
  /** Agent spawner for creating child agents. */
  spawner: AgentSpawner;
  /** Team coordinator for shared task management. */
  coordinator: TeamCoordinator;
  /** Max child agents to run concurrently. */
  maxAgents?: number;
  /** Whether the lead agent should auto-assign tasks. */
  autoAssign?: boolean;
  /** Verbose logging. */
  verbose?: boolean;
}

/** Result of a team run. */
export interface TeamResult {
  finalText: string;
  tasksCompleted: number;
  tasksFailed: number;
  agentsUsed: number;
  totalTurns: number;
}

/**
 * Create the tools that the lead agent uses to coordinate the team.
 * These are injected into the lead agent's tool registry.
 */
export function createTeamTools(
  spawner: AgentSpawner,
  coordinator: TeamCoordinator,
  config: TeamAgentConfig,
): AgentTool[] {
  const maxAgents = config.maxAgents ?? 5;

  return [
    // ── spawn_agent ──────────────────────────────────────────────────────
    {
      name: "spawn_agent",
      description:
        "Spawn a new child agent to work on a subtask. The agent runs autonomously " +
        "with its own context window and tools. Use this to parallelize work or delegate " +
        "specialized tasks (e.g., one agent writes code, another writes tests).",
      input_schema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Short name for the agent (e.g., 'coder', 'tester', 'reviewer').",
          },
          task: {
            type: "string",
            description: "Clear, self-contained task description. Include all necessary context.",
          },
          scope: {
            type: "string",
            enum: ["code", "test", "research", "review"],
            description: "What kind of work this agent will do. Default: code.",
          },
        },
        required: ["name", "task"],
      },
      async execute(input) {
        const name = input.name as string;
        const task = input.task as string;
        const scope = (input.scope as string) || "code";

        const running = spawner.getAgentsByStatus("running");
        if (running.length >= maxAgents) {
          return {
            output: `Max agents reached (${maxAgents}). Wait for one to finish or cancel one.`,
            is_error: true,
          };
        }

        const spawnOpts: SpawnOptions = {
          task: `[${scope}] ${task}`,
          provider: config.agentConfig.provider.name,
          permissions: config.agentConfig.registry.permissionConfig.mode,
          maxTurns: 30,
          verbose: config.verbose ?? false,
        };

        const agentId = spawner.spawn(spawnOpts);
        return {
          output: `Agent "${name}" spawned (ID: ${agentId}). Task: ${task.slice(0, 100)}`,
        };
      },
    },

    // ── send_message ─────────────────────────────────────────────────────
    {
      name: "send_message",
      description:
        "Send a message to a running child agent. Use this to provide additional context, " +
        "redirect an agent's work, or share information between agents. " +
        "The message is injected into the agent's conversation as a user message.",
      input_schema: {
        type: "object",
        properties: {
          agent_id: {
            type: "string",
            description: "ID of the target agent (e.g., 'agent-1').",
          },
          message: {
            type: "string",
            description: "Message to send to the agent.",
          },
        },
        required: ["agent_id", "message"],
      },
      async execute(input) {
        const agentId = input.agent_id as string;
        const message = input.message as string;

        const sent = spawner.sendToAgent(agentId, message, "lead");
        if (!sent) {
          return { output: `Agent "${agentId}" not found or not running.`, is_error: true };
        }
        return { output: `Message sent to ${agentId}.` };
      },
    },

    // ── broadcast_message ────────────────────────────────────────────────
    {
      name: "broadcast_message",
      description:
        "Send a message to ALL running child agents. Use this for announcements, " +
        "shared context updates, or coordination instructions.",
      input_schema: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Message to broadcast to all agents.",
          },
        },
        required: ["message"],
      },
      async execute(input) {
        const message = input.message as string;
        const running = spawner.getAgentsByStatus("running");
        let sent = 0;

        for (const agent of running) {
          if (spawner.sendToAgent(agent.id, message, "lead")) {
            sent++;
          }
        }

        return { output: `Broadcast sent to ${sent} agent(s).` };
      },
    },

    // ── list_agents ──────────────────────────────────────────────────────
    {
      name: "list_agents",
      description: "List all child agents with their current status, task, and runtime.",
      input_schema: {
        type: "object",
        properties: {},
      },
      async execute() {
        const agents = spawner.listAgents();
        if (agents.length === 0) return { output: "No agents spawned." };

        const lines = agents.map((a) => {
          const runtime = a.finishedAt
            ? `${((a.finishedAt - a.startedAt) / 1000).toFixed(1)}s`
            : `${((Date.now() - a.startedAt) / 1000).toFixed(1)}s (running)`;
          const result = a.result
            ? `Result: ${a.result.finalText.slice(0, 100)}...`
            : a.error
            ? `Error: ${a.error.slice(0, 100)}`
            : "";
          return `${a.id} [${a.status}] ${runtime} — ${a.task.slice(0, 80)}\n  ${result}`;
        });

        return { output: lines.join("\n\n") };
      },
    },

    // ── cancel_agent ─────────────────────────────────────────────────────
    {
      name: "cancel_agent",
      description: "Cancel a running child agent.",
      input_schema: {
        type: "object",
        properties: {
          agent_id: {
            type: "string",
            description: "ID of the agent to cancel.",
          },
        },
        required: ["agent_id"],
      },
      async execute(input) {
        const agentId = input.agent_id as string;
        const cancelled = spawner.cancel(agentId);
        return {
          output: cancelled
            ? `Agent ${agentId} cancelled.`
            : `Agent ${agentId} not found or already finished.`,
        };
      },
    },

    // ── create_team_task ─────────────────────────────────────────────────
    {
      name: "create_team_task",
      description:
        "Create a task in the shared team task list. Tasks can have dependencies " +
        "(blockedBy) so they execute in order. Agents claim tasks from this list.",
      input_schema: {
        type: "object",
        properties: {
          subject: {
            type: "string",
            description: "Short task subject.",
          },
          description: {
            type: "string",
            description: "Detailed task description.",
          },
          blocked_by: {
            type: "array",
            items: { type: "string" },
            description: "Task IDs that must complete before this task can start.",
          },
        },
        required: ["subject", "description"],
      },
      async execute(input) {
        const subject = input.subject as string;
        const description = input.description as string;
        const blockedBy = (input.blocked_by as string[]) || [];

        const task = coordinator.createTask(subject, description, blockedBy);
        return { output: `Task #${task.id} created: ${subject}` };
      },
    },

    // ── get_team_status ──────────────────────────────────────────────────
    {
      name: "get_team_status",
      description: "Get the current status of all team tasks including their owners and state.",
      input_schema: {
        type: "object",
        properties: {},
      },
      async execute() {
        return { output: coordinator.formatStatus() };
      },
    },

    // ── wait_for_agents ──────────────────────────────────────────────────
    {
      name: "wait_for_agents",
      description:
        "Wait for one or more running agents to finish. Returns their results. " +
        "Use this after spawning agents to collect their output before proceeding.",
      input_schema: {
        type: "object",
        properties: {
          agent_ids: {
            type: "array",
            items: { type: "string" },
            description: "IDs of agents to wait for. If empty, waits for ALL running agents.",
          },
          timeout_seconds: {
            type: "number",
            description: "Max seconds to wait. Default: 300 (5 minutes).",
          },
        },
      },
      async execute(input) {
        const ids = (input.agent_ids as string[]) || [];
        const timeout = ((input.timeout_seconds as number) || 300) * 1000;

        const targetIds = ids.length > 0
          ? ids
          : spawner.getAgentsByStatus("running").map(a => a.id);

        if (targetIds.length === 0) return { output: "No agents to wait for." };

        const start = Date.now();
        const results: string[] = [];

        await new Promise<void>((resolve) => {
          const check = () => {
            const allDone = targetIds.every((id) => {
              const agent = spawner.getAgent(id);
              return agent && (agent.status === "done" || agent.status === "error" || agent.status === "cancelled");
            });

            if (allDone || Date.now() - start > timeout) {
              resolve();
              return;
            }
            setTimeout(check, 500);
          };
          check();
        });

        for (const id of targetIds) {
          const agent = spawner.getAgent(id);
          if (!agent) {
            results.push(`${id}: not found`);
            continue;
          }
          if (agent.status === "done" && agent.result) {
            const text = agent.result.finalText.length > 2000
              ? agent.result.finalText.slice(0, 2000) + "\n[truncated]"
              : agent.result.finalText;
            results.push(`${id} [done] (${agent.result.turns} turns, ${agent.result.toolCalls} tool calls):\n${text}`);
          } else if (agent.status === "error") {
            results.push(`${id} [error]: ${agent.error}`);
          } else {
            results.push(`${id} [${agent.status}]: still running (timed out waiting)`);
          }
        }

        return { output: results.join("\n\n---\n\n") };
      },
    },
  ];
}

/**
 * Build a system prompt for the lead agent that includes team coordination instructions.
 */
function buildLeadAgentPrompt(basePrompt: string, teamName: string): string {
  return [
    basePrompt,
    "",
    "## Team Coordination",
    `You are the LEAD agent for team "${teamName}". You coordinate child agents to complete complex tasks.`,
    "",
    "### Strategy",
    "1. **Plan** — Break the task into subtasks. Identify dependencies and parallelization opportunities.",
    "2. **Delegate** — Use `spawn_agent` to create specialized agents. Give each a clear, self-contained task.",
    "3. **Monitor** — Use `list_agents` and `get_team_status` to track progress.",
    "4. **Communicate** — Use `send_message` to redirect agents or share context. Use `broadcast_message` for team-wide updates.",
    "5. **Wait** — Use `wait_for_agents` to collect results before proceeding.",
    "6. **Synthesize** — Combine agent outputs, resolve conflicts, and report the final result.",
    "",
    "### Agent Types",
    "- **coder**: Makes code changes. Scope: code.",
    "- **tester**: Writes and runs tests. Scope: test.",
    "- **reviewer**: Reviews code for quality and bugs. Scope: review.",
    "- **researcher**: Investigates codebase or docs. Scope: research.",
    "",
    "### Best Practices",
    "- Spawn agents with clear, complete tasks. They don't share your conversation history.",
    "- Use dependencies (blocked_by) in team tasks to enforce ordering.",
    "- Don't spawn more agents than needed. Prefer 2-3 focused agents over 5+ small ones.",
    "- Wait for agents before spawning dependent work.",
    "- If an agent fails, read the error and either retry with a better prompt or handle it yourself.",
  ].join("\n");
}

/**
 * Run the lead agent with team coordination tools.
 */
export async function runTeamAgent(task: string, config: TeamAgentConfig): Promise<TeamResult> {
  const { agentConfig, spawner, coordinator, verbose } = config;

  // Create a new registry with all parent tools + team tools
  const registry = new ToolRegistry();
  registry.setPermissions(agentConfig.registry.permissionConfig);

  // Copy parent tool definitions (re-register through proxy)
  const parentDefs = agentConfig.registry.getDefinitions();
  for (const def of parentDefs) {
    registry.register({
      name: def.name,
      description: def.description,
      input_schema: def.input_schema,
      async execute(input) {
        return agentConfig.registry.execute(def.name, input);
      },
    });
  }

  // Register team coordination tools
  const teamTools = createTeamTools(spawner, coordinator, config);
  for (const tool of teamTools) {
    registry.register(tool);
  }

  // Build lead agent system prompt
  const systemPrompt = buildLeadAgentPrompt(
    agentConfig.systemPrompt,
    coordinator.teamName,
  );

  // Listen for inter-agent messages and log them
  const messageLog: Array<{ from: string; to: string; content: string; timestamp: number }> = [];
  const messageHandler = (from: string, to: string, content: string) => {
    messageLog.push({ from, to, content, timestamp: Date.now() });
    if (verbose) {
      process.stderr.write(`\x1b[36m[message] ${from} → ${to}: ${content.slice(0, 80)}\x1b[0m\n`);
    }
  };
  spawner.on("message", messageHandler);

  const leadConfig: AgentConfig = {
    ...agentConfig,
    registry,
    systemPrompt,
    maxTurns: agentConfig.maxTurns * 2, // Lead needs more turns to coordinate
  };

  try {
    const result = await runAgent(task, leadConfig);

    // Gather stats
    const allAgents = spawner.listAgents();
    const tasksCompleted = coordinator.getTaskList().filter(t => t.status === "completed").length;
    const tasksFailed = coordinator.getTaskList().filter(t => t.status === "failed").length;

    return {
      finalText: result.finalText,
      tasksCompleted,
      tasksFailed,
      agentsUsed: allAgents.length,
      totalTurns: result.turns,
    };
  } finally {
    spawner.removeListener("message", messageHandler);
  }
}

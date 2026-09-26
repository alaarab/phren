/**
 * spawn_agent tool — lets the LLM naturally spawn child agents.
 *
 * The LLM calls this tool when the user asks to "spawn agents", "create a team",
 * "spin up workers", etc. The LLM decides the name, task, and count itself.
 */
import type { AgentTool, AgentToolResult } from "./types.js";
import type { AgentSpawner } from "../multi/spawner.js";
import type { PermissionConfig, PermissionMode } from "../permissions/types.js";

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

const VALID_PERMISSION_MODES: PermissionMode[] = ["suggest", "auto-confirm", "plan", "full-auto"];

export function createSpawnAgentTool(
  spawner: AgentSpawner,
  getPermissions?: () => PermissionConfig | undefined,
): AgentTool {
  return {
    name: "spawn_agent",
    // The foreground subagent wait is 300s; without a wider scheduler budget
    // the default 120s race always won while the child kept running.
    timeoutMs: 330_000,
    description: `Spawn a child agent. Two modes:

**Subagent** (background=false, default): Runs the task and waits for the result. Output appears inline in your conversation. Use for quick parallel work like "search 3 files", "run tests", "check dependencies". The tool call blocks until the agent finishes and returns its response.

**TeamAgent** (background=true or idle=true): Spawns a persistent agent with its own conversation. Shows up in the tab bar. The user can switch to its chat and talk to it directly. Use when the user says "spawn a team", "create agents on idle", "spin up workers".`,
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Short descriptive name for the agent (e.g. 'fixer', 'explorer', 'tester')",
        },
        task: {
          type: "string",
          description: "The task for the agent to work on.",
        },
        background: {
          type: "boolean",
          description: "If true, creates a TeamAgent (persistent, own chat, shows in tab bar). If false (default), creates a subagent that runs inline and returns the result.",
        },
        idle: {
          type: "boolean",
          description: "If true, spawn as TeamAgent on idle (no task yet, waits for instructions). Implies background=true.",
        },
        isolation: {
          type: "string",
          enum: ["worktree"],
          description: "Set to 'worktree' to run the child in its own git worktree, isolated from your working tree.",
        },
        agent_type: {
          type: "string",
          description: "Agent type name (e.g. 'explore', 'plan', 'general') to restrict the child's tools and prompt.",
        },
        provider: {
          type: "string",
          description: "Override the child's provider (openrouter, anthropic, openai, openai-codex, ollama).",
        },
        model: {
          type: "string",
          description: "Override the child's model.",
        },
        permissions: {
          type: "string",
          enum: ["suggest", "auto-confirm", "plan", "full-auto"],
          description: "Permission mode for the child. Defaults to the parent's current mode.",
        },
      },
      required: ["name"],
    },

    async execute(input: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolResult> {
      const name = input.name as string;
      const task = (input.task as string) || "";
      const idle = input.idle as boolean;
      const background = (input.background as boolean) || idle;

      if (!name) {
        return { output: "Agent name is required.", is_error: true };
      }
      if (!spawner.canSpawn()) {
        return { output: "Maximum subagent depth reached — this agent cannot spawn more children.", is_error: true };
      }

      const agentTask = idle
        ? `You are agent "${name}". You have been spawned on idle. Wait for instructions.`
        : task || `You are agent "${name}". Work on any tasks assigned to you.`;

      const perms = getPermissions?.();
      const requestedPermissions = input.permissions as PermissionMode | undefined;
      const permissions = requestedPermissions && VALID_PERMISSION_MODES.includes(requestedPermissions)
        ? requestedPermissions
        : perms?.mode;
      const isolation = input.isolation === "worktree" ? "worktree" as const : undefined;

      const agentId = spawner.spawn({
        task: agentTask,
        displayName: name,
        cwd: perms?.projectRoot ?? process.cwd(),
        verbose: false,
        isolation,
        agentType: input.agent_type as string | undefined,
        provider: input.provider as string | undefined,
        model: input.model as string | undefined,
        permissions,
        sandboxMode: perms?.sandboxMode,
        allowedPaths: perms?.allowedPaths,
      });

      // TeamAgent (background): return immediately, agent lives in tab bar
      if (background) {
        const status = idle ? "idle (waiting for instructions)" : "running in background";
        return {
          output: `Spawned TeamAgent "${name}" (${agentId}) — ${status}${task ? `: ${task}` : ""}`,
        };
      }

      // Subagent (foreground): wait for completion, return result inline
      return new Promise<AgentToolResult>((resolve) => {
        let settled = false;
        let timer: NodeJS.Timeout | undefined;

        const cleanup = () => {
          if (timer) clearTimeout(timer);
          spawner.removeListener("done", onDone);
          spawner.removeListener("error", onError);
          signal?.removeEventListener("abort", onAbort);
        };
        const finish = (result: AgentToolResult) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        };

        const onDone = (doneId: string, result: { finalText: string; turns: number; toolCalls: number }) => {
          if (doneId !== agentId) return;
          finish({
            output: result.finalText || `Agent "${name}" completed (${result.turns} turns, ${result.toolCalls} tool calls)`,
          });
        };
        const onError = (errId: string, error: string) => {
          if (errId !== agentId) return;
          finish({ output: `Agent "${name}" failed: ${error}`, is_error: true });
        };
        const onAbort = () => {
          spawner.cancel(agentId);
          finish({ output: `Agent "${name}" cancelled.`, is_error: true });
        };

        spawner.on("done", onDone);
        spawner.on("error", onError);

        if (signal) {
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
        }

        // Timeout after 5 minutes
        timer = setTimeout(() => {
          spawner.cancel(agentId);
          finish({ output: `Agent "${name}" timed out after 5 minutes`, is_error: true });
        }, 300_000);
      });
    },
  };
}

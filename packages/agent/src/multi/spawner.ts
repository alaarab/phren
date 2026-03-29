/**
 * Agent spawner — forks child agent processes and manages their lifecycle.
 *
 * Usage:
 *   const spawner = new AgentSpawner();
 *   const id = spawner.spawn({ task: "fix the bug", ... });
 *   spawner.on("done", (agentId, result) => { ... });
 *   spawner.cancel(id);
 *   await spawner.shutdown();
 */

import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import type {
  SpawnPayload,
  ChildMessage,
  AgentEntry,
  AgentStatus,
  DoneEvent,
} from "./types.js";
import type { PermissionMode } from "../permissions/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Resolved path to the child-entry module. */
const CHILD_ENTRY = join(__dirname, "child-entry.js");

/** Options for spawning a child agent. */
export interface SpawnOptions {
  task: string;
  cwd?: string;
  provider?: string;
  model?: string;
  project?: string;
  permissions?: PermissionMode;
  maxTurns?: number;
  budget?: number | null;
  plan?: boolean;
  verbose?: boolean;
  /** Extra env vars to forward (API keys are auto-forwarded). */
  env?: Record<string, string>;
}

export interface AgentSpawnerEvents {
  text_delta: (agentId: string, text: string) => void;
  text_block: (agentId: string, text: string) => void;
  tool_start: (agentId: string, toolName: string, input: Record<string, unknown>, count: number) => void;
  tool_end: (agentId: string, toolName: string, input: Record<string, unknown>, output: string, isError: boolean, durationMs: number) => void;
  status: (agentId: string, message: string) => void;
  done: (agentId: string, result: DoneEvent["result"]) => void;
  error: (agentId: string, error: string) => void;
  exit: (agentId: string, code: number | null) => void;
  message: (from: string, to: string, content: string) => void;
}

/** Keys forwarded from the parent env into child processes. */
const ENV_FORWARD_KEYS = [
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "PHREN_AGENT_PROVIDER",
  "PHREN_AGENT_MODEL",
  "PHREN_OLLAMA_URL",
  "PHREN_PATH",
  "PHREN_PROFILE",
  "PHREN_DEBUG",
  "HOME",
  "PATH",
  "NODE_EXTRA_CA_CERTS",
];

export class AgentSpawner extends EventEmitter {
  private agents = new Map<string, AgentEntry>();
  private processes = new Map<string, ChildProcess>();
  private nextId = 1;

  /** Spawn a new child agent. Returns the agent ID. */
  spawn(opts: SpawnOptions): string {
    const agentId = `agent-${this.nextId++}`;

    // Build forwarded env
    const childEnv: Record<string, string> = {};
    for (const key of ENV_FORWARD_KEYS) {
      if (process.env[key]) childEnv[key] = process.env[key]!;
    }
    if (opts.env) Object.assign(childEnv, opts.env);

    const payload: SpawnPayload = {
      type: "spawn",
      agentId,
      task: opts.task,
      cwd: opts.cwd ?? process.cwd(),
      provider: opts.provider,
      model: opts.model,
      project: opts.project,
      permissions: opts.permissions ?? "auto-confirm",
      maxTurns: opts.maxTurns ?? 50,
      budget: opts.budget ?? null,
      plan: opts.plan ?? false,
      verbose: opts.verbose ?? false,
      env: childEnv,
    };

    const entry: AgentEntry = {
      id: agentId,
      task: opts.task,
      status: "starting",
      startedAt: Date.now(),
    };
    this.agents.set(agentId, entry);

    // Fork the child process
    const child = fork(CHILD_ENTRY, [], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      env: { ...childEnv, FORCE_COLOR: "0" },
      cwd: opts.cwd ?? process.cwd(),
    });

    this.processes.set(agentId, child);
    entry.pid = child.pid;
    entry.status = "running";

    // Send the spawn payload
    child.send(payload);

    // Handle IPC messages from child
    child.on("message", (msg: ChildMessage) => {
      this.handleChildMessage(msg);
    });

    // Handle child exit
    child.on("exit", (code) => {
      const agent = this.agents.get(agentId);
      if (agent && agent.status === "running") {
        agent.status = code === 0 ? "done" : "error";
        agent.finishedAt = Date.now();
        if (code !== 0 && !agent.error) {
          agent.error = `Process exited with code ${code}`;
        }
      }
      this.processes.delete(agentId);
      this.emit("exit", agentId, code);
    });

    // Capture stderr for error reporting
    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      if (opts.verbose) {
        this.emit("status", agentId, text);
      }
    });

    return agentId;
  }

  private handleChildMessage(msg: ChildMessage): void {
    // DirectMessageEvent has from/to instead of agentId — handle before accessing msg.agentId
    if (msg.type === "direct_message") {
      this.routeDirectMessage(msg.from, msg.to, msg.content);
      return;
    }

    const agent = this.agents.get(msg.agentId);

    switch (msg.type) {
      case "text_delta":
        this.emit("text_delta", msg.agentId, msg.text);
        break;
      case "text_block":
        this.emit("text_block", msg.agentId, msg.text);
        break;
      case "tool_start":
        this.emit("tool_start", msg.agentId, msg.toolName, msg.input, msg.count);
        break;
      case "tool_end":
        this.emit("tool_end", msg.agentId, msg.toolName, msg.input, msg.output, msg.isError, msg.durationMs);
        break;
      case "status":
        this.emit("status", msg.agentId, msg.message);
        break;
      case "done":
        if (agent) {
          agent.status = "done";
          agent.finishedAt = Date.now();
          agent.result = msg.result;
        }
        this.emit("done", msg.agentId, msg.result);
        break;
      case "error":
        if (agent) {
          agent.status = "error";
          agent.finishedAt = Date.now();
          agent.error = msg.error;
        }
        this.emit("error", msg.agentId, msg.error);
        break;
    }
  }

  /** Route a direct message from one agent to another. */
  private routeDirectMessage(from: string, to: string, content: string): void {
    this.emit("message", from, to, content);
    this.sendToAgent(to, content, from);
  }

  /** Cancel a running agent. */
  cancel(agentId: string): boolean {
    const child = this.processes.get(agentId);
    if (!child) return false;

    child.send({ type: "cancel", agentId, reason: "Cancelled by parent" });

    // Give it a moment to clean up, then force kill
    setTimeout(() => {
      if (this.processes.has(agentId)) {
        child.kill("SIGTERM");
      }
    }, 5000);

    const agent = this.agents.get(agentId);
    if (agent) {
      agent.status = "cancelled";
      agent.finishedAt = Date.now();
    }

    return true;
  }

  /** Send a direct message to a child agent via IPC. Returns true if delivered. */
  sendToAgent(agentId: string, message: string, from?: string): boolean {
    const child = this.processes.get(agentId);
    if (!child) return false;
    child.send({ type: "deliver_message", from: from ?? "user", content: message });
    return true;
  }

  /** Get the current state of an agent. */
  getAgent(agentId: string): AgentEntry | undefined {
    return this.agents.get(agentId);
  }

  /** List all agents. */
  listAgents(): AgentEntry[] {
    return [...this.agents.values()];
  }

  /** Get agents by status. */
  getAgentsByStatus(status: AgentStatus): AgentEntry[] {
    return [...this.agents.values()].filter((a) => a.status === status);
  }

  /** Shut down all running agents and wait for exit. */
  async shutdown(): Promise<void> {
    const running = this.getAgentsByStatus("running");
    for (const agent of running) {
      this.cancel(agent.id);
    }

    // Wait for all processes to exit (max 10s)
    if (this.processes.size > 0) {
      await new Promise<void>((resolve) => {
        const check = () => {
          if (this.processes.size === 0) return resolve();
          setTimeout(check, 100);
        };
        setTimeout(() => {
          // Force kill remaining
          for (const [id, child] of this.processes) {
            child.kill("SIGKILL");
            this.processes.delete(id);
          }
          resolve();
        }, 10_000);
        check();
      });
    }
  }
}

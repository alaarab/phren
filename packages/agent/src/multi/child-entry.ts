#!/usr/bin/env node
/**
 * Child agent entry point — persistent process that:
 * 1. Receives SpawnPayload via IPC from parent
 * 2. Resolves the LLM provider and registers tools
 * 3. Runs the agent loop
 * 4. Goes idle after task completion — stays alive waiting for messages
 * 5. Wakes on WakeMessage or DeliverMessage to continue
 * 6. Shuts down gracefully on ShutdownRequest
 */

import type { SpawnPayload, ChildMessage, ParentMessage } from "./types.js";
import type { TurnHooks, AgentSession } from "../agent-loop.js";
import { resolveProvider } from "../providers/resolve.js";
import { ToolRegistry } from "../tools/registry.js";
import { readFileTool } from "../tools/read-file.js";
import { writeFileTool } from "../tools/write-file.js";
import { editFileTool } from "../tools/edit-file.js";
import { shellTool } from "../tools/shell.js";
import { globTool } from "../tools/glob.js";
import { grepTool } from "../tools/grep.js";
import { createPhrenSearchTool } from "../tools/phren-search.js";
import { createPhrenFindingTool } from "../tools/phren-finding.js";
import { createPhrenGetTasksTool, createPhrenCompleteTaskTool } from "../tools/phren-tasks.js";
import { gitStatusTool, gitDiffTool, gitCommitTool } from "../tools/git.js";
import { buildPhrenContext, buildContextSnippet } from "../memory/context.js";
import { startSession, endSession, getPriorSummary } from "../memory/session.js";
import { loadProjectContext } from "../memory/project-context.js";
import { buildSystemPrompt } from "../system-prompt.js";
import { runAgent, createSession } from "../agent-loop.js";
import { createCostTracker } from "../cost.js";
import type { LlmProvider } from "../providers/types.js";
import type { PhrenContext } from "../memory/context.js";
import type { CostTracker } from "../cost.js";

/** Send a typed message to the parent process. */
function send(msg: ChildMessage): void {
  if (process.send) {
    process.send(msg);
  }
}

/** Build TurnHooks that relay all events to the parent via IPC. */
function createIpcHooks(agentId: string): TurnHooks {
  return {
    onTextDelta(text: string) {
      send({ type: "text_delta", agentId, text });
    },
    onTextDone() {
      // No-op — parent reconstructs from deltas
    },
    onTextBlock(text: string) {
      send({ type: "text_block", agentId, text });
    },
    onToolStart(name: string, input: Record<string, unknown>, count: number) {
      send({ type: "tool_start", agentId, toolName: name, input, count });
    },
    onToolEnd(name: string, input: Record<string, unknown>, output: string, isError: boolean, durationMs: number) {
      send({ type: "tool_end", agentId, toolName: name, input, output, isError, durationMs });
    },
    onStatus(msg: string) {
      send({ type: "status", agentId, message: msg });
    },
  };
}

// ── Persistent agent state (survives across idle/wake cycles) ──────────────

interface AgentState {
  agentId: string;
  provider: LlmProvider;
  registry: ToolRegistry;
  systemPrompt: string;
  phrenCtx: PhrenContext | null;
  sessionId: string | null;
  costTracker: CostTracker;
  maxTurns: number;
  verbose: boolean;
  plan: boolean;
  hooks: TurnHooks;
  /** Accumulated DM summaries while running, flushed on idle. */
  pendingDms: Array<{ from: string; content: string; timestamp: string }>;
  /** Track whether we've completed at least one task. */
  taskCount: number;
}

/** Build a lightweight system prompt for child agents. No "search memory first" forcing. */
function buildChildPrompt(task: string): string {
  return [
    "You are a team agent. You have coding tools available but only use them when the task requires it.",
    "If someone asks you a question or sends a conversational message, just respond directly — do NOT search, read files, or call tools unless the task explicitly requires code work.",
    "When given a coding task, use your tools effectively: read files, make edits, run commands.",
    "Be direct and concise.",
    "",
    `Your assignment: ${task}`,
  ].join("\n");
}

/** Initialize the persistent agent state from the spawn payload. */
async function initAgentState(payload: SpawnPayload): Promise<AgentState> {
  const { agentId, task: _task, cwd, provider: providerName, model, project, permissions, maxTurns, budget, plan, verbose } = payload;

  // Set cwd (use worktree path if provided)
  process.chdir(payload.worktreePath ?? cwd);

  // Resolve LLM provider
  const provider = resolveProvider(providerName, model);

  // Child agents get a lightweight prompt — no "search memory first" forcing
  const systemPrompt = buildChildPrompt(_task);

  // Quick phren init — just resolve context, skip slow FTS5 search
  // Child agents call phren_search themselves when they actually need it
  const phrenCtx = await buildPhrenContext(project);
  let sessionId: string | null = null;
  if (phrenCtx) { sessionId = startSession(phrenCtx); }

  const registry = new ToolRegistry();
  registry.setPermissions({
    mode: permissions,
    allowedPaths: [],
    projectRoot: payload.worktreePath ?? cwd,
  });
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(editFileTool);
  registry.register(shellTool);
  registry.register(globTool);
  registry.register(grepTool);

  if (phrenCtx) {
    registry.register(createPhrenSearchTool(phrenCtx));
    registry.register(createPhrenFindingTool(phrenCtx, sessionId));
    registry.register(createPhrenGetTasksTool(phrenCtx));
    registry.register(createPhrenCompleteTaskTool(phrenCtx, sessionId));
  }

  registry.register(gitStatusTool);
  registry.register(gitDiffTool);
  registry.register(gitCommitTool);

  // Cost tracker
  const modelName = (provider as { model?: string }).model ?? model ?? provider.name;
  const costTracker = createCostTracker(modelName, budget, provider.name);

  return {
    agentId,
    provider,
    registry,
    systemPrompt,
    phrenCtx,
    sessionId,
    costTracker,
    maxTurns,
    verbose,
    plan,
    hooks: createIpcHooks(agentId),
    pendingDms: [],
    taskCount: 0,
  };
}

/** Run a single task. Returns the result. */
async function runTask(state: AgentState, task: string): Promise<{ finalText: string; turns: number; toolCalls: number; totalCost?: string }> {
  const config = {
    provider: state.provider,
    registry: state.registry,
    systemPrompt: state.systemPrompt,
    maxTurns: state.maxTurns,
    verbose: state.verbose,
    phrenCtx: state.phrenCtx,
    costTracker: state.costTracker,
    plan: state.plan && state.taskCount === 0, // Plan mode only on first task
    hooks: state.hooks,
  };

  const result = await runAgent(task, config);
  state.taskCount++;

  return {
    finalText: result.finalText,
    turns: result.turns,
    toolCalls: result.toolCalls,
    totalCost: result.totalCost,
  };
}

/** Enter idle state — notify parent, wait for wake/shutdown/message. */
function goIdle(state: AgentState, reason: "task_complete" | "awaiting_input" | "available"): void {
  // Flush pending DM summaries
  const dmSummaries = state.pendingDms.length > 0 ? [...state.pendingDms] : undefined;
  state.pendingDms = [];

  send({
    type: "idle",
    agentId: state.agentId,
    idleReason: reason,
    dmSummaries,
  });
}

/** Clean up and exit. */
function shutdown(state: AgentState): void {
  // End phren session
  if (state.phrenCtx && state.sessionId) {
    endSession(state.phrenCtx, state.sessionId, `Agent shut down after ${state.taskCount} tasks`);
  }

  send({ type: "shutdown_approved", agentId: state.agentId });
  process.exit(0);
}

// ── Main: persistent event loop ────────────────────────────────────────────

let agentState: AgentState | null = null;
let isRunning = false;

/** Queue of messages received while the agent was busy running a task. */
const messageQueue: ParentMessage[] = [];

async function handleMessage(msg: ParentMessage): Promise<void> {
  if (msg.type === "spawn") {
    // Initial spawn — initialize state and run first task
    try {
      agentState = await initAgentState(msg);
    } catch (err: unknown) {
      send({ type: "error", agentId: msg.agentId, error: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    }

    isRunning = true;
    try {
      const result = await runTask(agentState, msg.task);

      // Send done event (task completed, but process stays alive)
      send({
        type: "done",
        agentId: agentState.agentId,
        result,
      });

      isRunning = false;

      // Process any queued messages before going idle
      await drainQueue();

      // Go idle if not already running another task
      if (!isRunning) {
        goIdle(agentState, "task_complete");
      }
    } catch (err: unknown) {
      isRunning = false;
      if (agentState.phrenCtx && agentState.sessionId) {
        endSession(agentState.phrenCtx, agentState.sessionId, `Error: ${err instanceof Error ? err.message : String(err)}`);
      }
      send({
        type: "error",
        agentId: agentState.agentId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Don't exit on error — go idle so parent can send new work or shutdown
      goIdle(agentState, "available");
    }
    return;
  }

  if (!agentState) {
    // Not initialized yet — ignore
    return;
  }

  switch (msg.type) {
    case "wake": {
      if (isRunning) {
        messageQueue.push(msg);
        return;
      }
      isRunning = true;
      const task = msg.task ?? msg.message ?? "Continue working";
      try {
        const result = await runTask(agentState, task);
        send({ type: "done", agentId: agentState.agentId, result });
        isRunning = false;
        await drainQueue();
        if (!isRunning) goIdle(agentState, "task_complete");
      } catch (err: unknown) {
        isRunning = false;
        send({ type: "error", agentId: agentState.agentId, error: err instanceof Error ? err.message : String(err) });
        goIdle(agentState, "available");
      }
      break;
    }

    case "deliver_message": {
      if (isRunning) {
        // Record DM for later idle notification
        agentState.pendingDms.push({
          from: msg.from,
          content: msg.content,
          timestamp: new Date().toISOString(),
        });
        // Also queue it as a wake message for when current task finishes
        messageQueue.push({ type: "wake", message: `Message from ${msg.from}: ${msg.content}`, from: msg.from });
        return;
      }
      // Not running — treat as a wake message
      isRunning = true;
      const wakeTask = `Message from ${msg.from}: ${msg.content}`;
      try {
        const result = await runTask(agentState, wakeTask);
        send({ type: "done", agentId: agentState.agentId, result });
        isRunning = false;
        await drainQueue();
        if (!isRunning) goIdle(agentState, "task_complete");
      } catch (err: unknown) {
        isRunning = false;
        send({ type: "error", agentId: agentState.agentId, error: err instanceof Error ? err.message : String(err) });
        goIdle(agentState, "available");
      }
      break;
    }

    case "cancel": {
      // Hard cancel — exit immediately
      if (agentState.phrenCtx && agentState.sessionId) {
        endSession(agentState.phrenCtx, agentState.sessionId, "Cancelled by parent");
      }
      process.exit(130);
      break;
    }

    case "shutdown_request": {
      if (isRunning) {
        // Queue shutdown for after current task
        messageQueue.push(msg);
        return;
      }
      shutdown(agentState);
      break;
    }
  }
}

/** Drain queued messages (received while running). Shutdown takes priority. */
async function drainQueue(): Promise<void> {
  // Check for shutdown first
  const shutdownIdx = messageQueue.findIndex((m) => m.type === "shutdown_request");
  if (shutdownIdx !== -1) {
    messageQueue.length = 0;
    if (agentState) shutdown(agentState);
    return;
  }

  // Process remaining messages
  while (messageQueue.length > 0) {
    const next = messageQueue.shift()!;
    await handleMessage(next);
    if (!agentState) return; // shutdown happened
  }
}

// ── Message listener ───────────────────────────────────────────────────────

process.on("message", (msg: ParentMessage) => {
  if (isRunning && msg.type !== "cancel" && msg.type !== "shutdown_request") {
    // Queue non-urgent messages while running
    if (msg.type === "deliver_message" && agentState) {
      agentState.pendingDms.push({
        from: msg.from,
        content: msg.content,
        timestamp: new Date().toISOString(),
      });
    }
    messageQueue.push(msg);
    return;
  }

  handleMessage(msg).catch((err) => {
    const agentId = agentState?.agentId ?? "unknown";
    send({ type: "error", agentId, error: err instanceof Error ? err.message : String(err) });
  });
});

// If no IPC channel (run directly), exit with error
if (!process.send) {
  process.stderr.write("child-entry.ts must be spawned via AgentSpawner (requires IPC channel)\n");
  process.exit(1);
}

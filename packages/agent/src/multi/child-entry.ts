#!/usr/bin/env node
/**
 * Child agent entry point — standalone process that:
 * 1. Receives SpawnPayload via IPC from parent
 * 2. Resolves the LLM provider
 * 3. Registers the standard tool set
 * 4. Runs the agent loop with TurnHooks that serialize events back via process.send()
 * 5. Sends a final "done" message with the result
 */

import type { SpawnPayload, ChildMessage, ParentMessage } from "./types.js";
import type { TurnHooks } from "../agent-loop.js";
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
import { runAgent } from "../agent-loop.js";
import { createCostTracker } from "../cost.js";

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

/** Run the agent with the given spawn payload. */
async function runChildAgent(payload: SpawnPayload): Promise<void> {
  const { agentId, task, cwd, provider: providerName, model, project, permissions, maxTurns, budget, plan, verbose } = payload;

  // Set cwd
  process.chdir(cwd);

  // Resolve LLM provider
  let provider;
  try {
    provider = resolveProvider(providerName, model);
  } catch (err: unknown) {
    send({ type: "error", agentId, error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }

  // Build phren context
  const phrenCtx = await buildPhrenContext(project);
  let contextSnippet = "";
  let priorSummary: string | null = null;
  let sessionId: string | null = null;

  if (phrenCtx) {
    contextSnippet = await buildContextSnippet(phrenCtx, task);
    priorSummary = getPriorSummary(phrenCtx);
    sessionId = startSession(phrenCtx);

    const projectCtx = loadProjectContext(phrenCtx);
    if (projectCtx) {
      contextSnippet += `\n\n## Agent context (${phrenCtx.project})\n\n${projectCtx}`;
    }
  }

  const systemPrompt = buildSystemPrompt(contextSnippet, priorSummary);

  // Register tools
  const registry = new ToolRegistry();
  registry.setPermissions({
    mode: permissions,
    allowedPaths: [],
    projectRoot: cwd,
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
  const modelName = model ?? provider.name;
  const costTracker = createCostTracker(modelName, budget);

  const config = {
    provider,
    registry,
    systemPrompt,
    maxTurns,
    verbose,
    phrenCtx,
    costTracker,
    plan,
    hooks: createIpcHooks(agentId),
  };

  // Run the agent
  try {
    const result = await runAgent(task, config);

    // End phren session
    if (phrenCtx && sessionId) {
      const summary = result.finalText.slice(0, 500);
      endSession(phrenCtx, sessionId, summary);
    }

    send({
      type: "done",
      agentId,
      result: {
        finalText: result.finalText,
        turns: result.turns,
        toolCalls: result.toolCalls,
        totalCost: result.totalCost,
      },
    });
  } catch (err: unknown) {
    if (phrenCtx && sessionId) {
      endSession(phrenCtx, sessionId, `Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    send({
      type: "error",
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

// ── Main: wait for spawn payload from parent ────────────────────────────────

process.on("message", (msg: ParentMessage) => {
  if (msg.type === "spawn") {
    runChildAgent(msg).then(() => {
      process.exit(0);
    }).catch((err) => {
      const agentId = msg.agentId;
      send({ type: "error", agentId, error: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    });
  } else if (msg.type === "cancel") {
    process.exit(130);
  }
});

// If no IPC channel (run directly), exit with error
if (!process.send) {
  process.stderr.write("child-entry.ts must be spawned via AgentSpawner (requires IPC channel)\n");
  process.exit(1);
}

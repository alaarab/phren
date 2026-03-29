#!/usr/bin/env node
import { parseArgs, printHelp } from "./config.js";
import { resolveProvider } from "./providers/resolve.js";
import { ToolRegistry } from "./tools/registry.js";
import { readFileTool } from "./tools/read-file.js";
import { writeFileTool } from "./tools/write-file.js";
import { editFileTool } from "./tools/edit-file.js";
import { shellTool } from "./tools/shell.js";
import { globTool } from "./tools/glob.js";
import { grepTool } from "./tools/grep.js";
import { createWebFetchTool } from "./tools/web-fetch.js";
import { createWebSearchTool } from "./tools/web-search.js";
import { createPhrenSearchTool } from "./tools/phren-search.js";
import { createPhrenFindingTool } from "./tools/phren-finding.js";
import { createPhrenGetTasksTool, createPhrenCompleteTaskTool } from "./tools/phren-tasks.js";
import { createPhrenAddTaskTool } from "./tools/phren-add-task.js";
import { gitStatusTool, gitDiffTool, gitCommitTool } from "./tools/git.js";
import { lspTool, shutdownLspServers } from "./tools/lsp.js";
import { createSubagentTool } from "./tools/subagent.js";
import { notebookEditTool } from "./tools/notebook-edit.js";
import { askUserTool } from "./tools/ask-user.js";
import { cronCreateTool, cronListTool, cronDeleteTool, cancelAllCronTasks } from "./tools/cron.js";
import { buildPhrenContext, buildContextSnippet } from "./memory/context.js";
import { startSession, endSession, getPriorSummary, saveSessionMessages, loadLastSessionMessages } from "./memory/session.js";
import { loadProjectContext, evolveProjectContext } from "./memory/project-context.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { runAgent, createSession, runTurn } from "./agent-loop.js";
import { createCostTracker } from "./cost.js";
import { codexLogin, codexLogout } from "./providers/codex-auth.js";
import { createCheckpoint } from "./checkpoint.js";
import { detectLintCommand, detectTestCommand } from "./tools/lint-test.js";
import { connectMcpServers, loadMcpConfig, parseMcpInline, type McpConfigEntry } from "./mcp-client.js";
import { HookManager } from "./hooks.js";
import { parsePermissionPattern } from "./permissions/pattern-parser.js";
import type { PermissionPattern } from "./permissions/types.js";
import { tuneEffort } from "./memory/effort-tuner.js";
import { scrubSummary } from "./permissions/privacy.js";
import { loadIgnorePatterns } from "./permissions/ignore.js";

const VERSION = "0.0.1";

/**
 * Parse a CLI permission pattern string like "Bash(npm run *)" into a PermissionPattern.
 */
function parsePatternRule(rule: string, verdict: "allow" | "deny"): PermissionPattern | null {
  return parsePermissionPattern(rule, verdict);
}

/**
 * Run the agent CLI with the given argv tokens.
 * Called from `phren agent ...` or directly via `phren-agent ...`.
 */
export async function runAgentCli(raw: string[]) {

  // Handle auth subcommands before normal arg parsing
  if (raw[0] === "auth") {
    if (raw[1] === "login") {
      await codexLogin();
      process.exit(0);
    }
    if (raw[1] === "logout") {
      codexLogout();
      process.exit(0);
    }
    console.error("Usage: phren-agent auth login|logout");
    process.exit(1);
  }

  const args = parseArgs(raw);

  if (args.help) { printHelp(); process.exit(0); }
  if (args.version) { console.log(`phren-agent v${VERSION}`); process.exit(0); }
  if (!args.task && !args.interactive && !args.multi && !args.team) {
    console.error("Usage: phren-agent <task>\nRun phren-agent --help for more info.");
    process.exit(1);
  }

  // Resolve LLM provider
  let provider;
  try {
    provider = resolveProvider(args.provider, args.model, args.maxOutput);
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (args.verbose) {
    process.stderr.write(`Provider: ${provider.name}\n`);
    process.stderr.write(`Effort: ${args.effort}\n`);
  }

  // Build phren context
  const phrenCtx = await buildPhrenContext(args.project);
  let contextSnippet = "";
  let priorSummary: string | null = null;
  let sessionId: string | null = null;

  if (phrenCtx) {
    if (args.verbose) {
      process.stderr.write(`Phren: ${phrenCtx.phrenPath} (project: ${phrenCtx.project ?? "none"})\n`);
    }
    contextSnippet = await buildContextSnippet(phrenCtx, args.task);
    priorSummary = getPriorSummary(phrenCtx);
    sessionId = startSession(phrenCtx);

    // Load evolved project context for warm start
    const projectCtx = loadProjectContext(phrenCtx);
    if (projectCtx) {
      contextSnippet += `\n\n## Agent context (${phrenCtx.project})\n\n${projectCtx}`;
    }
  }

  const systemPrompt = buildSystemPrompt(contextSnippet, priorSummary);

  // Dry run: print system prompt and exit
  if (args.dryRun) {
    console.log("=== System Prompt ===");
    console.log(systemPrompt);
    console.log("\n=== Task ===");
    console.log(args.task);
    process.exit(0);
  }

  // Parse permission patterns
  const allowRules: PermissionPattern[] = [];
  const denyRules: PermissionPattern[] = [];
  for (const rule of args.allowRules) {
    const parsed = parsePatternRule(rule, "allow");
    if (parsed) allowRules.push(parsed);
  }
  for (const rule of args.denyRules) {
    const parsed = parsePatternRule(rule, "deny");
    if (parsed) denyRules.push(parsed);
  }

  // Load .phrenignore patterns from project root
  const hasIgnore = loadIgnorePatterns(process.cwd());
  if (args.verbose && hasIgnore) {
    process.stderr.write(`Loaded .phrenignore patterns\n`);
  }

  // Register tools
  const registry = new ToolRegistry();
  registry.setPermissions({
    mode: args.permissions,
    allowedPaths: [],
    projectRoot: process.cwd(),
    allowRules: allowRules.length > 0 ? allowRules : undefined,
    denyRules: denyRules.length > 0 ? denyRules : undefined,
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
    registry.register(createPhrenAddTaskTool(phrenCtx, sessionId));
  }

  // Web tools
  registry.register(createWebFetchTool());
  registry.register(createWebSearchTool());

  // Interaction tools
  registry.register(askUserTool);

  // Notebook editing
  registry.register(notebookEditTool);

  // Scheduled tasks
  registry.register(cronCreateTool);
  registry.register(cronListTool);
  registry.register(cronDeleteTool);

  // Git tools
  registry.register(gitStatusTool);
  registry.register(gitDiffTool);
  registry.register(gitCommitTool);

  // LSP tool — registered as deferred (loaded on first use since it spawns processes)
  registry.registerDeferred({
    name: lspTool.name,
    description: lspTool.description,
    input_schema: lspTool.input_schema,
    resolve: async () => lspTool,
  });

  // MCP server connections
  let mcpCleanup: (() => void) | undefined;
  const mcpServers: Record<string, McpConfigEntry> = {};
  if (args.mcpConfig) {
    Object.assign(mcpServers, loadMcpConfig(args.mcpConfig));
  }
  for (let idx = 0; idx < args.mcp.length; idx++) {
    const entry = parseMcpInline(args.mcp[idx]);
    mcpServers[`mcp-${idx}`] = entry;
  }
  if (Object.keys(mcpServers).length > 0) {
    const { tools: mcpTools, cleanup } = await connectMcpServers(mcpServers, args.verbose);
    mcpCleanup = cleanup;
    for (const tool of mcpTools) registry.register(tool);
  }

  // Build cost tracker from model info
  const modelName = args.model ?? provider.name;
  const costTracker = createCostTracker(modelName, args.budget);

  // Build lint/test config from CLI flags or auto-detect
  const cwd = process.cwd();
  const lintCmd = args.lintCmd ?? detectLintCommand(cwd);
  const testCmd = args.testCmd ?? detectTestCommand(cwd);
  const lintTestConfig = (lintCmd || testCmd) ? { lintCmd: lintCmd ?? undefined, testCmd: testCmd ?? undefined } : undefined;

  if (args.verbose && lintTestConfig) {
    if (lintTestConfig.lintCmd) process.stderr.write(`Lint: ${lintTestConfig.lintCmd}\n`);
    if (lintTestConfig.testCmd) process.stderr.write(`Test: ${lintTestConfig.testCmd}\n`);
  }

  // Load hook manager
  const hookManager = HookManager.fromConfigFile(args.hooksConfig);
  if (args.verbose && hookManager.getHooks().length > 0) {
    process.stderr.write(`Hooks: ${hookManager.getHooks().length} registered\n`);
  }

  // Memory-aware effort auto-tuning
  let effort = args.effort;
  if (phrenCtx && args.task) {
    try {
      const tuning = await tuneEffort(args.task, effort, phrenCtx);
      if (tuning.adjusted) {
        effort = tuning.effort;
        if (args.verbose) process.stderr.write(`Effort auto-tuned: ${tuning.reason}\n`);
      }
    } catch { /* best effort */ }
  }

  const agentConfig = {
    provider,
    registry,
    systemPrompt,
    maxTurns: args.maxTurns,
    verbose: args.verbose,
    phrenCtx,
    costTracker,
    plan: args.plan,
    lintTestConfig,
    effort,
    hookManager,
    compactionInstructions: args.compactionInstructions,
  };

  // Register subagent tool (needs agentConfig reference)
  registry.register(createSubagentTool({ parentConfig: agentConfig }));

  // Cleanup helper
  const cleanup = () => {
    mcpCleanup?.();
    shutdownLspServers();
    cancelAllCronTasks();
  };

  // Multi-agent TUI mode
  if (args.multi || args.team) {
    const { AgentSpawner } = await import("./multi/spawner.js");

    if (args.team) {
      // Team mode — run TeamAgent with coordination
      const { TeamCoordinator } = await import("./multi/coordinator.js");
      const { runTeamAgent } = await import("./multi/team-agent.js");
      const spawner = new AgentSpawner();
      const coordinator = new TeamCoordinator(args.team);

      process.on("SIGINT", async () => {
        await spawner.shutdown();
        cleanup();
        process.exit(130);
      });

      try {
        const result = await runTeamAgent(args.task, {
          agentConfig,
          spawner,
          coordinator,
          verbose: args.verbose,
        });

        if (args.verbose) {
          process.stderr.write(
            `\nTeam done: ${result.agentsUsed} agents, ${result.tasksCompleted} tasks completed, ` +
            `${result.tasksFailed} failed, ${result.totalTurns} turns\n`,
          );
        }

        // Save team memory as phren finding
        if (phrenCtx) {
          try {
            const { buildTeamSummary, saveTeamMemory } = await import("./memory/team-memory.js");
            const summary = buildTeamSummary(
              args.team,
              args.task,
              spawner.listAgents(),
              coordinator.getTaskList(),
            );
            await saveTeamMemory(phrenCtx, summary);
          } catch { /* best effort */ }
        }
      } finally {
        await spawner.shutdown();
        if (phrenCtx && sessionId) {
          endSession(phrenCtx, sessionId, scrubSummary("Team session ended"));
        }
        cleanup();
      }
      return;
    }

    // Multi TUI mode (no team coordination)
    const { startMultiTui } = await import("./multi/tui-multi.js");
    const spawner = new AgentSpawner();

    process.on("SIGINT", async () => {
      await spawner.shutdown();
      cleanup();
      process.exit(130);
    });

    await startMultiTui(spawner, agentConfig);
    await spawner.shutdown();
    if (phrenCtx && sessionId) {
      endSession(phrenCtx, sessionId, "Multi-agent session ended");
    }
    cleanup();
    return;
  }

  // Interactive mode — TUI if terminal, fallback to REPL if not
  if (args.interactive) {
    const isTTY = process.stdout.isTTY && process.stdin.isTTY;
    const session = isTTY
      ? await (await import("./tui.js")).startTui(agentConfig)
      : await (await import("./repl.js")).startRepl(agentConfig);

    // Flush anti-patterns at session end
    if (phrenCtx) {
      try { await session.antiPatterns.flushAntiPatterns(phrenCtx); } catch { /* best effort */ }
      try { await evolveProjectContext(phrenCtx, provider, session.messages); } catch { /* best effort */ }
    }

    if (phrenCtx && sessionId) {
      const lastText = session.messages.length > 0 ? "Interactive session ended" : "Empty session";
      endSession(phrenCtx, sessionId, lastText);
    }
    cleanup();
    return;
  }

  // Create initial checkpoint before agent starts
  const initCheckpoint = createCheckpoint(cwd, "pre-agent");
  if (args.verbose && initCheckpoint) {
    process.stderr.write(`Checkpoint: ${initCheckpoint.slice(0, 8)}\n`);
  }

  // SIGINT handler: offer rollback
  process.on("SIGINT", () => {
    process.stderr.write("\nInterrupted. Use --resume to continue later.\n");
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch {}
    }
    cleanup();
    if (phrenCtx && sessionId) {
      endSession(phrenCtx, sessionId, "Interrupted by user");
    }
    process.exit(130);
  });

  // One-shot mode
  try {
    let result;
    if (args.resume && phrenCtx) {
      // Resume: load previous messages and continue
      const prevMessages = loadLastSessionMessages(phrenCtx.phrenPath);
      if (prevMessages && prevMessages.length > 0) {
        if (args.verbose) process.stderr.write(`Resuming session with ${prevMessages.length} messages\n`);
        const contextLimit = provider.contextWindow ?? 200_000;
        const session = createSession(contextLimit);
        session.messages = prevMessages as typeof session.messages;
        const turnResult = await runTurn("Continuing where we left off. Please review the conversation and continue with the task.", session, agentConfig);
        // Save messages for future resume
        saveSessionMessages(phrenCtx.phrenPath, sessionId!, session.messages);
        result = {
          finalText: turnResult.text,
          turns: turnResult.turns,
          toolCalls: turnResult.toolCalls,
          totalCost: agentConfig.costTracker?.formatCost(),
          messages: session.messages,
        };
      } else {
        process.stderr.write("No previous session to resume.\n");
        result = await runAgent(args.task, agentConfig);
      }
    } else {
      result = await runAgent(args.task, agentConfig);
    }

    if (args.verbose) {
      const costStr = result.totalCost ? `, ${result.totalCost}` : "";
      process.stderr.write(`\nDone: ${result.turns} turns, ${result.toolCalls} tool calls${costStr}\n`);
    }

    // Run Stop hooks
    if (agentConfig.hookManager?.hasHooks("Stop")) {
      try {
        await agentConfig.hookManager.runHooks({ event: "Stop" });
      } catch { /* best effort */ }
    }

    // End session with summary + memory intelligence
    if (phrenCtx && sessionId) {
      const summary = scrubSummary(result.finalText.slice(0, 500));
      endSession(phrenCtx, sessionId, summary);

      // Save messages for resume
      saveSessionMessages(phrenCtx.phrenPath, sessionId, result.messages);

      // Evolve project context via lightweight LLM reflection
      try { await evolveProjectContext(phrenCtx, provider, result.messages); } catch { /* best effort */ }
    }
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    if (phrenCtx && sessionId) {
      endSession(phrenCtx, sessionId, `Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    cleanup();
    process.exit(1);
  }

  cleanup();
}

// When run directly (phren-agent binary), parse from process.argv
const isDirectRun = process.argv[1]?.endsWith("/agent/index.js") ||
  process.argv[1]?.endsWith("/agent/index.ts");
if (isDirectRun) {
  runAgentCli(process.argv.slice(2));
}

#!/usr/bin/env node
import { parseArgs, printHelp } from "./config.js";
import { resolveProvider } from "./providers/resolve.js";
import { ToolRegistry } from "./tools/registry.js";
import { readFileTool } from "./tools/read-file.js";
import { writeFileTool } from "./tools/write-file.js";
import { editFileTool } from "./tools/edit-file.js";
import { shellTool, taskOutputTool, taskStopTool } from "./tools/shell.js";
import { globTool } from "./tools/glob.js";
import { grepTool } from "./tools/grep.js";
import { createReadImageTool } from "./tools/read-image.js";
import { modelSupportsVision } from "./models.js";
import { createWebFetchTool } from "./tools/web-fetch.js";
import { createWebSearchTool } from "./tools/web-search.js";
import { createPhrenAddTaskTool } from "./tools/phren-add-task.js";
import { createSkillTool } from "./tools/skill.js";
import { createPhrenSearchTool } from "./tools/phren-search.js";
import { createPhrenFindingTool } from "./tools/phren-finding.js";
import { createPhrenGetTasksTool, createPhrenCompleteTaskTool } from "./tools/phren-tasks.js";
import { gitStatusTool, gitDiffTool, gitCommitTool } from "./tools/git.js";
import { listMcpResourcesTool, readMcpResourceTool } from "./tools/mcp-resources.js";
import { buildPhrenContext, buildContextSnippet } from "./memory/context.js";
import { startSession, endSession, getPriorSummary, saveSessionMessages, loadLastSessionSnapshot } from "./memory/session.js";
import { loadProjectContext, evolveProjectContext } from "./memory/project-context.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { createSession, runTurn } from "./agent-loop.js";
import { SessionLog, seedFromMessages } from "./session/log.js";
import { fileSink, findLatestEventLog, persistFork, restoreSessionLog } from "./session/persist.js";
import type { LlmMessage } from "./providers/types.js";
import { createCostTracker } from "./cost.js";
import { codexLogin, codexLogout } from "./providers/codex-auth.js";
import { createCheckpoint } from "./checkpoint.js";
import { detectLintCommand, detectTestCommand } from "./tools/lint-test.js";
import { connectMcpServers, loadMcpConfig, parseMcpInline, type McpConfigEntry } from "./mcp-client.js";
import { VERSION } from "./package-metadata.js";
import {
  authProfilesPath,
  getAuthStatusEntries,
  removeApiKeyProfile,
  upsertApiKeyProfile,
  type ApiKeyProvider,
} from "@phren/cli/auth/profiles";

function parseApiKeyProvider(raw: string | undefined): ApiKeyProvider | null {
  if (raw === "openai" || raw === "openrouter" || raw === "anthropic") return raw;
  return null;
}

function envVarForApiProvider(provider: ApiKeyProvider): string {
  switch (provider) {
    case "openai":
      return "OPENAI_API_KEY";
    case "openrouter":
      return "OPENROUTER_API_KEY";
    case "anthropic":
      return "ANTHROPIC_API_KEY";
  }
}

function printAuthStatus(): void {
  const entries = getAuthStatusEntries();
  console.log("phren auth");
  console.log(`store: ${authProfilesPath()}`);
  console.log("");
  for (const entry of entries) {
    const status = entry.configured ? "configured" : "not configured";
    const source = entry.source === "none" ? "" : ` via ${entry.source}`;
    const account = entry.accountId ? ` account=${entry.accountId}` : "";
    console.log(`- ${entry.provider}: ${status}${source}${account}`);
  }
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
    if (raw[1] === "status") {
      printAuthStatus();
      process.exit(0);
    }
    if (raw[1] === "set-key") {
      const provider = parseApiKeyProvider(raw[2]);
      if (!provider) {
        console.error("Usage: phren auth set-key <openai|openrouter|anthropic> [key]");
        process.exit(1);
      }
      const key = raw[3] || process.env[envVarForApiProvider(provider)];
      if (!key) {
        console.error(`No API key provided. Pass it as an argument or set ${envVarForApiProvider(provider)}.`);
        process.exit(1);
      }
      upsertApiKeyProfile(provider, key);
      console.log(`Saved ${provider} API key profile to ${authProfilesPath()}`);
      process.exit(0);
    }
    if (raw[1] === "clear-key") {
      const provider = parseApiKeyProvider(raw[2]);
      if (!provider) {
        console.error("Usage: phren auth clear-key <openai|openrouter|anthropic>");
        process.exit(1);
      }
      const removed = removeApiKeyProfile(provider);
      console.log(removed ? `Removed ${provider} API key profile.` : `No ${provider} API key profile was set.`);
      process.exit(0);
    }
    console.error("Usage: phren auth <login|logout|status|set-key|clear-key>");
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
    provider = resolveProvider(args.provider, args.model, args.maxOutput, args.reasoning);
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (args.verbose) {
    process.stderr.write(`Provider: ${provider.name}\n`);
  }

  // Build phren context
  const phrenCtx = await buildPhrenContext(args.project);
  let contextSnippet = "";
  let priorSummary: import("./memory/session.js").PriorSummary | null = null;
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

  const systemPrompt = buildSystemPrompt(contextSnippet, priorSummary, {
    name: provider.name,
    model: (provider as { model?: string }).model,
  });

  // Dry run: print system prompt and exit
  if (args.dryRun) {
    console.log("=== System Prompt ===");
    console.log(systemPrompt);
    console.log("\n=== Task ===");
    console.log(args.task);
    process.exit(0);
  }

  // Register tools
  const registry = new ToolRegistry();
  registry.setPermissions({
    mode: args.permissions,
    allowedPaths: [],
    projectRoot: process.cwd(),
  });
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(editFileTool);
  registry.register(shellTool);
  registry.register(taskOutputTool);
  registry.register(taskStopTool);
  registry.register(globTool);
  registry.register(grepTool);
  if (modelSupportsVision(provider.name, provider.model ?? "")) {
    registry.register(createReadImageTool(provider));
  }

  if (phrenCtx) {
    registry.register(createPhrenSearchTool(phrenCtx));
    registry.register(createPhrenFindingTool(phrenCtx, sessionId));
    registry.register(createPhrenGetTasksTool(phrenCtx));
    registry.register(createPhrenCompleteTaskTool(phrenCtx, sessionId));
    registry.register(createPhrenAddTaskTool(phrenCtx, sessionId));
    registry.register(createSkillTool(phrenCtx));
  }

  // Web tools
  registry.register(createWebFetchTool());
  registry.register(createWebSearchTool());
  registry.register(gitStatusTool);
  registry.register(gitDiffTool);
  registry.register(gitCommitTool);
  registry.register(listMcpResourcesTool);
  registry.register(readMcpResourceTool);

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
  const modelName = (provider as { model?: string }).model ?? args.model ?? provider.name;
  const costTracker = createCostTracker(modelName, args.budget, provider.name);

  // Build lint/test config from CLI flags or auto-detect
  const cwd = process.cwd();
  const lintCmd = args.lintCmd ?? detectLintCommand(cwd);
  const testCmd = args.testCmd ?? detectTestCommand(cwd);
  const lintTestConfig = (lintCmd || testCmd) ? { lintCmd: lintCmd ?? undefined, testCmd: testCmd ?? undefined } : undefined;

  if (args.verbose && lintTestConfig) {
    if (lintTestConfig.lintCmd) process.stderr.write(`Lint: ${lintTestConfig.lintCmd}\n`);
    if (lintTestConfig.testCmd) process.stderr.write(`Test: ${lintTestConfig.testCmd}\n`);
  }

  /** Durable event log for this run when a phren store is available. */
  const makePersistedLog = (): SessionLog | undefined => {
    if (!phrenCtx || !sessionId) return undefined;
    return new SessionLog(
      {
        sessionId,
        project: phrenCtx.project ?? undefined,
        cwd: process.cwd(),
        createdAt: new Date().toISOString(),
      },
      fileSink(phrenCtx.phrenPath, sessionId),
    );
  };

  /**
   * Resume seed: newest event log preferred, legacy v1 snapshot as fallback.
   * MUST run before makePersistedLog(): creating this run's own (empty) log
   * first would make it the newest discovery candidate and shadow the real
   * previous session.
   */
  const makeResumedLog = (): SessionLog | undefined => {
    if (!phrenCtx || !sessionId) return undefined;
    const latest = findLatestEventLog(phrenCtx.phrenPath, phrenCtx.project ?? undefined);
    if (latest) {
      try {
        const parent = restoreSessionLog(phrenCtx.phrenPath, latest);
        if (parent.length > 0) {
          if (args.verbose) {
            process.stderr.write(
              `Resuming session ${parent.header.sessionId.slice(0, 8)} (${parent.header.project ?? "global"}) with ${parent.getMessages().length} messages from its event log\n`,
            );
          }
          // This run gets its own forked log file, seeded with the parent's
          // full history and linked via parentSession.
          return persistFork(phrenCtx.phrenPath, parent, sessionId);
        }
      } catch (err: unknown) {
        process.stderr.write(
          `Cannot resume from event log (${err instanceof Error ? err.message : String(err)}); trying legacy snapshot\n`,
        );
      }
    }
    const priorSnapshot = loadLastSessionSnapshot(phrenCtx.phrenPath, phrenCtx.project ?? undefined);
    if (priorSnapshot && priorSnapshot.messages.length > 0) {
      if (args.verbose) {
        process.stderr.write(
          `Resuming session ${priorSnapshot.sessionId.slice(0, 8)} (${priorSnapshot.project ?? "global"}) with ${priorSnapshot.messages.length} messages from a v1 snapshot\n`,
        );
      }
      const log = makePersistedLog();
      if (!log) return undefined;
      seedFromMessages(log, priorSnapshot.messages as LlmMessage[]);
      return log;
    }
    return undefined;
  };

  const resumedLog = args.resume && !args.interactive && !args.multi && !args.team ? makeResumedLog() : undefined;

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
    sessionId,
    sessionLog: resumedLog ?? makePersistedLog(),
  };

  // Interactive mode — Ink TUI with built-in spawner (--multi and --team also route here)
  if (args.interactive || args.multi || args.team) {
    const isTTY = process.stdout.isTTY && process.stdin.isTTY;
    let session;
    if (!isTTY) {
      session = await (await import("./repl.js")).startRepl(agentConfig);
    } else {
      // Ink TUI with spawner — LLM can spawn agents via spawn_agent tool
      const { AgentSpawner } = await import("./multi/spawner.js");
      const { createSpawnAgentTool, createSendMessageTool, createListAgentsTool } = await import("./tools/spawn-agent.js");
      const spawner = new AgentSpawner();
      registry.register(createSpawnAgentTool(spawner));
      registry.register(createSendMessageTool(spawner));
      registry.register(createListAgentsTool(spawner));
      session = await (await import("./tui/ink-entry.js")).startInkTui(agentConfig, spawner);
      await spawner.shutdown();
    }

    // Flush anti-patterns at session end
    if (phrenCtx) {
      try { await session.antiPatterns.flushAntiPatterns(phrenCtx, sessionId); } catch { /* best effort */ }
      try { await evolveProjectContext(phrenCtx, provider, session.messages); } catch { /* best effort */ }
    }

    if (phrenCtx && sessionId) {
      const lastText = session.messages.length > 0 ? "Interactive session ended" : "Empty session";
      endSession(phrenCtx, sessionId, lastText);
      saveSessionMessages(phrenCtx.phrenPath, sessionId, session.messages, phrenCtx.project ?? undefined);
    }
    mcpCleanup?.();
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
    mcpCleanup?.();
    if (phrenCtx && sessionId) {
      endSession(phrenCtx, sessionId, "Interrupted by user");
    }
    process.exit(130);
  });

  // One-shot mode
  // Subagent tools are available by default (disable with --no-subagents);
  // children run headless with auto-confirm permissions and exit when the
  // parent's IPC channel closes.
  let oneShotSpawner: import("./multi/spawner.js").AgentSpawner | undefined;
  if (!args.noSubagents) {
    const { AgentSpawner } = await import("./multi/spawner.js");
    const { createSpawnAgentTool, createSendMessageTool, createListAgentsTool } = await import("./tools/spawn-agent.js");
    oneShotSpawner = new AgentSpawner();
    registry.register(createSpawnAgentTool(oneShotSpawner));
    registry.register(createSendMessageTool(oneShotSpawner));
    registry.register(createListAgentsTool(oneShotSpawner));
  }

  try {
    const contextLimit = provider.contextWindow ?? 200_000;

    let result;
    if (args.resume && !resumedLog) {
      process.stderr.write("No previous session to resume.\n");
    }
    if (resumedLog) {
      const session = createSession(contextLimit, { log: resumedLog });
      const turnResult = await runTurn("Continuing where we left off. Please review the conversation and continue with the task.", session, agentConfig);
      result = {
        finalText: turnResult.text,
        turns: turnResult.turns,
        toolCalls: turnResult.toolCalls,
        totalCost: agentConfig.costTracker?.formatCost(),
        messages: session.messages,
        session,
      };
    } else {
      const session = createSession(contextLimit, { log: agentConfig.sessionLog });
      const turnResult = await runTurn(args.task, session, agentConfig);
      result = {
        finalText: turnResult.text,
        turns: turnResult.turns,
        toolCalls: turnResult.toolCalls,
        totalCost: agentConfig.costTracker?.formatCost(),
        messages: session.messages,
        session,
      };
    }

    if (args.verbose) {
      const costStr = result.totalCost ? `, ${result.totalCost}` : "";
      process.stderr.write(`\nDone: ${result.turns} turns, ${result.toolCalls} tool calls${costStr}\n`);
    }

    process.stdout.write("\x07"); // bell on completion

    // End session with summary + memory intelligence
    if (phrenCtx && sessionId) {
      const summary = result.finalText.slice(0, 500);
      endSession(phrenCtx, sessionId, summary);

      // Save messages for resume
      saveSessionMessages(phrenCtx.phrenPath, sessionId, result.messages, phrenCtx.project ?? undefined);

      // Flush anti-patterns (interactive mode does this too; one-shot was missing it)
      try { await result.session.antiPatterns.flushAntiPatterns(phrenCtx, sessionId); } catch { /* best effort */ }

      // Evolve project context via lightweight LLM reflection
      try { await evolveProjectContext(phrenCtx, provider, result.messages); } catch { /* best effort */ }
    }
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    if (phrenCtx && sessionId) {
      endSession(phrenCtx, sessionId, `Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    try { await oneShotSpawner?.shutdown(); } catch { /* children exit with the IPC channel */ }
    mcpCleanup?.();
    process.exit(1);
  }

  try { await oneShotSpawner?.shutdown(); } catch { /* children exit with the IPC channel */ }
  mcpCleanup?.();
}

// When run directly (phren-agent binary), parse from process.argv
const isDirectRun = process.argv[1]?.endsWith("/agent/index.js") ||
  process.argv[1]?.endsWith("/agent/index.ts");
if (isDirectRun) {
  runAgentCli(process.argv.slice(2));
}

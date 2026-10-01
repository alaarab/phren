#!/usr/bin/env node
import { parseArgs, printHelp, resolveStartupPermissions } from "./config.js";
import { loadPersistentAllowlist } from "./permissions/allowlist.js";
import { loadPermissionRules } from "./permissions/rules.js";
import { keepSessionEndpoint, resolveProvider } from "./providers/resolve.js";
import { ToolRegistry } from "./tools/registry.js";
import { readFileTool } from "./tools/read-file.js";
import { writeFileTool } from "./tools/write-file.js";
import { editFileTool, multiEditTool } from "./tools/edit-file.js";
import { applyPatchTool } from "./tools/apply-patch.js";
import { createShellTool, taskOutputTool, taskStopTool } from "./tools/shell.js";
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
import { updatePlanTool } from "./tools/update-plan.js";
import { listMcpResourcesTool, readMcpResourceTool } from "./tools/mcp-resources.js";
import { buildPhrenContext, buildContextSnippet, buildProjectInstructions } from "./memory/context.js";
import { buildChatMemory, buildChatSystemPrompt } from "./memory/chat.js";
import { livePreview, previewPath, removeStalePreviews } from "./session/preview.js";
import { startSession, endSession, getPriorSummary, saveSessionMessages, loadLastSessionSnapshot, writeSessionNote } from "./memory/session.js";
import { emitHerdrHook, setHerdrHookSession } from "./herdr-hooks.js";
import { loadProjectContext, evolveProjectContext } from "./memory/project-context.js";
import { buildSystemPrompt, buildEnvironmentBlock } from "./system-prompt.js";
import { loadHooksConfig } from "./user-hooks.js";
import { loadAndRegisterCustomCommands, getCustomCommandInfos } from "./commands.js";
import { createSession, runTurn, type AgentConfig } from "./agent-loop.js";
import { SessionLog, seedFromMessages } from "./session/log.js";
import { fileSink, findEventLogById, findLatestEventLog, listEventLogs, persistFork, restoreSessionLog } from "./session/persist.js";
import { buildHeadlessResult, createHeadlessHooks, headlessExitCode, readStdin, type HeadlessResult } from "./headless.js";
import type { LlmMessage } from "./providers/types.js";
import { createCostTracker } from "./cost.js";
import { scopeModelOverrides } from "./model-overrides.js";
import { codexLogin, codexLogout } from "./providers/codex-auth.js";
import { createCheckpoint } from "./checkpoint.js";
import { detectLintCommand, detectTestCommand } from "./tools/lint-test.js";
import { connectMcpServers, loadDefaultMcpConfig, loadMcpConfig, parseMcpInline, type McpConfigEntry } from "./mcp-client.js";
import { isMcpProjectTrusted, trustMcpProject } from "./settings.js";
import * as os from "os";
import * as path from "path";
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

  let args;
  try {
    args = parseArgs(raw);
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  resolveStartupPermissions(args);
  loadPersistentAllowlist(process.cwd());

  if (args.help) { printHelp(); process.exit(0); }
  if (args.version) { console.log(`phren-agent v${VERSION}`); process.exit(0); }
  // Model switches resolve the provider again; they read the endpoint from
  // the environment. The window and prices stay with the model they were
  // given for (scopeModelOverrides, below).
  if (args.baseUrl) process.env.PHREN_AGENT_BASE_URL = args.baseUrl;

  if (args.listSessions) {
    const ctx = await buildPhrenContext(args.project);
    if (!ctx) {
      console.error("Sessions are stored in the phren store; none was found.");
      process.exit(1);
    }
    const sessions = listEventLogs(ctx.phrenPath, { project: args.project ?? undefined, limit: 20 });
    if (args.outputFormat === "json") {
      console.log(JSON.stringify(sessions.map(({ file: _file, ...rest }) => ({ ...rest, updatedAt: new Date(rest.mtimeMs).toISOString() })), null, 2));
    } else if (sessions.length === 0) {
      console.log("No sessions.");
    } else {
      for (const s of sessions) {
        const when = new Date(s.mtimeMs).toISOString().replace("T", " ").slice(0, 16);
        console.log(`${s.sessionId.slice(0, 12)}  ${when}  ${String(s.messages).padStart(4)} msgs  ${s.project ?? "-"}  ${s.title}`);
      }
      console.log("\nResume one with: phren-agent --session <id>");
    }
    process.exit(0);
  }

  // Headless with no task argument: read the task from piped stdin.
  if (args.print && !args.task && !process.stdin.isTTY) {
    args.task = (await readStdin()).trim();
  }
  if (args.print) {
    args.interactive = false;
    args.multi = false;
  }
  const chat = args.mode === "chat";
  if (chat && (args.multi || args.team)) {
    console.error("--mode chat is a single conversation; it cannot run with --multi or --team.");
    process.exit(1);
  }

  // `--resume` alone continues the prior session without a placeholder task
  const userTask = args.task;
  if (!args.task && args.resume) {
    args.task = "Continue where the previous session left off.";
  }
  if (!args.task && !args.interactive && !args.multi && !args.team) {
    console.error("Usage: phren-agent <task>\nRun phren-agent --help for more info.");
    process.exit(1);
  }

  // Resolve LLM provider
  let provider;
  try {
    provider = resolveProvider(args.provider, args.model, args.maxOutput, args.reasoning, { baseUrl: args.baseUrl, contextWindow: args.contextWindow });
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  keepSessionEndpoint(provider);
  scopeModelOverrides((provider as { model?: string }).model ?? args.model ?? provider.name, {
    contextWindow: args.contextWindow,
    priceIn: args.priceIn,
    priceOut: args.priceOut,
    priceCache: args.priceCache,
  });

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

    // Review-queue surfacing. Interactive sessions get expiry + a triage
    // banner; one-shot runs get a count only and never mutate the queue.
    // A quick chat skips it: it cannot act on the queue.
    if (phrenCtx.project && !chat) {
      try {
        const { getQueueStatus, formatQueueBanner, formatExpiryNotice, expireStaleItems, resolveExpireDays } =
          await import("./memory/review-triage.js");
        if (args.interactive || args.multi || args.team) {
          const expireDays = resolveExpireDays();
          const notice = formatExpiryNotice(expireStaleItems(phrenCtx, expireDays));
          if (notice) {
            process.stderr.write(`\x1b[2m[${notice} — older than ${expireDays}d]\x1b[0m\n`);
          }
          const banner = formatQueueBanner(getQueueStatus(phrenCtx, 3));
          if (banner) process.stderr.write(`\x1b[33m${banner}\x1b[0m\n`);
        } else {
          const { pending } = getQueueStatus(phrenCtx, 0);
          if (pending > 0) {
            process.stderr.write(`\x1b[2m[review queue: ${pending} pending — run phren-agent -i, then /review]\x1b[0m\n`);
          }
        }
      } catch { /* best effort */ }
    }

    // A quick chat reads its memory from files below; the agent's snippet
    // builds the search index, which is what makes a first answer slow.
    if (!chat) {
      contextSnippet = await buildContextSnippet(phrenCtx, args.task);
      priorSummary = getPriorSummary(phrenCtx);
    }
    sessionId = startSession(phrenCtx);
    // Inside a Herdr pane, tell Phren Hook which event log is this pane's.
    setHerdrHookSession(sessionId);
    emitHerdrHook("SessionStart");

    // Load evolved project context for warm start
    const projectCtx = chat ? null : loadProjectContext(phrenCtx);
    if (projectCtx) {
      contextSnippet += `\n\n## Agent context (${phrenCtx.project})\n\n${projectCtx}`;
    }
  }

  // Without a phren store, the repo's AGENTS.md / CLAUDE.md still apply.
  if (!phrenCtx && !chat) contextSnippet = buildProjectInstructions();

  loadAndRegisterCustomCommands(process.cwd());

  const chatMemory = chat ? buildChatMemory(phrenCtx) : "";
  const providerInfo = { name: provider.name, model: (provider as { model?: string }).model };
  // The environment block is built once so the prompt stays byte-stable
  // across rebuilds (provider prompt caching).
  const environment = buildEnvironmentBlock(process.cwd());
  let promptContext = contextSnippet;
  let promptSummary = priorSummary;
  const mcpServerNames: string[] = [];
  // Built from the tools registered right now: call again after registering more.
  const agentPrompt = (info: { name: string; model?: string }) =>
    buildSystemPrompt(promptContext, promptSummary, info, getCustomCommandInfos(), {
      toolNames: registry.toolNames(),
      mcpServers: mcpServerNames,
      environment,
    });

  // Register tools
  const registry = new ToolRegistry();
  registry.hookConfig = loadHooksConfig(process.cwd());
  registry.setPermissions({
    mode: args.permissions,
    allowedPaths: [],
    projectRoot: process.cwd(),
    sandboxMode: args.sandbox,
    rules: loadPermissionRules(process.cwd(), { allow: args.allowedTools, deny: args.disallowedTools }),
  });
  // Nobody can answer a prompt in a headless run or with stdin not a
  // terminal (a readline question on a closed stdin would hang): deny, and
  // say how to allow.
  let permissionDenials = 0;
  if (args.print || (!process.stdin.isTTY && !args.interactive && !args.multi && !args.team)) {
    registry.askUser = async (toolName, _input, reason) => {
      permissionDenials++;
      process.stderr.write(
        `[denied ${toolName}: ${reason} No one is present to approve; allow it with --allowedTools "${toolName}", --permissions auto-confirm or --yolo.]\n`,
      );
      return false;
    };
  }
  // The agent's tools. A quick chat starts with none and gets them on /promote.
  let mcpCleanup: (() => void) | undefined;
  const registerAgentTools = async () => {
    registry.register(readFileTool);
    registry.register(writeFileTool);
    registry.register(editFileTool);
    registry.register(multiEditTool);
    registry.register(applyPatchTool);
    // Live-config factory: /permissions and sandbox mode changes apply per call
    registry.register(createShellTool(() => registry.permissionConfig));
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
    registry.register(updatePlanTool);
    registry.register(listMcpResourcesTool);
    registry.register(readMcpResourceTool);

    // MCP server connections
    const mcpServers: Record<string, McpConfigEntry> = {};
    if (!args.strictMcpConfig) {
      if (args.trustProjectMcp) trustMcpProject(process.cwd());
      const defaults = loadDefaultMcpConfig(process.cwd(), { home: os.homedir(), trusted: isMcpProjectTrusted(process.cwd()) });
      Object.assign(mcpServers, defaults.servers);
      for (const { file, names } of defaults.untrusted) {
        process.stderr.write(`\x1b[2m[${path.relative(process.cwd(), file)} defines MCP servers (${names.join(", ")}) that were not started; run with --trust-project-mcp to load this project's servers]\x1b[0m\n`);
      }
    }
    if (args.mcpConfig) {
      Object.assign(mcpServers, loadMcpConfig(args.mcpConfig));
    }
    for (let idx = 0; idx < args.mcp.length; idx++) {
      const entry = parseMcpInline(args.mcp[idx]);
      mcpServers[`mcp-${idx}`] = entry;
    }
    if (Object.keys(mcpServers).length > 0 && !args.dryRun) {
      mcpServerNames.push(...Object.keys(mcpServers));
      const { tools: mcpTools, cleanup } = await connectMcpServers(mcpServers, args.verbose);
      mcpCleanup = cleanup;
      for (const tool of mcpTools) registry.register(tool);
    }
  };
  if (!chat) await registerAgentTools();

  // The prompt lists the registered tools, so it is built after they are.
  const systemPrompt = chat
    ? buildChatSystemPrompt(chatMemory, providerInfo)
    : agentPrompt(providerInfo);

  // Dry run: print system prompt and exit
  if (args.dryRun) {
    console.log("=== System Prompt ===");
    console.log(systemPrompt);
    console.log("\n=== Task ===");
    console.log(args.task);
    process.exit(0);
  }

  // Build cost tracker from model info
  const modelName = (provider as { model?: string }).model ?? args.model ?? provider.name;
  const costTracker = createCostTracker(modelName, args.budget, provider.name, provider.baseUrl);

  // Build lint/test config from CLI flags or auto-detect
  const cwd = process.cwd();
  const detectLintTest = () => {
    const lintCmd = args.lintCmd ?? detectLintCommand(cwd);
    const testCmd = args.testCmd ?? detectTestCommand(cwd);
    return (lintCmd || testCmd) ? { lintCmd: lintCmd ?? undefined, testCmd: testCmd ?? undefined } : undefined;
  };
  // A chat edits nothing, so it has nothing to check.
  const lintTestConfig = chat ? undefined : detectLintTest();

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
    let latest: string | null;
    if (args.resumeId) {
      try {
        latest = findEventLogById(phrenCtx.phrenPath, args.resumeId);
      } catch (err: unknown) {
        process.stderr.write(`Cannot resume: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    } else {
      latest = findLatestEventLog(phrenCtx.phrenPath, phrenCtx.project ?? undefined);
    }
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
    if (args.resumeId) return undefined; // a named session never falls back to another one
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

  const resumedLog = args.resume ? makeResumedLog() : undefined;

  /** Spawner tools, once an interactive session has a spawner. */
  let registerSpawnerTools: (() => void) | undefined;
  const agentConfig: AgentConfig = {
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
    hookConfig: registry.hookConfig,
    sessionLog: resumedLog ?? makePersistedLog(),
    ...(args.noLlmCompact ? { compaction: { enabled: false } } : {}),
    mode: args.mode,
  };
  // The phone reads the reply being written from a sidecar of the event log.
  if (phrenCtx && agentConfig.sessionLog && (args.interactive || args.multi || args.team)) {
    const phrenPath = phrenCtx.phrenPath;
    removeStalePreviews(phrenPath);
    agentConfig.livePreview = (id) => id.startsWith("mem-") ? undefined : livePreview(previewPath(phrenPath, id));
  }
  if (!chat) agentConfig.rebuildSystemPrompt = agentPrompt;
  if (chat) {
    agentConfig.rebuildSystemPrompt = (info) => buildChatSystemPrompt(chatMemory, info);
    // Same conversation, same log: only the tools and the prompt change.
    // Nothing about the session changes until every step has succeeded; a
    // failure (an MCP server that won't start) leaves it a working chat.
    agentConfig.promote = async () => {
      if (agentConfig.mode !== "chat") return "Already an agent session.";
      const before = new Set(registry.toolNames());
      try {
        await registerAgentTools();
        registerSpawnerTools?.();
        let snippet = phrenCtx ? await buildContextSnippet(phrenCtx, "") : buildProjectInstructions();
        const projectCtx = phrenCtx ? loadProjectContext(phrenCtx) : null;
        if (phrenCtx && projectCtx) snippet += `\n\n## Agent context (${phrenCtx.project})\n\n${projectCtx}`;
        promptContext = snippet;
        promptSummary = null;
        const info = { name: agentConfig.provider.name, model: (agentConfig.provider as { model?: string }).model };
        const systemPrompt = agentPrompt(info);
        const lintTestConfig = detectLintTest();
        agentConfig.mode = "agent";
        agentConfig.rebuildSystemPrompt = agentPrompt;
        agentConfig.systemPrompt = systemPrompt;
        agentConfig.lintTestConfig = lintTestConfig;
      } catch (err: unknown) {
        for (const name of registry.toolNames()) if (!before.has(name)) registry.remove(name);
        mcpCleanup?.();
        mcpCleanup = undefined;
        throw err;
      }
      return `Promoted to a phren agent with ${registry.toolNames().length} tools; the conversation continues.`;
    };
  }

  // Interactive mode — Ink TUI with built-in spawner (--multi and --team also route here)
  if (args.interactive || args.multi || args.team) {
    const isTTY = process.stdout.isTTY && process.stdin.isTTY;
    let session;
    if (!isTTY) {
      session = await (await import("./repl.js")).startRepl(agentConfig);
    } else {
      // The phren splash (mascot + wordmark reveal) before the TUI mounts.
      // Cosmetic only: any failure is swallowed, and PHREN_INTRO=off skips it.
      if (process.env.PHREN_INTRO !== "off" && !chat) {
        try {
          const { playSplash } = await import("@phren/cli/shell/intro");
          const model = (provider as { model?: string }).model;
          await playSplash({
            version: VERSION,
            tagline: `agent · ${provider.name}${model ? ` · ${model}` : ""}`,
            hint: "starting agent…",
            reveal: true,
            dwellMs: 600,
            fullscreen: true,
          });
        } catch { /* best effort */ }
      }
      // Ink TUI with spawner — LLM can spawn agents via spawn_agent tool
      const { AgentSpawner } = await import("./multi/spawner.js");
      const { createSpawnAgentTool, createSendMessageTool, createListAgentsTool } = await import("./tools/spawn-agent.js");
      const spawner = new AgentSpawner({ costTracker, getPermissionDefaults: () => registry.permissionConfig, getParentProvider: () => agentConfig.provider });
      registerSpawnerTools = () => {
        registry.register(createSpawnAgentTool(spawner, () => registry.permissionConfig));
        registry.register(createSendMessageTool(spawner));
        registry.register(createListAgentsTool(spawner));
      };
      if (!chat) {
        registerSpawnerTools();
        agentConfig.systemPrompt = agentPrompt(providerInfo);
      }
      // Publish this process's agents so a phren graph in another terminal can
      // show them. Best-effort and silent: it is a courtesy to another tool.
      const { createAgentPublisher } = await import("./multi/publish.js");
      const publisher = createAgentPublisher(phrenCtx?.phrenPath);
      const republish = () => publisher.publish(spawner.listAgents());
      spawner.on("status", republish);
      spawner.on("done", republish);
      republish();
      try {
        session = await (await import("./tui/ink-entry.js")).startInkTui(agentConfig, spawner);
      } finally {
        publisher.stop();
      }
      await spawner.shutdown();
    }

    // Flush anti-patterns at session end. A chat that stayed one ran no
    // tools and gets no reflection call.
    if (phrenCtx && agentConfig.mode !== "chat") {
      try { await session.antiPatterns.flushAntiPatterns(phrenCtx, sessionId); } catch { /* best effort */ }
      try { await evolveProjectContext(phrenCtx, provider, session.messages, { sessionId }); } catch { /* best effort */ }
    }

    if (phrenCtx && sessionId) {
      const lastText = session.messages.length > 0 ? "Interactive session ended" : "Empty session";
      endSession(phrenCtx, sessionId, lastText);
      saveSessionMessages(phrenCtx.phrenPath, sessionId, session.messages, phrenCtx.project ?? undefined);
      if (session.messages.length > 0) {
        writeSessionNote(phrenCtx, {
          sessionId,
          task: "interactive session",
          outcome: `${session.messages.length} messages, ${session.toolCalls} tool calls`,
        });
      }
    }
    mcpCleanup?.();
    return;
  }

  // Create initial checkpoint before agent starts
  const initCheckpoint = chat ? null : createCheckpoint(cwd, "pre-agent");
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
  if (!args.noSubagents && !chat) {
    const { AgentSpawner } = await import("./multi/spawner.js");
    const { createSpawnAgentTool, createSendMessageTool, createListAgentsTool } = await import("./tools/spawn-agent.js");
    oneShotSpawner = new AgentSpawner({ costTracker, getPermissionDefaults: () => registry.permissionConfig, getParentProvider: () => agentConfig.provider });
    registry.register(createSpawnAgentTool(oneShotSpawner, () => registry.permissionConfig));
    registry.register(createSendMessageTool(oneShotSpawner));
    registry.register(createListAgentsTool(oneShotSpawner));
    agentConfig.systemPrompt = agentPrompt(providerInfo);
  }

  const startedAt = Date.now();
  const headlessHooks = args.print
    ? createHeadlessHooks({ format: args.outputFormat, verbose: args.verbose, write: (line) => process.stdout.write(`${line}\n`) })
    : undefined;
  const modelId = (provider as { model?: string }).model ?? null;
  const emitHeadless = (result: HeadlessResult) => {
    if (args.outputFormat === "text") {
      if (result.result) process.stdout.write(result.result.endsWith("\n") ? result.result : `${result.result}\n`);
      if (result.is_error) process.stderr.write(`[${result.subtype}${result.error ? `: ${result.error}` : ""}]\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  };
  if (args.print && args.outputFormat === "stream-json") {
    process.stdout.write(`${JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: sessionId,
      provider: provider.name,
      model: modelId,
      cwd,
      permission_mode: args.permissions,
      tools: registry.toolNames(),
    })}\n`);
  }

  let exitCode = 0;
  try {
    const contextLimit = provider.contextWindow ?? 200_000;

    if (args.resume && !resumedLog) {
      process.stderr.write("No previous session to resume.\n");
    }
    // A resumed session continues with the task given on the command line,
    // or with a generic "continue" when none was.
    const prompt = resumedLog && !userTask
      ? "Continuing where we left off. Please review the conversation and continue with the task."
      : args.task;
    const session = createSession(contextLimit, { log: resumedLog ?? agentConfig.sessionLog });
    emitHerdrHook("UserPromptSubmit");
    const turnResult = await runTurn(prompt, session, agentConfig, headlessHooks).finally(() => emitHerdrHook("Stop"));
    const result = {
      finalText: turnResult.text,
      turns: turnResult.turns,
      toolCalls: turnResult.toolCalls,
      totalCost: agentConfig.costTracker?.formatCost(),
      messages: session.messages,
      session,
    };

    if (args.verbose) {
      const costStr = result.totalCost ? `, ${result.totalCost}` : "";
      process.stderr.write(`\nDone: ${result.turns} turns, ${result.toolCalls} tool calls${costStr}\n`);
    }

    if (args.print) {
      const headless = buildHeadlessResult({
        text: turnResult.text,
        stopReason: turnResult.stopReason,
        turns: turnResult.turns,
        toolCalls: turnResult.toolCalls,
        startedAt,
        sessionId,
        provider: provider.name,
        model: modelId,
        costTracker,
        permissionDenials,
      });
      emitHeadless(headless);
      exitCode = headlessExitCode(headless);
    } else if (process.stdout.isTTY) {
      process.stdout.write("\x07"); // bell on completion; never into a pipe
    }

    // End session with summary + memory intelligence
    if (phrenCtx && sessionId) {
      const summary = result.finalText.slice(0, 500);
      endSession(phrenCtx, sessionId, summary);

      // Save messages for resume
      saveSessionMessages(phrenCtx.phrenPath, sessionId, result.messages, phrenCtx.project ?? undefined);

      if (!chat) {
        // Flush anti-patterns (interactive mode does this too; one-shot was missing it)
        try { await result.session.antiPatterns.flushAntiPatterns(phrenCtx, sessionId); } catch { /* best effort */ }

        // Evolve project context via lightweight LLM reflection (also routes
        // extracted knowledge through the graduated confidence pipeline)
        try { await evolveProjectContext(phrenCtx, provider, result.messages, { sessionId }); } catch { /* best effort */ }
      }

      // Mirror the session into a searchable (non-injectable) note
      writeSessionNote(phrenCtx, { sessionId, task: args.task, outcome: result.finalText });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (args.print) {
      emitHeadless(buildHeadlessResult({
        text: "",
        stopReason: "error",
        turns: 0,
        toolCalls: 0,
        startedAt,
        sessionId,
        provider: provider.name,
        model: modelId,
        costTracker,
        permissionDenials,
        error: message,
      }));
      if (args.outputFormat !== "text") {
        // The error is in the JSON; keep stderr for humans too.
        process.stderr.write(`${message}\n`);
      }
    } else {
      console.error(message);
    }
    if (phrenCtx && sessionId) {
      endSession(phrenCtx, sessionId, `Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    try { await oneShotSpawner?.shutdown(); } catch { /* children exit with the IPC channel */ }
    mcpCleanup?.();
    process.exit(1);
  }

  try { await oneShotSpawner?.shutdown(); } catch { /* children exit with the IPC channel */ }
  mcpCleanup?.();
  if (exitCode !== 0) process.exit(exitCode);
}

// When run directly (phren-agent binary), parse from process.argv
const isDirectRun = process.argv[1]?.endsWith("/agent/index.js") ||
  process.argv[1]?.endsWith("/agent/index.ts");
if (isDirectRun) {
  runAgentCli(process.argv.slice(2));
}

#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as fs from "fs";
import * as path from "path";
import {
  findPhrenPathWithArg,
  debugLog,
  runtimeDir,
} from "./shared.js";
import { log as structuredLog, logWarn } from "./logger.js";
import {
  buildIndex,
  updateFileInIndex as updateFileInIndexFn,
} from "./shared-index.js";
import { runCustomHooks } from "./hooks.js";
import { register as registerSearch } from "./mcp-search.js";
import { register as registerTask } from "./mcp-tasks.js";
import { register as registerFinding } from "./mcp-finding.js";
import { register as registerMemory } from "./mcp-memory.js";
import { register as registerData } from "./mcp-data.js";
import { register as registerGraph } from "./mcp-graph.js";
import { register as registerSession } from "./mcp-session.js";
import { register as registerOps } from "./mcp-ops.js";
import { register as registerSkills } from "./mcp-skills.js";
import { register as registerHooks } from "./mcp-hooks.js";
import { register as registerExtract } from "./mcp-extract.js";
import { register as registerConfig } from "./mcp-config.js";
import type { McpContext, RegisterOptions } from "./mcp-types.js";
import { mcpResponse } from "./mcp-types.js";
import { z } from "zod";
import { errorMessage } from "./utils.js";
import { runTopLevelCommand } from "./entrypoint.js";
import { startEmbeddingWarmup } from "./startup-embedding.js";
import { resolveRuntimeProfile } from "./runtime-profile.js";
import { VERSION as PACKAGE_VERSION } from "./package-metadata.js";

const handledTopLevelCommand = await runTopLevelCommand(process.argv.slice(2));

// MCP mode: first non-flag arg is the phren path. Resolve it lazily so CLI commands
// like `maintain` are not misinterpreted as a filesystem path after the command has run.
const phrenArg = handledTopLevelCommand ? undefined : process.argv.find((a, i) => i >= 2 && !a.startsWith("-"));
const phrenPath = handledTopLevelCommand ? "" : findPhrenPathWithArg(phrenArg);

const STALE_LOCK_MS = 120_000; // 2 min — slightly above EXEC_TIMEOUT_MS (30s) to avoid blocking healthy writers

function cleanStaleLocks(phrenPath: string): void {
  const dir = runtimeDir(phrenPath);
  try {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".lock")) continue;
      const lockPath = path.join(dir, entry);
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          fs.unlinkSync(lockPath);
          debugLog(`Cleaned stale lock: ${entry}`);
        }
      } catch (err: unknown) {
        logWarn("cleanStaleLocks", `statFile: ${errorMessage(err)}`);
      }
    }
  } catch (err: unknown) {
    logWarn("cleanStaleLocks", `readdir: ${errorMessage(err)}`);
  }
}

async function main() {
  const profile = resolveRuntimeProfile(phrenPath);
  cleanStaleLocks(phrenPath);
  let db: Awaited<ReturnType<typeof buildIndex>> | null = null;
  let indexReady = false;
  try {
    db = await buildIndex(phrenPath, profile);
    indexReady = true;

    // Load embedding cache and kick off background embedding (fire-and-forget)
    const { getEmbeddingCache } = await import("./shared-embedding-cache.js");
    const embCache = getEmbeddingCache(phrenPath);
    void startEmbeddingWarmup(db, embCache);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    structuredLog("error", "startup", `Failed to build phren index: ${msg}`);
    console.error("Failed to build phren index at startup:", error);
    process.exit(1);
  }
  let writeQueue: Promise<void> = Promise.resolve();
  let writeQueueDepth = 0;
  const MAX_QUEUE_DEPTH = 50;
  const WRITE_TIMEOUT_MS = 30_000;
  async function rebuildIndex() {
    runCustomHooks(phrenPath, "pre-index");
    indexReady = false;
    try { db?.close(); } catch (err: unknown) {
      logWarn("rebuildIndex", `dbClose: ${errorMessage(err)}`);
    }
    db = await buildIndex(phrenPath, profile);
    indexReady = true;
    runCustomHooks(phrenPath, "post-index");
  }
  async function withWriteQueue<T>(fn: () => Promise<T>): Promise<T | { content: { type: "text"; text: string }[] }> {
    if (writeQueueDepth >= MAX_QUEUE_DEPTH) {
      throw new Error(`Write queue full (${MAX_QUEUE_DEPTH} items). Try again shortly.`);
    }
    writeQueueDepth++;
    const run = writeQueue.then(async () => {
      try {
        return await Promise.race([
          fn(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Write timeout after 30s")), WRITE_TIMEOUT_MS))
        ]);
      } catch (err: unknown) {
        const message = errorMessage(err);
        if (message.includes("Write timeout") || message.includes("Write queue full")) {
          debugLog(`Write queue timeout: ${message}`);
          return mcpResponse({ ok: false, error: `Write queue timeout: ${message}`, errorCode: "TIMEOUT" });
        }
        throw err;
      } finally {
        writeQueueDepth = Math.max(0, writeQueueDepth - 1);
      }
    });
    writeQueue = run.then(() => undefined).catch((error): void => {
      try {
        const message = error instanceof Error
          ? error.stack || error.message
          : String(error);
        debugLog(`Write queue error: ${message}`);
      } catch (logError: unknown) {
        const message = logError instanceof Error ? logError.message : String(logError);
        structuredLog("error", "write-queue", `Failed to log write queue error: ${message}`);
      }
    });
    return run;
  }

  const server = new McpServer({
    name: "phren-mcp",
    version: PACKAGE_VERSION,
  });

  // Track MCP tool calls for telemetry (opt-in only, best-effort)
  const { trackToolCall } = await import("./telemetry.js");
  const origRegisterTool = server.registerTool.bind(server);
  type RegisterToolFn = typeof server.registerTool;
  type RegisterToolArgs = Parameters<RegisterToolFn>;
  type RegisterToolName = RegisterToolArgs[0];
  type RegisterToolConfig = RegisterToolArgs[1];
  type RegisterToolHandler = (...args: unknown[]) => unknown;
  server.registerTool = function (name: RegisterToolName, config: RegisterToolConfig, handler: RegisterToolHandler) {
    const registeredName = name;
    const wrapped = async (...args: unknown[]) => {
      if (!indexReady || !db) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: false,
              error: "Index unavailable - check phren setup",
            }, null, 2),
          }],
        };
      }
      try { trackToolCall(phrenPath, registeredName); } catch (err: unknown) {
        logWarn("trackToolCall", errorMessage(err));
      }
      return handler(...args);
    };
    return origRegisterTool(registeredName, config, wrapped as RegisterToolArgs[2]);
  } as typeof server.registerTool;

  // Register all tool handlers from domain modules
  const ctx: McpContext = {
    phrenPath,
    profile,
    db: () => {
      if (!db) throw new Error("Index unavailable - check phren setup");
      return db;
    },
    rebuildIndex,
    withWriteQueue,
    updateFileInIndex: (filePath: string) => {
      if (!db) throw new Error("Index unavailable - check phren setup");
      updateFileInIndexFn(db, filePath, phrenPath);
    },
  };

  // Register only core tools at startup (~20 tools) for a lighter initial footprint.
  // Agents can unlock additional tool domains on demand via the unlock_tools meta-tool.
  const coreOnly: RegisterOptions = { tier: new Set(["core"]) };

  registerSearch(server, ctx, coreOnly);
  registerTask(server, ctx, coreOnly);
  registerFinding(server, ctx, coreOnly);
  registerMemory(server, ctx, coreOnly);
  registerData(server, ctx, coreOnly);
  registerGraph(server, ctx, coreOnly);
  registerSession(server, ctx, coreOnly);
  registerOps(server, ctx, coreOnly);
  registerSkills(server, ctx, coreOnly);
  registerHooks(server, ctx, coreOnly);
  registerExtract(server, ctx, coreOnly);
  registerConfig(server, ctx, coreOnly);

  // ── unlock_tools meta-tool ──────────────────────────────────────────────
  // Maps domain names to the register functions that provide those tools.
  const DOMAIN_REGISTER_MAP: Record<string, Array<(server: McpServer, ctx: McpContext, options?: RegisterOptions) => void>> = {
    bulk: [registerTask, registerFinding],
    lifecycle: [registerFinding, registerSearch],
    graph: [registerGraph],
    skills: [registerSkills],
    hooks: [registerHooks],
    config: [registerConfig],
    data: [registerData],
    review: [registerOps],
    extract: [registerExtract],
    search: [registerSearch],
    tasks: [registerTask],
    findings: [registerFinding],
    session: [registerSession],
    memory: [registerMemory],
    ops: [registerOps],
  };

  const unlockedDomains = new Set<string>();
  const calledRegisterFns = new Set<Function>();

  // Use origRegisterTool to bypass the indexReady guard — unlock_tools
  // only registers tool domains and never touches the search index.
  origRegisterTool(
    "unlock_tools",
    {
      title: "◆ phren · unlock tools",
      description:
        "Unlock additional tool domains beyond the ~20 core tools registered at startup. " +
        "Available domains: " +
        "\"all\" (unlock everything), " +
        "\"bulk\" (add_tasks, complete_tasks, remove_tasks, add_findings, remove_findings), " +
        "\"lifecycle\" (supersede_finding, retract_finding, resolve_contradiction, get_contradictions, get_memory_detail, get_project_summary, list_projects), " +
        "\"graph\" (search_fragments, get_related_docs, read_graph, link_findings, cross_project_fragments), " +
        "\"skills\" (list_skills, read_skill, write_skill, remove_skill, enable_skill, disable_skill), " +
        "\"hooks\" (list_hooks, toggle_hooks, add_custom_hook, remove_custom_hook), " +
        "\"config\" (set_proactivity, set_task_mode, set_finding_sensitivity, set_retention_policy, set_workflow_policy, set_index_policy, get_topic_config, set_topic_config), " +
        "\"data\" (export_project, import_project, manage_project), " +
        "\"review\" (approve_queue_item, reject_queue_item, edit_queue_item, get_consolidation_status, doctor_fix, list_hook_errors), " +
        "\"extract\" (auto_extract_findings), " +
        "\"session\" (session_history), " +
        "\"tasks\" (update_task, link_task_issue, promote_task_to_issue, pin_task, promote_task, tidy_done_tasks), " +
        "\"findings\" (add_findings, remove_findings, supersede_finding, retract_finding, resolve_contradiction, get_contradictions), " +
        "\"memory\" (memory_feedback), " +
        "\"ops\" (get_consolidation_status, doctor_fix, list_hook_errors, approve_queue_item, reject_queue_item, edit_queue_item).",
      inputSchema: z.object({
        domain: z.string().describe(
          "Domain to unlock. One of: all, bulk, lifecycle, graph, skills, hooks, config, data, review, extract, search, tasks, findings, session, memory, ops."
        ),
      }),
    },
    async ({ domain }) => {
      const d = domain.toLowerCase().trim();

      if (d === "all") {
        if (unlockedDomains.has("all")) {
          return mcpResponse({ ok: true, message: "All tool domains already unlocked." });
        }
        // Register all advanced tools from every module (skip already-called fns)
        const advancedOnly: RegisterOptions = { tier: new Set(["advanced"]) };
        for (const fn of [registerSearch, registerTask, registerFinding, registerMemory,
          registerData, registerGraph, registerSession, registerOps, registerSkills,
          registerHooks, registerExtract, registerConfig]) {
          if (!calledRegisterFns.has(fn)) {
            fn(server, ctx, advancedOnly);
            calledRegisterFns.add(fn);
          }
        }
        unlockedDomains.add("all");
        return mcpResponse({
          ok: true,
          message: "All advanced tool domains unlocked.",
          data: { domain: "all" },
        });
      }

      if (!DOMAIN_REGISTER_MAP[d]) {
        return mcpResponse({
          ok: false,
          error: `Unknown domain "${domain}". Available: all, ${Object.keys(DOMAIN_REGISTER_MAP).join(", ")}`,
        });
      }

      if (unlockedDomains.has("all") || unlockedDomains.has(d)) {
        return mcpResponse({ ok: true, message: `Domain "${d}" already unlocked.` });
      }

      const advancedOnly: RegisterOptions = { tier: new Set(["advanced"]) };
      for (const registerFn of DOMAIN_REGISTER_MAP[d]) {
        if (!calledRegisterFns.has(registerFn)) {
          registerFn(server, ctx, advancedOnly);
          calledRegisterFns.add(registerFn);
        }
      }
      unlockedDomains.add(d);

      return mcpResponse({
        ok: true,
        message: `Unlocked "${d}" tool domain.`,
        data: { domain: d },
      });
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`phren-mcp running (${phrenPath})`);
}

if (!handledTopLevelCommand) {
  main().catch((err) => {
    console.error("Failed to start phren-mcp:", err);
    process.exit(1);
  });
}

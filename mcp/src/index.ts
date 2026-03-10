#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as fs from "fs";
import * as path from "path";
import {
  findCortexPathWithArg,
  debugLog,
  runtimeDir,
} from "./shared.js";
import { log as structuredLog } from "./logger.js";
import {
  buildIndex,
  updateFileInIndex as updateFileInIndexFn,
} from "./shared-index.js";
import { runCustomHooks } from "./hooks.js";
import { register as registerSearch } from "./mcp-search.js";
import { register as registerBacklog } from "./mcp-backlog.js";
import { register as registerFinding } from "./mcp-finding.js";
import { register as registerMemory } from "./mcp-memory.js";
import { register as registerData } from "./mcp-data.js";
import { register as registerGraph } from "./mcp-graph.js";
import { register as registerSession } from "./mcp-session.js";
import { register as registerOps } from "./mcp-ops.js";
import { register as registerSkills } from "./mcp-skills.js";
import { register as registerHooks } from "./mcp-hooks.js";
import { register as registerExtract } from "./mcp-extract.js";
import type { McpContext } from "./mcp-types.js";
import { errorMessage } from "./utils.js";
import { runTopLevelCommand } from "./entrypoint.js";
import { startEmbeddingWarmup } from "./startup-embedding.js";
import { resolveRuntimeProfile } from "./runtime-profile.js";
import { VERSION as PACKAGE_VERSION } from "./package-metadata.js";

const handledTopLevelCommand = await runTopLevelCommand(process.argv.slice(2));

// MCP mode: first non-flag arg is the cortex path. Resolve it lazily so CLI commands
// like `maintain` are not misinterpreted as a filesystem path after the command has run.
const cortexArg = handledTopLevelCommand ? undefined : process.argv.find((a, i) => i >= 2 && !a.startsWith("-"));
const cortexPath = handledTopLevelCommand ? "" : findCortexPathWithArg(cortexArg);

const STALE_LOCK_MS = 120_000; // 2 min — slightly above EXEC_TIMEOUT_MS (30s) to avoid blocking healthy writers

function cleanStaleLocks(cortexPath: string): void {
  const dir = runtimeDir(cortexPath);
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
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] cleanStaleLocks statFile: ${errorMessage(err)}\n`);
      }
    }
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] cleanStaleLocks readdir: ${errorMessage(err)}\n`);
  }
}

async function main() {
  const profile = resolveRuntimeProfile(cortexPath);
  cleanStaleLocks(cortexPath);
  let db: Awaited<ReturnType<typeof buildIndex>> | null = null;
  let indexReady = false;
  try {
    db = await buildIndex(cortexPath, profile);
    indexReady = true;

    // Load embedding cache and kick off background embedding (fire-and-forget)
    const { getEmbeddingCache } = await import("./shared-embedding-cache.js");
    const embCache = getEmbeddingCache(cortexPath);
    void startEmbeddingWarmup(db, embCache);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    structuredLog("error", "startup", `Failed to build cortex index: ${msg}`);
    console.error("Failed to build cortex index at startup:", error);
    process.exit(1);
  }
  let writeQueue: Promise<void> = Promise.resolve();
  let writeQueueDepth = 0;
  const MAX_QUEUE_DEPTH = 50;
  const WRITE_TIMEOUT_MS = 30_000;
  async function rebuildIndex() {
    runCustomHooks(cortexPath, "pre-index");
    indexReady = false;
    try { db?.close(); } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] rebuildIndex dbClose: ${errorMessage(err)}\n`);
    }
    db = await buildIndex(cortexPath, profile);
    indexReady = true;
    runCustomHooks(cortexPath, "post-index");
  }
  async function withWriteQueue<T>(fn: () => Promise<T>): Promise<T> {
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
          return { ok: false, error: `Write queue timeout: ${message}`, errorCode: "TIMEOUT" } as T;
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
    name: "cortex-mcp",
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
              error: "Index unavailable - check cortex setup",
            }, null, 2),
          }],
        };
      }
      try { trackToolCall(cortexPath, registeredName); } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] trackToolCall: ${errorMessage(err)}\n`);
      }
      return handler(...args);
    };
    return origRegisterTool(registeredName, config, wrapped as RegisterToolArgs[2]);
  } as typeof server.registerTool;

  // Register all tool handlers from domain modules
  const ctx: McpContext = {
    cortexPath,
    profile,
    db: () => {
      if (!db) throw new Error("Index unavailable - check cortex setup");
      return db;
    },
    rebuildIndex,
    withWriteQueue,
    updateFileInIndex: (filePath: string) => {
      if (!db) throw new Error("Index unavailable - check cortex setup");
      updateFileInIndexFn(db, filePath, cortexPath);
    },
  };

  registerSearch(server, ctx);
  registerBacklog(server, ctx);
  registerFinding(server, ctx);
  registerMemory(server, ctx);
  registerData(server, ctx);
  registerGraph(server, ctx);
  registerSession(server, ctx);
  registerOps(server, ctx);
  registerSkills(server, ctx);
  registerHooks(server, ctx);
  registerExtract(server, ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`cortex-mcp running (${cortexPath})`);
}

if (!handledTopLevelCommand) {
  main().catch((err) => {
    console.error("Failed to start cortex-mcp:", err);
    process.exit(1);
  });
}

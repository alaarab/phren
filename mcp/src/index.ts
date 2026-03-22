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
import { log as structuredLog, logger } from "./logger.js";
import {
  buildIndex,
  updateFileInIndex as updateFileInIndexFn,
} from "./shared/index.js";
import { runCustomHooks } from "./hooks.js";
import { register as registerSearch } from "./tools/search.js";
import { register as registerTask } from "./tools/tasks.js";
import { register as registerFinding } from "./tools/finding.js";
import { register as registerMemory } from "./tools/memory.js";
import { register as registerData } from "./tools/data.js";
import { register as registerGraph } from "./tools/graph.js";
import { register as registerSession } from "./tools/session.js";
import { register as registerOps } from "./tools/ops.js";
import { register as registerSkills } from "./tools/skills.js";
import { register as registerHooks } from "./tools/hooks.js";
import { register as registerExtract } from "./tools/extract.js";
import { register as registerConfig } from "./tools/config.js";
import type { McpContext } from "./tools/types.js";
import { mcpResponse } from "./tools/types.js";
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
        logger.warn("cleanStaleLocks", `statFile: ${errorMessage(err)}`);
      }
    }
  } catch (err: unknown) {
    logger.warn("cleanStaleLocks", `readdir: ${errorMessage(err)}`);
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
    const { getEmbeddingCache } = await import("./shared/embedding-cache.js");
    const embCache = getEmbeddingCache(phrenPath);
    void startEmbeddingWarmup(db, embCache);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    structuredLog("error", "startup", `Failed to build phren index: ${msg}`);
    console.error("Failed to build phren index at startup:", msg);
    process.exit(1);
  }
  let writeQueue: Promise<void> = Promise.resolve();
  let writeQueueDepth = 0;
  const MAX_QUEUE_DEPTH = 50;
  const WRITE_TIMEOUT_MS = 30_000;
  async function rebuildIndex() {
    runCustomHooks(phrenPath, "pre-index");
    const oldDb = db;
    try {
      indexReady = false;
      db = await buildIndex(phrenPath, profile);
      indexReady = true;
      try { oldDb?.close(); } catch (err: unknown) {
        logger.warn("rebuildIndex", `dbClose: ${errorMessage(err)}`);
      }
    } catch (err) {
      // Restore old state on failure
      db = oldDb;
      indexReady = !!oldDb;
      throw err;
    }
    runCustomHooks(phrenPath, "post-index");
  }
  async function withWriteQueue<T>(fn: () => Promise<T>): Promise<T | { content: { type: "text"; text: string }[] }> {
    if (writeQueueDepth >= MAX_QUEUE_DEPTH) {
      return mcpResponse({ ok: false, error: `Write queue full (${MAX_QUEUE_DEPTH} items). Try again shortly.`, errorCode: "TIMEOUT" });
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
        logger.warn("trackToolCall", errorMessage(err));
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

  registerSearch(server, ctx);
  registerTask(server, ctx);
  registerFinding(server, ctx);
  registerMemory(server, ctx);
  registerData(server, ctx);
  registerGraph(server, ctx);
  registerSession(server, ctx);
  registerOps(server, ctx);
  registerSkills(server, ctx);
  registerHooks(server, ctx);
  registerExtract(server, ctx);
  registerConfig(server, ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`phren-mcp running (${phrenPath})`);

  // Graceful shutdown: drain write queue and close DB before exit
  async function shutdown(signal: string): Promise<void> {
    structuredLog("info", "shutdown", `Received ${signal}, draining write queue...`);
    try {
      await writeQueue;
    } catch {
      // Write queue errors already logged
    }
    try { db?.close(); } catch (err: unknown) {
      logger.warn("shutdown", `dbClose: ${errorMessage(err)}`);
    }
    process.exit(0);
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

if (!handledTopLevelCommand) {
  main().catch((err) => {
    console.error("Failed to start phren-mcp:", err);
    process.exit(1);
  });
}

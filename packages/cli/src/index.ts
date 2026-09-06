#!/usr/bin/env node

import * as fs from "fs";
import * as path from "path";
import {
  findPhrenPathWithArg,
  debugLog,
  ensureFtsCacheRootPrivate,
  runtimeDir,
} from "./shared.js";
import { log as structuredLog, logger } from "./logger.js";
import type { McpContext } from "./tools/types.js";
import { errorMessage } from "./utils.js";
import {
  printIntegratedHelp,
  printIntegratedVersion,
  resolveTopLevelInvocation,
  runTopLevelCommand,
} from "./entrypoint.js";
// NOTE: the MCP-server-only module graph (MCP SDK, FTS indexer, tool registries,
// startup-embedding, custom-hook engine) is intentionally NOT imported here. It is
// dynamically imported inside main() so that top-level commands — hook-prompt,
// --version, --help — which never reach main() do not pay its ~1.8s cold-start cost.
// This matters most for the PostToolUse `hook-tool`, which spawns per tool call.

const invocation = resolveTopLevelInvocation(process.argv.slice(2));

if (invocation.kind === "help") {
  printIntegratedHelp();
  process.exit(0);
}

if (invocation.kind === "version") {
  printIntegratedVersion();
  process.exit(0);
}

if (invocation.kind === "manage") {
  const handled = await runTopLevelCommand(invocation.argv, { allowDefaultShell: true });
  if (!handled) {
    console.error(`Unknown command: ${invocation.argv[0]}\nRun 'phren --help' for available commands.`);
    process.exit(1);
  }
  process.exit(process.exitCode ?? 0);
}

const phrenPath = findPhrenPathWithArg(invocation.phrenArg);

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
          const pid = Number.parseInt(fs.readFileSync(lockPath, "utf8").split("\n")[0], 10);
          if (pid > 0) {
            try { process.kill(pid, 0); continue; }
            catch (err: unknown) { if ((err as NodeJS.ErrnoException).code !== "ESRCH") continue; }
          }
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
  // Lazy-load the MCP-server-only module graph. Only the long-lived MCP server
  // reaches main(), so paying the import cost here — not at module scope — keeps
  // every hook subprocess fast (hook-prompt, hook-tool, --version never get here).
  const [
    { McpServer },
    { StdioServerTransport },
    { buildIndex, flushEmbeddingQueue, updateFileInIndex: updateFileInIndexFn },
    { runCustomHooks },
    { mcpResponse },
    { startEmbeddingWarmup },
    { resolveRuntimeProfile },
    { VERSION: PACKAGE_VERSION },
  ] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/mcp.js"),
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("./shared/index.js"),
    import("./hooks.js"),
    import("./tools/types.js"),
    import("./startup-embedding.js"),
    import("./runtime-profile.js"),
    import("./package-metadata.js"),
  ]);

  const profile = resolveRuntimeProfile(phrenPath);
  cleanStaleLocks(phrenPath);
  // Before buildIndex() writes the first snapshot: the FTS cache is a full
  // SQLite export of the store, and on Linux it lands in a world-readable
  // /tmp. A 0700 root makes it unreachable to other local accounts.
  ensureFtsCacheRootPrivate();
  let db: Awaited<ReturnType<typeof buildIndex>> | null = null;
  let indexReady = false;
  let shuttingDown = false;
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
  async function rebuildIndex(force = false) {
    runCustomHooks(phrenPath, "pre-index");
    const oldDb = db;
    try {
      indexReady = false;
      db = await buildIndex(phrenPath, profile, { force });
      indexReady = true;
      // buildIndex() hands back its cached handle inside the debounce
      // window, so oldDb can be the very database we just installed.
      try { if (oldDb && oldDb !== db) oldDb.close(); } catch (err: unknown) {
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
  const { createToolGate, resolveMcpProfile } = await import("./mcp/profile.js");
  const origRegisterTool = server.registerTool.bind(server);
  type RegisterToolArgs = Parameters<typeof server.registerTool>;

  // Tools Claude reaches for during normal work in the full profile. Marked
  // anthropic/alwaysLoad so Claude Code keeps their schemas resident instead of
  // deferring them behind ToolSearch. The core profile marks all of its tools.
  const ALWAYS_LOAD_TOOLS = ["add_note", "complete_task", "session_start", "session_end", "get_findings"];

  // Every module registers its tools as before; the gate decides what the
  // client sees. `core` (the default) exposes ten tools and folds the rest
  // behind phren_admin; `full` is the whole surface. See mcp/profile.ts.
  const mcpProfile = resolveMcpProfile(phrenPath);
  const gate = createToolGate({
    profile: mcpProfile,
    alwaysLoad: ALWAYS_LOAD_TOOLS,
    register: (name, config, handler) => origRegisterTool(name as RegisterToolArgs[0], config as RegisterToolArgs[1], handler as unknown as RegisterToolArgs[2]),
    wrap: (registeredName, handler) => async (...args: unknown[]) => {
      if (shuttingDown) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: false,
              error: "phren-mcp server is shutting down; retry in a new session",
            }, null, 2),
          }],
        };
      }
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
      return (handler as (...a: unknown[]) => unknown)(...args);
    },
  });
  server.registerTool = gate.registerTool as unknown as typeof server.registerTool;

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

  // Lazy-imported tool registries — only the MCP server needs them. Registration
  // order is irrelevant (each module registers a disjoint set of tools).
  const toolModules = await Promise.all([
    import("./tools/search.js"),
    import("./tools/tasks.js"),
    import("./tools/finding.js"),
    import("./tools/memory.js"),
    import("./tools/data.js"),
    import("./tools/graph.js"),
    import("./tools/session.js"),
    import("./tools/ops.js"),
    import("./tools/skills.js"),
    import("./tools/hooks.js"),
    import("./tools/extract.js"),
    import("./tools/config.js"),
    import("./tools/notes.js"),
    import("./tools/summaries.js"),
  ]);
  for (const mod of toolModules) mod.register(server, ctx);
  gate.finish();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`phren-mcp running (${phrenPath}) · profile ${mcpProfile} · ${gate.exposed.size} tools`);

  const { startPullPolling } = await import("./sync/pull.js");
  const { refreshLinkedContext } = await import("./link/refresh.js");
  const polling = startPullPolling(phrenPath, {
    onChange: async () => {
      // Index refresh still succeeds if an external mirror is temporarily unwritable.
      try { refreshLinkedContext(phrenPath, profile); }
      catch (err: unknown) { logger.warn("periodic-pull", `context refresh: ${errorMessage(err)}`); }
      await rebuildIndex(true);
    },
    runExclusive: (fn) => {
      // Network calls have their own timeouts. Do not release the queue while
      // an underlying Git operation is still running, as Promise.race would.
      const run = writeQueue.then(fn);
      writeQueue = run.catch((err: unknown) => { logger.warn("periodic-pull", errorMessage(err)); });
      return run;
    },
  });
  server.server.onclose = () => { void shutdown("transport closed"); };

  // Graceful shutdown: drain write queue and close DB before exit
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    structuredLog("info", "shutdown", `Received ${signal}, draining write queue...`);
    await polling.stop();
    try {
      await writeQueue;
    } catch {
      // Write queue errors already logged
    }
    // Persist any pending embeddings; bounded so a slow/unreachable Ollama
    // can't stall shutdown.
    try {
      await Promise.race([
        flushEmbeddingQueue(),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ]);
    } catch (err: unknown) {
      logger.warn("shutdown", `embFlush: ${errorMessage(err)}`);
    }
    try { db?.close(); } catch (err: unknown) {
      logger.warn("shutdown", `dbClose: ${errorMessage(err)}`);
    }
    process.exit(0);
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("Failed to start phren-mcp:", err);
  process.exit(1);
});

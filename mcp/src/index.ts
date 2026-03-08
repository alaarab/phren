#!/usr/bin/env node

import { parseMcpMode, runInit } from "./init.js";
import * as os from "os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  findCortexPathWithArg,
  debugLog,
  runtimeDir,
} from "./shared.js";
import { log as structuredLog } from "./logger.js";
import { buildIndex, updateFileInIndex as updateFileInIndexFn } from "./shared-index.js";
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

if (process.argv[2] === "--help" || process.argv[2] === "-h" || process.argv[2] === "help") {
  console.log(`cortex - Long-term memory for Claude Code

Usage:
  cortex                                 Open interactive shell
  cortex quickstart                      Quick setup: init + link + project scaffold
  cortex init [--machine <n>] [--profile <n>] [--mcp on|off] [--template <t>] [--from-existing <path>] [--dry-run] [-y]
                                         Set up cortex (templates: python-project, monorepo, library, frontend)
  cortex projects list                   List all projects in cortex
  cortex projects add <name>             Create a new project
  cortex projects remove <name>          Remove a project (asks for confirmation)
  cortex detect-skills [--import]        Find untracked skills in ~/.claude/skills/
  cortex skills list                     List installed skills
  cortex skills add <project> <path>    Link or copy a skill file into one project
  cortex skills remove <project> <name> Remove a project skill by name
  cortex hooks list                      Show hook tool preferences
  cortex hooks enable <tool>             Enable hooks for one tool
  cortex hooks disable <tool>            Disable hooks for one tool
  cortex status                          Health, active project, stats
  cortex search <query> [--project <n>] [--type <t>] [--limit <n>]
                                         Search your cortex
  cortex add-finding <project> "..."     Save an insight
  cortex pin <project> "..."             Pin a canonical memory
  cortex backlog                         Cross-project backlog view
  cortex skill-list                      List installed skills
  cortex doctor [--fix] [--check-data] [--agents]
                                         Health check and self-heal (--agents: show agent integrations only)
  cortex review-ui [--port=3499]         Memory review web UI
  cortex debug-injection --prompt "..."  Preview hook-prompt injection output
  cortex inspect-index [--project <n>]   Inspect FTS index contents for debugging
  cortex update                          Update to latest version

Configuration:
  cortex config policy [get|set ...]     Retention, TTL, confidence, decay
  cortex config workflow [get|set ...]   Approval gates, risky-memory thresholds
  cortex config access [get|set ...]     Role-based permissions
  cortex config index [get|set ...]      Indexer include/exclude globs
  cortex config machines                 Registered machines
  cortex config profiles                 Profiles and projects

Maintenance:
  cortex maintain govern [project]       Queue stale/low-value memories for review
  cortex maintain prune [project]        Delete expired entries
  cortex maintain consolidate [project]  Deduplicate FINDINGS.md
  cortex maintain migrate <project> [--pin] [--dry-run]
                                         Promote legacy findings into FINDINGS/CANONICAL
  cortex maintain extract [project]      Mine git/GitHub signals
  cortex migrate-findings <project> [--pin] [--dry-run]
                                         Legacy alias for maintain migrate

Setup:
  cortex link [--machine <n>] [--profile <n>]
                                         Sync profile, symlinks, hooks
  cortex mcp-mode [on|off|status]        Toggle MCP integration
  cortex hooks-mode [on|off|status]      Toggle hook execution
  cortex verify                          Check init completed OK
  cortex uninstall                       Remove cortex config and hooks

Environment:
  CORTEX_PATH                Override cortex directory (default: ~/.cortex)
  CORTEX_PROFILE             Active profile name
  CORTEX_DEBUG               Enable debug logging (set to 1)
  CORTEX_OLLAMA_URL          Ollama base URL (default: http://localhost:11434; set to 'off' to disable)
  CORTEX_EMBEDDING_API_URL   OpenAI-compatible /embeddings endpoint (cloud alternative to Ollama)
  CORTEX_EMBEDDING_API_KEY   API key for CORTEX_EMBEDDING_API_URL
  CORTEX_EMBEDDING_MODEL     Embedding model (default: nomic-embed-text)
  CORTEX_EXTRACT_MODEL       Ollama model for memory extraction (default: llama3.2)
  CORTEX_EMBEDDING_PROVIDER  Set to 'api' to use OpenAI API for search_knowledge embeddings
  CORTEX_FEATURE_AUTO_CAPTURE=1      Extract insights from conversations at session end
  CORTEX_FEATURE_SEMANTIC_DEDUP=1    LLM-based dedup on add_finding
  CORTEX_FEATURE_SEMANTIC_CONFLICT=1 LLM-based conflict detection on add_finding
  CORTEX_FEATURE_HYBRID_SEARCH=0     Disable TF-IDF cosine fallback in search_knowledge
  CORTEX_FEATURE_AUTO_EXTRACT=0      Disable automatic memory extraction on each prompt
  CORTEX_FEATURE_PROGRESSIVE_DISCLOSURE=1  Compact memory index injection
  CORTEX_LLM_MODEL           LLM model for semantic dedup/conflict (default: gpt-4o-mini)
  CORTEX_LLM_ENDPOINT        OpenAI-compatible /chat/completions base URL for dedup/conflict
  CORTEX_LLM_KEY             API key for CORTEX_LLM_ENDPOINT
  CORTEX_CONTEXT_TOKEN_BUDGET    Max tokens injected per hook-prompt (default: 550)
  CORTEX_CONTEXT_SNIPPET_LINES   Max lines per injected snippet (default: 6)
  CORTEX_CONTEXT_SNIPPET_CHARS   Max chars per injected snippet (default: 520)
  CORTEX_MAX_INJECT_TOKENS       Hard cap on total injected tokens (default: 2000)
  CORTEX_BACKLOG_PRIORITY        Priorities to include in injection: high,medium,low (default: high,medium)
  CORTEX_MEMORY_TTL_DAYS         Override memory TTL for trust filtering
  CORTEX_HOOK_TIMEOUT_MS         Hook subprocess timeout in ms (default: 14000)
  CORTEX_FINDINGS_CAP            Max findings per date section before consolidation (default: 20)
  CORTEX_CONSOLIDATION_CAP       Max total findings before forced consolidation (default: 150)
  CORTEX_GH_PR_LIMIT/RUN_LIMIT/ISSUE_LIMIT  GitHub extraction limits (defaults: 40/25/25)

Examples:
  cortex search "rate limiting"          Search across all projects
  cortex search "auth" --project my-api  Search within one project
  cortex add-finding my-app "Redis connections need explicit close in finally blocks"
  cortex doctor --fix                    Fix common config issues
  cortex config policy set --ttlDays=90  Change memory retention to 90 days
  cortex maintain govern my-app          Queue stale memories for review
  cortex status                          Quick health check
`);
  process.exit(0);
}

if (process.argv[2] === "init") {
  const initArgs = process.argv.slice(3);
  const machineIdx = initArgs.indexOf("--machine");
  const profileIdx = initArgs.indexOf("--profile");
  const mcpIdx = initArgs.indexOf("--mcp");
  const templateIdx = initArgs.indexOf("--template");
  const fromExistingIdx = initArgs.indexOf("--from-existing");
  const mcpMode = mcpIdx !== -1 ? parseMcpMode(initArgs[mcpIdx + 1]) : undefined;
  if (mcpIdx !== -1 && !mcpMode) {
    console.error(`Invalid --mcp value "${initArgs[mcpIdx + 1] || ""}". Use "on" or "off".`);
    process.exit(1);
  }
  await runInit({
    machine: machineIdx !== -1 ? initArgs[machineIdx + 1] : undefined,
    profile: profileIdx !== -1 ? initArgs[profileIdx + 1] : undefined,
    mcp: mcpMode,
    template: templateIdx !== -1 ? initArgs[templateIdx + 1] : undefined,
    fromExisting: fromExistingIdx !== -1 ? initArgs[fromExistingIdx + 1] : undefined,
    applyStarterUpdate: initArgs.includes("--apply-starter-update"),
    dryRun: initArgs.includes("--dry-run"),
    yes: initArgs.includes("--yes") || initArgs.includes("-y"),
  });
  process.exit(0);
}

if (process.argv[2] === "uninstall") {
  const { runUninstall } = await import("./init.js");
  await runUninstall();
  process.exit(0);
}

if (process.argv[2] === "status") {
  const { runStatus } = await import("./status.js");
  await runStatus();
  process.exit(0);
}

if (process.argv[2] === "verify") {
  const { runPostInitVerify } = await import("./init.js");
  const cortexPath = process.env.CORTEX_PATH || path.join(os.homedir(), ".cortex");
  const result = runPostInitVerify(cortexPath);
  console.log(`cortex verify: ${result.ok ? "ok" : "issues found"}`);
  for (const check of result.checks) {
    console.log(`  ${check.ok ? "pass" : "FAIL"} ${check.name}: ${check.detail}`);
    if (!check.ok && check.fix) {
      console.log(`       fix: ${check.fix}`);
    }
  }
  if (!result.ok) {
    console.log(`\nRun \`npx @alaarab/cortex init\` to fix setup issues.`);
  }
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[2] === "mcp-mode") {
  const { runMcpMode } = await import("./init.js");
  try {
    await runMcpMode(process.argv[3]);
  } catch (e: unknown) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  process.exit(0);
}

if (process.argv[2] === "hooks-mode") {
  const { runHooksMode } = await import("./init.js");
  try {
    await runHooksMode(process.argv[3]);
  } catch (e: unknown) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  process.exit(0);
}

if (process.argv[2] === "link") {
  const { runLink } = await import("./link.js");
  const linkArgs = process.argv.slice(3);
  const getFlag = (flag: string) => {
    const idx = linkArgs.indexOf(flag);
    return idx !== -1 ? linkArgs[idx + 1] : undefined;
  };
  const taskArg = getFlag("--task") as "debugging" | "planning" | "clean" | undefined;
  const mcpArg = getFlag("--mcp");
  const mcpMode = mcpArg ? parseMcpMode(mcpArg) : undefined;
  if (mcpArg && !mcpMode) {
    console.error(`Invalid --mcp value "${mcpArg}". Use "on" or "off".`);
    process.exit(1);
  }
  await runLink(process.env.CORTEX_PATH || path.join(os.homedir(), ".cortex"), {
    machine: getFlag("--machine"),
    profile: getFlag("--profile"),
    register: linkArgs.includes("--register"),
    task: taskArg,
    allTools: linkArgs.includes("--all-tools"),
    mcp: mcpMode,
  });
  process.exit(0);
}

if (process.argv[2] === "--health") {
  process.exit(0);
}

// Terminal-first behavior: open shell for no-arg human invocations.
if (!process.argv[2] && process.stdin.isTTY && process.stdout.isTTY) {
  const { runCliCommand } = await import("./cli.js");
  await runCliCommand("shell", []);
  process.exit(0);
}

// CLI subcommands (run before MCP server starts)
const CLI_COMMANDS = [
  "search",
  "shell",
  "update",
  "config",
  "maintain",
  "hook-prompt",
  "hook-session-start",
  "hook-stop",
  "hook-context",
  "hook-tool",
  "add-finding",
  "pin",
  "doctor",
  "debug-injection",
  "inspect-index",
  "review-ui",
  "quality-feedback",
  "skill-list",
  "skills",
  "hooks",
  "detect-skills",
  "backlog",
  "quickstart",
  "background-maintenance",
  "projects",
  // Legacy aliases (still work, route to old handlers)
  "extract-memories",
  "govern-memories",
  "prune-memories",
  "consolidate-memories",
  "migrate-findings",
  "index-policy",
  "policy",
  "workflow",
  "access",
];
if (CLI_COMMANDS.includes(process.argv[2])) {
  const { runCliCommand } = await import("./cli.js");
  const cmd = process.argv[2];
  // Track CLI usage if telemetry is opt-in enabled
  try {
    const { trackCliCommand } = await import("./telemetry.js");
    trackCliCommand(process.env.CORTEX_PATH || path.join(os.homedir(), ".cortex"), cmd);
  } catch { /* telemetry is best-effort */ }
  await runCliCommand(cmd, process.argv.slice(3));
  process.exit(0);
}

// MCP mode: first non-flag arg is the cortex path
const cortexArg = process.argv.find((a, i) => i >= 2 && !a.startsWith("-"));
const cortexPath = findCortexPathWithArg(cortexArg);

const __indexDirname = path.dirname(fileURLToPath(import.meta.url));
const __packageRoot = path.join(__indexDirname, "..", "..");
const PACKAGE_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__packageRoot, "package.json"), "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
const profile = process.env.CORTEX_PROFILE || "";
const TOOL_NAME_ALIASES: Record<string, string> = {
  // Backwards compat: old clients calling search_cortex still resolve
  search_cortex: "search_knowledge",
};

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
      } catch { /* lock may have been removed concurrently */ }
    }
  } catch { /* best effort */ }
}

async function main() {
  cleanStaleLocks(cortexPath);
  let db: Awaited<ReturnType<typeof buildIndex>> | null = null;
  let indexReady = false;
  try {
    db = await buildIndex(cortexPath, profile);
    indexReady = true;

    // Load embedding cache and kick off background embedding (fire-and-forget)
    const { getEmbeddingCache } = await import("./shared-embedding-cache.js");
    const embCache = getEmbeddingCache(cortexPath);
    embCache.load().catch(() => {});
    void backgroundEmbedMissingDocs(cortexPath, db, embCache);
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
    try { db?.close(); } catch { /* best effort */ }
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
        const message = err instanceof Error ? err.message : String(err);
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
  // server.registerTool uses `any` for config/handler because @modelcontextprotocol/sdk
  // exposes these as complex intersection types that TypeScript cannot easily parameterize.
  // The real type safety comes from each domain module's z.object() inputSchema.
  // Tightening further requires upstream SDK changes (tracked in SDK issue tracker).
  server.registerTool = function (name: string, config: any, handler: any) {
    const registeredName = TOOL_NAME_ALIASES[name] ?? name;
    const wrapped = async (...args: any[]) => {
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
      try { trackToolCall(cortexPath, registeredName); } catch { /* best-effort */ }
      return handler(...args);
    };
    if (registeredName !== name) {
      debugLog(`Remapped MCP tool "${name}" to canonical name "${registeredName}"`);
    }
    return origRegisterTool(registeredName, config, wrapped);
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

async function backgroundEmbedMissingDocs(
  cortexPath: string,
  db: Awaited<ReturnType<typeof buildIndex>>,
  cache: import("./shared-embedding-cache.js").EmbeddingCache
): Promise<void> {
  try {
    const { checkOllamaAvailable, embedText, getEmbeddingModel, getOllamaUrl } = await import("./shared-ollama.js");
    if (!getOllamaUrl()) return;
    if (!await checkOllamaAvailable()) return;
    const results = db.exec("SELECT path, content FROM docs");
    if (!results?.length || !results[0]?.values?.length) return;
    const model = getEmbeddingModel();
    let count = 0;
    for (const row of results[0].values) {
      const docPath = String(row[0]);
      const content = String(row[1]);
      if (cache.get(docPath, model)) continue;
      const vec = await embedText(content.slice(0, 8000));
      if (vec) {
        cache.set(docPath, model, vec);
        count++;
        if (count % 10 === 0) await cache.flush();
      }
      await new Promise(r => setTimeout(r, 50));
    }
    if (count > 0) await cache.flush();
    debugLog(`backgroundEmbedMissingDocs: embedded ${count} new docs`);
  } catch (e) {
    debugLog(`backgroundEmbedMissingDocs error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

main().catch((err) => {
  console.error("Failed to start cortex-mcp:", err);
  process.exit(1);
});

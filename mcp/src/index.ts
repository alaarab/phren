#!/usr/bin/env node

import { parseMcpMode, runInit } from "./init.js";
import * as os from "os";

if (process.argv[2] === "--help" || process.argv[2] === "-h" || process.argv[2] === "help") {
  console.log(`cortex - Long-term memory for Claude Code

Usage:
  cortex                                 Open interactive shell
  cortex init [--machine <n>] [--profile <n>] [--mcp on|off] [--template <t>] [--from-existing <path>] [--dry-run] [-y]
                                         Set up cortex (templates: python-project, monorepo, library, frontend)
  cortex detect-skills [--import]        Find untracked skills in ~/.claude/skills/
  cortex status                          Health, active project, stats
  cortex search <query> [--project <n>] [--type <t>] [--limit <n>]
                                         Search your knowledge base
  cortex add-learning <project> "..."    Save an insight
  cortex pin-memory <project> "..."      Pin a canonical memory
  cortex backlog                         Cross-project backlog view
  cortex skill-list                      List installed skills
  cortex doctor [--fix] [--check-data]   Health check and self-heal
  cortex memory-ui [--port=3499]         Memory review web UI
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
  cortex maintain consolidate [project]  Deduplicate LEARNINGS.md
  cortex maintain migrate <project> [--pin] [--dry-run]
                                         Promote legacy findings into LEARNINGS/CANONICAL
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
  CORTEX_PATH     Override cortex directory (default: ~/.cortex)
  CORTEX_PROFILE  Active profile name
  CORTEX_DEBUG    Enable debug logging (set to 1)

Examples:
  cortex search "rate limiting"          Search across all projects
  cortex search "auth" --project my-api  Search within one project
  cortex add-learning my-app "Redis connections need explicit close in finally blocks"
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
  } catch (e: any) {
    console.error(e.message || e);
    process.exit(1);
  }
  process.exit(0);
}

if (process.argv[2] === "hooks-mode") {
  const { runHooksMode } = await import("./init.js");
  try {
    await runHooksMode(process.argv[3]);
  } catch (e: any) {
    console.error(e.message || e);
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
  "add-learning",
  "pin-memory",
  "doctor",
  "debug-injection",
  "inspect-index",
  "memory-ui",
  "quality-feedback",
  "skill-list",
  "detect-skills",
  "backlog",
  "background-maintenance",
  // Legacy aliases (still work, route to old handlers)
  "extract-memories",
  "govern-memories",
  "prune-memories",
  "consolidate-memories",
  "migrate-findings",
  "index-policy",
  "memory-policy",
  "memory-workflow",
  "memory-access",
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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { isValidProjectName, buildRobustFtsQuery, extractKeywords, STOP_WORDS } from "./utils.js";
import {
  addBacklogItem as addBacklogItemStore,
  addBacklogItems as addBacklogItemsBatch,
  backlogMarkdown,
  completeBacklogItem as completeBacklogItemStore,
  completeBacklogItems as completeBacklogItemsBatch,
  readBacklog,
  readBacklogs,
  readLearnings,
  removeLearning as removeLearningStore,
  updateBacklogItem as updateBacklogItemStore,
} from "./data-access.js";
import {
  findCortexPathWithArg,
  buildIndex,
  extractSnippet,
  queryRows,
  cosineFallback,
  addLearningToFile,
  addLearningsToFile,
  autoMergeConflicts,
  debugLog,
  upsertCanonicalMemory,
  recordMemoryFeedback,
  flushMemoryScores,
  runtimeDir,
  EXEC_TIMEOUT_MS,
  KNOWN_OBSERVATION_TAGS,
} from "./shared.js";
import { runCustomHooks } from "./hooks.js";

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

function textResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

const STALE_LOCK_MS = 600_000; // 10 min — shared with consolidation lock in shared-content.ts

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

function jsonResponse(payload: { ok: boolean; data?: unknown; error?: string; message?: string }) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

async function main() {
  cleanStaleLocks(cortexPath);
  let db = await buildIndex(cortexPath, profile);
  let writeQueue: Promise<void> = Promise.resolve();
  async function rebuildIndex() {
    runCustomHooks(cortexPath, "pre-index");
    try { db.close(); } catch { /* best effort */ }
    db = await buildIndex(cortexPath, profile);
    runCustomHooks(cortexPath, "post-index");
  }
  async function withWriteQueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = writeQueue.then(fn, fn);
    writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  const server = new McpServer({
    name: "cortex-mcp",
    version: PACKAGE_VERSION,
  });

  // Track MCP tool calls for telemetry (opt-in only, best-effort)
  const { trackToolCall } = await import("./telemetry.js");
  const origRegisterTool = server.registerTool.bind(server);
  server.registerTool = function (name: string, config: any, handler: any) {
    const wrapped = async (...args: any[]) => {
      try { trackToolCall(cortexPath, name); } catch { /* best-effort */ }
      return handler(...args);
    };
    return origRegisterTool(name, config, wrapped);
  } as typeof server.registerTool;

  server.registerTool(
    "remove_learnings",
    {
      title: "◆ cortex · remove learnings (bulk)",
      description: "Remove multiple learnings from a project's LEARNINGS.md in one call.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        learnings: z.array(z.string()).describe("List of partial texts to match and remove."),
      }),
    },
    async ({ project, learnings }) => {
      if (!isValidProjectName(project)) return jsonResponse({ ok: false, error: `Invalid project name: "${project}"` });
      return withWriteQueue(async () => {
        const results: { learning: string; ok: boolean; message: string }[] = [];
        for (const learning of learnings) {
          const result = removeLearningStore(cortexPath, project, learning);
          results.push({ learning, ok: result.ok, message: result.ok ? result.data : result.error ?? "unknown error" });
        }
        await rebuildIndex();
        const succeeded = results.filter((r) => r.ok).length;
        return jsonResponse({ ok: succeeded > 0, message: `Removed ${succeeded}/${learnings.length} learnings`, data: { project, results } });
      });
    }
  );

  server.registerTool(
    "pin_memory",
    {
      title: "◆ cortex · pin memory",
      description:
        "Promote an important memory into CANONICAL_MEMORIES.md so retrieval prioritizes it.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        memory: z.string().describe("Canonical memory text to pin."),
      }),
    },
    async ({ project, memory }) => {
      return withWriteQueue(async () => {
        const result = upsertCanonicalMemory(cortexPath, project, memory);
        if (!result.ok) return jsonResponse({ ok: false, error: result.error });
        return jsonResponse({ ok: true, message: result.data, data: { project, memory } });
      });
    }
  );

  // Governance, policy, and maintenance tools moved to CLI:
  //   cortex config [policy|workflow|access|index|machines|profiles]
  //   cortex maintain [govern|prune|consolidate|migrate|extract]

  server.registerTool(
    "memory_feedback",
    {
      title: "◆ cortex · feedback",
      description: "Record feedback on whether an injected memory was helpful or noisy/regressive.",
      inputSchema: z.object({
        key: z.string().describe("Memory key to score."),
        feedback: z.enum(["helpful", "reprompt", "regression"]).describe("Feedback type."),
      }),
    },
    async ({ key, feedback }) => {
      return withWriteQueue(async () => {
        recordMemoryFeedback(cortexPath, key, feedback);
        flushMemoryScores(cortexPath);
        return jsonResponse({ ok: true, message: `Recorded feedback ${feedback} for ${key}`, data: { key, feedback } });
      });
    }
  );

  server.registerTool(
    "get_memory_detail",
    {
      title: "◆ cortex · memory detail",
      description:
        "Fetch the full content of a specific memory entry by its ID. Use this after receiving a compact " +
        "memory index from the hook-prompt (when CORTEX_FEATURE_PROGRESSIVE_DISCLOSURE is enabled). " +
        "The id format is `mem:project/filename` as shown in the memory index.",
      inputSchema: z.object({
        id: z.string().describe(
          "Memory ID in the format `mem:project/filename` (e.g. `mem:my-app/LEARNINGS.md`). " +
          "Returned by the hook-prompt compact index when CORTEX_FEATURE_PROGRESSIVE_DISCLOSURE=1."
        ),
      }),
    },
    async ({ id }) => {
      // Parse mem:project/filename
      const match = id.match(/^mem:([^/]+)\/(.+)$/);
      if (!match) {
        return jsonResponse({ ok: false, error: `Invalid memory id format "${id}". Expected mem:project/filename.` });
      }
      const [, project, filename] = match;
      if (!isValidProjectName(project)) {
        return jsonResponse({ ok: false, error: `Invalid project name: "${project}"` });
      }

      const rows = queryRows(
        db,
        "SELECT project, filename, type, content, path FROM docs WHERE project = ? AND filename = ? LIMIT 1",
        [project, filename]
      );

      if (!rows || !rows.length) {
        return jsonResponse({ ok: false, error: `Memory not found: ${id}` });
      }

      const [proj, fname, docType, content, filePath] = rows[0] as string[];
      return jsonResponse({
        ok: true,
        message: `[${proj}/${fname}] (${docType})\n\n${content}`,
        data: { id, project: proj, filename: fname, type: docType, content, path: filePath },
      });
    }
  );

  server.registerTool(
    "search_knowledge",
    {
      title: "◆ cortex · search",
      description: "Search the user's personal knowledge base. Call this at the start of any session to get project context, and any time the user asks about their codebase, stack, architecture, past decisions, commands, conventions, or lessons learned. Prefer this over asking the user to re-explain things they've already documented.",
      inputSchema: z.object({
        query: z.string().describe("Search query (supports FTS5 syntax: AND, OR, NOT, phrase matching with quotes)"),
        limit: z.number().min(1).max(20).optional().describe("Max results to return (1-20, default 5)"),
        project: z.string().optional().describe("Filter by project name."),
        type: z.enum(["claude", "learnings", "knowledge", "skills", "summary", "backlog", "changelog", "canonical", "memory-queue", "skill", "other"])
          .optional()
          .describe("Filter by document type: claude, learnings, knowledge, summary, backlog, skill"),
        tag: z.enum(["decision", "gotcha", "tradeoff", "architecture", "bug"])
          .optional()
          .describe("Filter learnings by semantic observation tag: decision, gotcha, tradeoff, architecture, bug"),
      }),
    },
    async ({ query, limit, project, type, tag }) => {
      try {
        const maxResults = limit ?? 5;
        const filterType = type === "skills" ? "skill" : type;
        const filterTag = tag?.toLowerCase();
        const filterProject = project?.trim();
        if (filterProject && !isValidProjectName(filterProject)) {
          return jsonResponse({ ok: false, error: `Invalid project name: "${project}"` });
        }
        const safeQuery = buildRobustFtsQuery(query);

        if (!safeQuery) return jsonResponse({ ok: false, error: "Search query is empty after sanitization." });

        let sql = "SELECT project, filename, type, content, path FROM docs WHERE docs MATCH ?";
        const params: (string | number)[] = [safeQuery];
        if (filterProject) {
          sql += " AND project = ?";
          params.push(filterProject);
        }
        if (filterType) {
          sql += " AND type = ?";
          params.push(filterType);
        }
        sql += " ORDER BY rank LIMIT ?";
        params.push(maxResults);

        let rows = queryRows(db, sql, params);
        let usedFallback = false;

        // Hybrid search: if FTS5 returns fewer than 3 results, try cosine fallback
        // Only active when CORTEX_FEATURE_HYBRID_SEARCH=1 (default off)
        if (rows && rows.length < 3) {
          const ftsRowids = new Set<number>();
          // Get rowids of existing FTS5 results to deduplicate
          try {
            let rowidSql = "SELECT rowid, project, filename, type, content, path FROM docs WHERE docs MATCH ?";
            const rowidParams: (string | number)[] = [safeQuery];
            if (filterProject) { rowidSql += " AND project = ?"; rowidParams.push(filterProject); }
            if (filterType) { rowidSql += " AND type = ?"; rowidParams.push(filterType); }
            rowidSql += " ORDER BY rank LIMIT ?";
            rowidParams.push(maxResults);
            const rowidResult = db.exec(rowidSql, rowidParams);
            if (rowidResult?.length && rowidResult[0]?.values?.length) {
              for (const r of rowidResult[0].values) ftsRowids.add(Number(r[0]));
            }
          } catch { /* ignore — rowids are optional for deduplication */ }

          const cosineResults = cosineFallback(db, query, ftsRowids, maxResults - rows.length);
          if (cosineResults.length > 0) {
            const cosineRows = cosineResults.map(d => [d.project, d.filename, d.type, d.content, d.path]);
            rows = [...rows, ...cosineRows];
            usedFallback = true;
          }
        }

        // Also try cosine fallback when FTS5 returns null (0 results)
        if (!rows) {
          const cosineResults = cosineFallback(db, query, new Set<number>(), maxResults);
          if (cosineResults.length > 0) {
            rows = cosineResults.map(d => [d.project, d.filename, d.type, d.content, d.path]);
            usedFallback = true;
          }
        }

        if (!rows) {
          // Keyword overlap fallback: scan all docs and rank by term overlap
          let fallbackSql = "SELECT project, filename, type, content, path FROM docs";
          const fallbackParams: (string | number)[] = [];
          const clauses: string[] = [];
          if (filterProject) {
            clauses.push("project = ?");
            fallbackParams.push(filterProject);
          }
          if (filterType) {
            clauses.push("type = ?");
            fallbackParams.push(filterType);
          }
          if (clauses.length) fallbackSql += " WHERE " + clauses.join(" AND ");

          const allRows = queryRows(db, fallbackSql, fallbackParams);
          if (allRows) {
            const terms = query
              .toLowerCase()
              .replace(/[^\w\s-]/g, " ")
              .split(/\s+/)
              .filter(w => w.length > 1 && !STOP_WORDS.has(w));

            if (terms.length > 0) {
              const scored = allRows
                .map((row: any[]) => {
                  const content = (row[3] as string).toLowerCase();
                  let score = 0;
                  for (const term of terms) {
                    if (content.includes(term)) score++;
                  }
                  return { row, score };
                })
                .filter(r => r.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, maxResults);

              if (scored.length > 0) {
                rows = scored.map(s => s.row);
                usedFallback = true;
              }
            }
          }

          if (!rows) {
            return jsonResponse({ ok: true, message: "No results found.", data: { query, results: [] } });
          }
        }

        // Filter by observation tag if requested
        if (filterTag && rows) {
          const tagPattern = `[${filterTag}]`;
          rows = rows.filter((row: any[]) => {
            const content = (row[3] as string).toLowerCase();
            return content.includes(tagPattern);
          });
          if (rows.length === 0) {
            return jsonResponse({ ok: true, message: `No results found with tag [${filterTag}].`, data: { query, results: [] } });
          }
        }

        const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
        const scored = rows.map((row: any[], idx: number) => {
          const filePath = row[4] as string;
          let boost = 1.0;
          try {
            const mtime = fs.statSync(filePath).mtimeMs;
            if (mtime > thirtyDaysAgo) boost = 1.2;
          } catch { /* file may not exist on disk */ }
          return { row, rank: (rows.length - idx) * boost };
        });
        scored.sort((a, b) => b.rank - a.rank);

        const results = scored.map(({ row }) => {
          const [project, filename, docType, content, filePath] = row as string[];
          const snippet = extractSnippet(content, query);
          return { project, filename, type: docType, snippet, path: filePath };
        });

        const formatted = results.map((r) =>
          `### ${r.project}/${r.filename} (${r.type})\n${r.snippet}\n\n\`${r.path}\``
        );

        const fallbackNote = usedFallback ? " (keyword fallback)" : "";
        runCustomHooks(cortexPath, "post-search", { CORTEX_QUERY: query, CORTEX_RESULT_COUNT: String(results.length) });
        return jsonResponse({
          ok: true,
          message: `Found ${results.length} result(s) for "${query}"${fallbackNote}:\n\n${formatted.join("\n\n---\n\n")}`,
          data: { query, count: results.length, results, fallback: usedFallback },
        });
      } catch (err: any) {
        return jsonResponse({ ok: false, error: `Search error: ${err.message}` });
      }
    }
  );

  server.registerTool(
    "get_project_summary",
    {
      title: "◆ cortex · project",
      description: "Get a project's summary card and available docs. Call this when starting work on a specific project to orient yourself: what it is, the stack, current status, and how to run it.",
      inputSchema: z.object({
        name: z.string().describe("Project name (e.g. 'my-app', 'backend', 'frontend')"),
      }),
    },
    async ({ name }) => {
      const files = queryRows(db, "SELECT filename, type, path FROM docs WHERE project = ?", [name]);

      if (!files) {
        const projectRows = queryRows(db, "SELECT DISTINCT project FROM docs ORDER BY project", []);
        const names = projectRows ? projectRows.map((r: any[]) => r[0]) : [];
        return jsonResponse({ ok: false, error: `Project "${name}" not found.`, data: { available: names } });
      }

      const summaryRow = queryRows(db, "SELECT content, path FROM docs WHERE project = ? AND type = 'summary'", [name]);
      const claudeRow = queryRows(db, "SELECT content, path FROM docs WHERE project = ? AND type = 'claude'", [name]);

      const indexedFiles = files.map((f: any[]) => ({ filename: f[0], type: f[1], path: f[2] }));

      const parts: string[] = [`# ${name}`];
      if (summaryRow) {
        parts.push(`\n## Summary\n${summaryRow[0][0]}`);
      } else {
        parts.push("\n*No summary.md found for this project.*");
      }
      if (claudeRow) {
        parts.push(`\n## CLAUDE.md path\n\`${claudeRow[0][1]}\``);
      }
      const fileList = indexedFiles.map((f) => `- ${f.filename} (${f.type})`).join("\n");
      parts.push(`\n## Indexed files\n${fileList}`);

      return jsonResponse({
        ok: true,
        message: parts.join("\n"),
        data: {
          name,
          summary: summaryRow ? summaryRow[0][0] : null,
          claudeMdPath: claudeRow ? claudeRow[0][1] : null,
          files: indexedFiles,
        },
      });
    }
  );

  server.registerTool(
    "list_projects",
    {
      title: "◆ cortex · projects",
      description:
        "List all projects in the active cortex profile with a brief summary of each. " +
        "Shows which documentation files exist per project.",
      inputSchema: z.object({
        page: z.number().int().min(1).optional().describe("1-based page number (default 1)."),
        page_size: z.number().int().min(1).max(50).optional().describe("Page size (default 20, max 50)."),
      }),
    },
    async ({ page, page_size }) => {
      const projectRows = queryRows(db, "SELECT DISTINCT project FROM docs ORDER BY project", []);
      if (!projectRows) return jsonResponse({ ok: true, message: "No projects indexed.", data: { projects: [], total: 0 } });

      const projects = projectRows.map((r: any[]) => r[0] as string);
      const pageSize = page_size ?? 20;
      const pageNum = page ?? 1;
      const start = Math.max(0, (pageNum - 1) * pageSize);
      const end = start + pageSize;
      const pageProjects = projects.slice(start, end);
      const totalPages = Math.max(1, Math.ceil(projects.length / pageSize));
      if (pageNum > totalPages) {
        return jsonResponse({ ok: false, error: `Page ${pageNum} out of range. Total pages: ${totalPages}.` });
      }

      const badgeTypes = ["claude", "learnings", "summary", "backlog"] as const;
      const badgeLabels: Record<string, string> = { claude: "CLAUDE.md", learnings: "LEARNINGS", summary: "summary", backlog: "backlog" };

      const projectList = pageProjects.map((proj) => {
        const rows = queryRows(db, "SELECT filename, type, content FROM docs WHERE project = ?", [proj]) ?? [];
        const types = rows.map((r) => r[1] as string);
        const summaryRow = rows.find((r) => r[1] === "summary");
        const claudeRow = rows.find((r) => r[1] === "claude");
        const source = (summaryRow ?? claudeRow)?.[2] as string | undefined;
        let brief = "";
        if (source) {
          const firstLine = source.split("\n").find(l => l.trim() && !l.startsWith("#"));
          brief = firstLine?.trim() || "";
        }
        const badges = badgeTypes.filter(t => types.includes(t)).map(t => badgeLabels[t]);
        return { name: proj, brief, badges, fileCount: rows.length };
      });

      const lines: string[] = [`# Cortex Projects (${projects.length})`];
      if (profile) lines.push(`Profile: ${profile}`);
      lines.push(`Page: ${pageNum}/${totalPages} (page_size=${pageSize})`);
      lines.push(`Path: ${cortexPath}\n`);
      for (const p of projectList) {
        lines.push(`## ${p.name}`);
        if (p.brief) lines.push(p.brief);
        lines.push(`[${p.badges.join(" | ")}] - ${p.fileCount} file(s)\n`);
      }

      return jsonResponse({
        ok: true,
        message: lines.join("\n"),
        data: { projects: projectList, total: projects.length, page: pageNum, totalPages, pageSize },
      });
    }
  );

  // list_machines and list_profiles moved to CLI: cortex config machines|profiles

  server.registerTool(
    "get_backlog",
    {
      title: "◆ cortex · backlog",
      description: "Get a project's backlog, all backlogs, or a single item. Omit all params for all projects. Pass project for that project's backlog. Pass id or item to fetch a single entry.",
      inputSchema: z.object({
        project: z.string().optional().describe("Project name. Omit to get all projects."),
        id: z.string().optional().describe("Backlog item ID like A1, Q3, D2. Requires project."),
        item: z.string().optional().describe("Exact backlog item text. Requires project."),
      }),
    },
    async ({ project, id, item }) => {
      // Single item lookup
      if (id || item) {
        if (!project) return jsonResponse({ ok: false, error: "Provide `project` when looking up a single item." });
        if (!isValidProjectName(project)) return jsonResponse({ ok: false, error: `Invalid project name: "${project}"` });
        const result = readBacklog(cortexPath, project);
        if (!result.ok) return jsonResponse({ ok: false, error: result.error });
        const doc = result.data;
        const all = [...doc.items.Active, ...doc.items.Queue, ...doc.items.Done];
        const match = all.find((entry) =>
          (id && entry.id.toLowerCase() === id.toLowerCase()) ||
          (item && entry.line.trim() === item.trim())
        );
        if (!match) return jsonResponse({ ok: false, error: `No backlog item found in ${project} for ${id ? `id=${id}` : `item="${item}"`}.` });
        return jsonResponse({
          ok: true,
          message: `${match.id}: ${match.line} (${match.section})`,
          data: { project, id: match.id, section: match.section, checked: match.checked, line: match.line, context: match.context || null, priority: match.priority || null },
        });
      }

      // Full backlog for one project
      if (project) {
        if (!isValidProjectName(project)) return jsonResponse({ ok: false, error: `Invalid project name: "${project}"` });
        const result = readBacklog(cortexPath, project);
        if (!result.ok) return jsonResponse({ ok: false, error: result.error });
        const doc = result.data;
        if (!fs.existsSync(doc.path)) return jsonResponse({ ok: true, message: `No backlog found for "${project}".`, data: { project, items: { Active: [], Queue: [], Done: [] } } });
        return jsonResponse({ ok: true, message: `## ${project}\n${backlogMarkdown(doc)}`, data: { project, items: doc.items, issues: doc.issues } });
      }

      // All projects
      const docs = readBacklogs(cortexPath, profile);
      if (!docs.length) return jsonResponse({ ok: true, message: "No backlogs found.", data: { projects: [] } });
      const parts = docs.map((doc) => `## ${doc.project}\n${backlogMarkdown(doc)}`);
      const projectData = docs.map((doc) => ({ project: doc.project, items: doc.items, issues: doc.issues }));
      return jsonResponse({ ok: true, message: parts.join("\n\n"), data: { projects: projectData } });
    }
  );

  server.registerTool(
    "add_backlog_item",
    {
      title: "◆ cortex · add task",
      description: "Append a task to a project's backlog.md. Adds to the Queue section.",
      inputSchema: z.object({
        project: z.string().describe("Project name (must match a directory in your cortex)."),
        item: z.string().describe("The task to add."),
      }),
    },
    async ({ project, item }) => {
      if (!isValidProjectName(project)) return jsonResponse({ ok: false, error: `Invalid project name: "${project}"` });
      return withWriteQueue(async () => {
        const result = addBacklogItemStore(cortexPath, project, item);
        if (!result.ok) return jsonResponse({ ok: false, error: result.error });
        return jsonResponse({ ok: true, message: result.data, data: { project, item } });
      });
    }
  );

  server.registerTool(
    "add_backlog_items",
    {
      title: "◆ cortex · add tasks (bulk)",
      description: "Append multiple tasks to a project's backlog.md in one call. Adds to the Queue section.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        items: z.array(z.string()).describe("List of tasks to add."),
      }),
    },
    async ({ project, items }) => {
      if (!isValidProjectName(project)) return jsonResponse({ ok: false, error: `Invalid project name: "${project}"` });
      return withWriteQueue(async () => {
        const result = addBacklogItemsBatch(cortexPath, project, items);
        if (!result.ok) return jsonResponse({ ok: false, error: result.error });
        const { added, errors } = result.data;
        return jsonResponse({ ok: added.length > 0, message: `Added ${added.length} of ${items.length} items to ${project} backlog`, data: { project, added, errors } });
      });
    }
  );

  server.registerTool(
    "complete_backlog_item",
    {
      title: "◆ cortex · done",
      description: "Move a backlog item to the Done section by matching text.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        item: z.string().describe("Exact or partial text of the item to complete."),
      }),
    },
    async ({ project, item }) => {
      if (!isValidProjectName(project)) return jsonResponse({ ok: false, error: `Invalid project name: "${project}"` });
      return withWriteQueue(async () => {
        const result = completeBacklogItemStore(cortexPath, project, item);
        if (!result.ok) return jsonResponse({ ok: false, error: result.error });
        return jsonResponse({ ok: true, message: result.data, data: { project, item } });
      });
    }
  );

  server.registerTool(
    "complete_backlog_items",
    {
      title: "◆ cortex · done (bulk)",
      description: "Move multiple backlog items to Done in one call. Pass an array of partial item texts.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        items: z.array(z.string()).describe("List of partial item texts to complete."),
      }),
    },
    async ({ project, items }) => {
      if (!isValidProjectName(project)) return jsonResponse({ ok: false, error: `Invalid project name: "${project}"` });
      return withWriteQueue(async () => {
        const result = completeBacklogItemsBatch(cortexPath, project, items);
        if (!result.ok) return jsonResponse({ ok: false, error: result.error });
        const { completed, errors } = result.data;
        return jsonResponse({ ok: completed.length > 0, message: `Completed ${completed.length}/${items.length} items`, data: { project, completed, errors } });
      });
    }
  );

  server.registerTool(
    "update_backlog_item",
    {
      title: "◆ cortex · update task",
      description: "Update a backlog item's priority, context, or section by matching text.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        item: z.string().describe("Partial text to match against existing backlog items."),
        updates: z.object({
          priority: z.enum(["high", "medium", "low"]).optional().describe("New priority tag: high, medium, or low."),
          context: z.string().optional().describe("Text to append to (or create) the Context: line below the item."),
          section: z.enum(["queue", "active", "done", "Queue", "Active", "Done"]).optional().describe("Move item to this section: Queue, Active, or Done."),
        }).describe("Fields to update. All are optional."),
      }),
    },
    async ({ project, item, updates }) => {
      if (!isValidProjectName(project)) return jsonResponse({ ok: false, error: `Invalid project name: "${project}"` });
      return withWriteQueue(async () => {
        const result = updateBacklogItemStore(cortexPath, project, item, updates);
        if (!result.ok) return jsonResponse({ ok: false, error: result.error });
        return jsonResponse({ ok: true, message: result.data, data: { project, item, updates } });
      });
    }
  );

  server.registerTool(
    "add_learning",
    {
      title: "◆ cortex · save learning",
      description:
        "Record a single insight to a project's LEARNINGS.md. Call this the moment you discover " +
        "a non-obvious pattern, hit a subtle bug, find a workaround, or learn something that would " +
        "save time in a future session. Do not wait until the end of the session.",
      inputSchema: z.object({
        project: z.string().describe("Project name (must match a directory in your cortex)."),
        learning: z.string().describe("The insight, written as a single bullet point. Be specific enough that someone could act on it without extra context."),
        citation: z.object({
          file: z.string().optional().describe("Source file path that supports this learning."),
          line: z.number().int().positive().optional().describe("1-based line number in file."),
          repo: z.string().optional().describe("Git repository root path for citation validation."),
          commit: z.string().optional().describe("Git commit SHA that supports this learning."),
        }).optional().describe("Optional source citation for traceability."),
      }),
    },
    async ({ project, learning, citation }) => {
      if (!isValidProjectName(project)) return jsonResponse({ ok: false, error: `Invalid project name: "${project}"` });
      return withWriteQueue(async () => {
        runCustomHooks(cortexPath, "pre-learning", { CORTEX_PROJECT: project });
        const result = addLearningToFile(cortexPath, project, learning, citation);
        await rebuildIndex();
        const ok = result.ok && (result.data.startsWith("Added learning") || result.data.startsWith("Saved learning"));
        if (ok) runCustomHooks(cortexPath, "post-learning", { CORTEX_PROJECT: project });
        return jsonResponse({ ok, message: result.ok ? result.data : result.error, data: ok ? { project, learning } : undefined });
      });
    }
  );

  server.registerTool(
    "add_learnings",
    {
      title: "◆ cortex · save learnings (bulk)",
      description: "Record multiple insights to a project's LEARNINGS.md in one call.",
      inputSchema: z.object({
        project: z.string().describe("Project name (must match a directory in your cortex)."),
        learnings: z.array(z.string()).describe("List of insights to record."),
      }),
    },
    async ({ project, learnings }) => {
      if (!isValidProjectName(project)) return jsonResponse({ ok: false, error: `Invalid project name: "${project}"` });
      return withWriteQueue(async () => {
        runCustomHooks(cortexPath, "pre-learning", { CORTEX_PROJECT: project });
        const result = addLearningsToFile(cortexPath, project, learnings);
        if (!result.ok) return jsonResponse({ ok: false, error: result.error });
        const { added, skipped } = result.data;
        if (added.length > 0) runCustomHooks(cortexPath, "post-learning", { CORTEX_PROJECT: project });
        await rebuildIndex();
        return jsonResponse({ ok: added.length > 0, message: `Added ${added.length}/${learnings.length} learnings (${skipped.length} duplicates skipped)`, data: { project, added, skipped } });
      });
    }
  );

  server.registerTool(
    "get_learnings",
    {
      title: "◆ cortex · learnings",
      description: "List recent learnings for a project without requiring a search query.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        limit: z.number().int().min(1).max(200).optional().describe("Max rows to return (default 50)."),
      }),
    },
    async ({ project, limit }) => {
      if (!isValidProjectName(project)) return jsonResponse({ ok: false, error: `Invalid project name: "${project}"` });
      const result = readLearnings(cortexPath, project);
      if (!result.ok) return jsonResponse({ ok: false, error: result.error });
      const items = result.data;
      if (!items.length) return jsonResponse({ ok: true, message: `No learnings found for "${project}".`, data: { project, learnings: [], total: 0 } });
      const capped = items.slice(0, limit ?? 50);
      const lines = capped.map((entry) => `- [${entry.id}] ${entry.date}: ${entry.text}${entry.citation ? ` (${entry.citation})` : ""}`);
      return jsonResponse({
        ok: true,
        message: `Learnings for ${project} (${capped.length}/${items.length}):\n` + lines.join("\n"),
        data: { project, learnings: capped, total: items.length },
      });
    }
  );

  server.registerTool(
    "remove_learning",
    {
      title: "◆ cortex · remove learning",
      description:
        "Remove a learning from a project's LEARNINGS.md by matching text. Use this when a " +
        "previously captured insight turns out to be wrong, outdated, or no longer relevant.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        learning: z.string().describe("Partial text to match against existing learnings."),
      }),
    },
    async ({ project, learning }) => {
      if (!isValidProjectName(project)) return jsonResponse({ ok: false, error: `Invalid project name: "${project}"` });
      return withWriteQueue(async () => {
        const result = removeLearningStore(cortexPath, project, learning);
        await rebuildIndex();
        if (!result.ok) return jsonResponse({ ok: false, error: result.error });
        return jsonResponse({ ok: true, message: result.data, data: { project, learning } });
      });
    }
  );

  server.registerTool(
    "push_changes",
    {
      title: "◆ cortex · push",
      description:
        "Commit and push any changes in the cortex repo. Call this at the end of a session " +
        "or after adding multiple learnings/backlog items. Commits all modified files in the " +
        "cortex directory and pushes if a remote is configured.",
      inputSchema: z.object({
        message: z.string().optional().describe("Commit message. Defaults to 'update cortex'."),
      }),
    },
    async ({ message }) => {
      return withWriteQueue(async () => {
        const { execFileSync } = await import("child_process");
        const runGit = (args: string[], opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {}): string => execFileSync(
          "git",
          args,
          {
            cwd: cortexPath,
            encoding: "utf8",
            timeout: opts.timeout ?? EXEC_TIMEOUT_MS,
            env: opts.env,
            stdio: ["ignore", "pipe", "pipe"],
          }
        ).trim();

        try {
          const status = runGit(["status", "--porcelain"]);
          if (!status) return jsonResponse({ ok: true, message: "Nothing to save. Cortex is up to date.", data: { files: 0, pushed: false } });
          const files = status.split("\n").filter(Boolean);
          const projectNames = Array.from(
            new Set(
              files
                .map((line) => line.slice(3).trim().split("/")[0])
                .filter((name) => name && !name.startsWith(".") && name !== "profiles")
            )
          );
          const commitMsg = message || `cortex: save ${files.length} file(s) across ${projectNames.length} project(s)`;

          runCustomHooks(cortexPath, "pre-save");
          runGit(["add", "-A"]);
          runGit(["commit", "-m", commitMsg]);

          // Check if remote exists
          let hasRemote = false;
          try {
            const remotes = runGit(["remote"]);
            hasRemote = remotes.length > 0;
          } catch { /* no remote */ }

          if (!hasRemote) {
            const changedFiles = status.split("\n").length;
            return jsonResponse({ ok: true, message: `Saved ${changedFiles} changed file(s). No remote configured, skipping push.`, data: { files: changedFiles, pushed: false } });
          }

          // Push with retry: on failure, pull --rebase then retry up to 3 times
          let pushed = false;
          let lastPushError = "";
          const delays = [2000, 4000, 8000];

          for (let attempt = 0; attempt <= 3; attempt++) {
            try {
              runGit(["push"], { timeout: 15000 });
              pushed = true;
              break;
            } catch (pushErr: any) {
              lastPushError = pushErr.message ?? String(pushErr);
              debugLog(`Push attempt ${attempt + 1} failed: ${lastPushError}`);

              if (attempt < 3) {
                // Pull --rebase to incorporate remote changes
                try {
                  runGit(["pull", "--rebase", "--quiet"], { timeout: 15000 });
                } catch {
                  // Rebase hit conflicts — try auto-merge for LEARNINGS.md / backlog.md
                  const resolved = autoMergeConflicts(cortexPath);
                  if (resolved) {
                    try {
                      runGit(["rebase", "--continue"], {
                        timeout: 10000,
                        env: { ...process.env, GIT_EDITOR: "true" },
                      });
                    } catch {
                      // Rebase continue failed, abort and give up
                      try { runGit(["rebase", "--abort"]); } catch { /* ignore */ }
                      break;
                    }
                  } else {
                    // Unresolvable conflicts — abort rebase
                    try { runGit(["rebase", "--abort"]); } catch { /* ignore */ }
                    break;
                  }
                }

                // Exponential backoff before retry
                await new Promise(r => setTimeout(r, delays[attempt]));
              }
            }
          }

          const changedFiles = status.split("\n").length;
          runCustomHooks(cortexPath, "post-save", { CORTEX_FILES_CHANGED: String(changedFiles), CORTEX_PUSHED: String(pushed) });
          if (pushed) {
            return jsonResponse({ ok: true, message: `Saved ${changedFiles} changed file(s). Pushed to remote.`, data: { files: changedFiles, pushed: true } });
          } else {
            return jsonResponse({
              ok: true,
              message: `Changes were committed but push failed.\n\nGit error: ${lastPushError}\n\nRun 'git push' manually from your cortex directory.`,
              data: { files: changedFiles, pushed: false, pushError: lastPushError },
            });
          }
        } catch (err: any) {
          return jsonResponse({ ok: false, error: `Save failed: ${err.message}` });
        }
      });
    }
  );

  // ── #209: Export/Import ──────────────────────────────────────────────────

  server.registerTool(
    "export_project",
    {
      title: "◆ cortex · export",
      description: "Export a project's data (learnings, backlog, summary) as portable JSON for sharing or backup.",
      inputSchema: z.object({
        project: z.string().describe("Project name to export."),
      }),
    },
    async ({ project }) => {
      if (!isValidProjectName(project)) return jsonResponse({ ok: false, error: `Invalid project name: "${project}"` });
      const projectDir = path.join(cortexPath, project);
      if (!fs.existsSync(projectDir)) return jsonResponse({ ok: false, error: `Project "${project}" not found.` });

      const exported: Record<string, unknown> = { project, exportedAt: new Date().toISOString(), version: 1 };

      const summaryPath = path.join(projectDir, "summary.md");
      if (fs.existsSync(summaryPath)) exported.summary = fs.readFileSync(summaryPath, "utf8");

      const learningsResult = readLearnings(cortexPath, project);
      if (learningsResult.ok) exported.learnings = learningsResult.data;

      const backlogResult = readBacklog(cortexPath, project);
      if (backlogResult.ok) exported.backlog = backlogResult.data.items;

      const claudePath = path.join(projectDir, "CLAUDE.md");
      if (fs.existsSync(claudePath)) exported.claudeMd = fs.readFileSync(claudePath, "utf8");

      return jsonResponse({ ok: true, message: `Exported project "${project}".`, data: exported });
    }
  );

  server.registerTool(
    "import_project",
    {
      title: "◆ cortex · import",
      description: "Import project data from a previously exported JSON payload. Creates the project directory if needed.",
      inputSchema: z.object({
        data: z.string().describe("JSON string from a previous export_project call."),
      }),
    },
    async ({ data: rawData }) => {
      return withWriteQueue(async () => {
        let parsed: any;
        try {
          parsed = JSON.parse(rawData);
        } catch {
          return jsonResponse({ ok: false, error: "Invalid JSON input." });
        }

        if (!parsed.project || typeof parsed.project !== "string") {
          return jsonResponse({ ok: false, error: "Missing 'project' field in import data." });
        }
        if (!isValidProjectName(parsed.project)) {
          return jsonResponse({ ok: false, error: `Invalid project name: "${parsed.project}"` });
        }

        const projectDir = path.join(cortexPath, parsed.project);
        fs.mkdirSync(projectDir, { recursive: true });
        const imported: string[] = [];

        if (parsed.summary && typeof parsed.summary === "string") {
          fs.writeFileSync(path.join(projectDir, "summary.md"), parsed.summary);
          imported.push("summary.md");
        }

        if (parsed.claudeMd && typeof parsed.claudeMd === "string") {
          fs.writeFileSync(path.join(projectDir, "CLAUDE.md"), parsed.claudeMd);
          imported.push("CLAUDE.md");
        }

        if (Array.isArray(parsed.learnings) && parsed.learnings.length > 0) {
          const date = new Date().toISOString().slice(0, 10);
          const lines = [`# ${parsed.project} Learnings`, "", `## ${date}`, ""];
          for (const item of parsed.learnings) {
            if (item && typeof item.text === "string") {
              lines.push(`- ${item.text}`);
            }
          }
          lines.push("");
          fs.writeFileSync(path.join(projectDir, "LEARNINGS.md"), lines.join("\n"));
          imported.push("LEARNINGS.md");
        }

        if (parsed.backlog && typeof parsed.backlog === "object") {
          const sections = ["Active", "Queue", "Done"] as const;
          const lines = [`# ${parsed.project} backlog`, ""];
          for (const section of sections) {
            lines.push(`## ${section}`, "");
            const items = parsed.backlog[section];
            if (Array.isArray(items)) {
              for (const item of items) {
                if (item && typeof item.line === "string") {
                  const prefix = item.checked || section === "Done" ? "- [x] " : "- [ ] ";
                  lines.push(`${prefix}${item.line}`);
                  if (item.context) lines.push(`  Context: ${item.context}`);
                }
              }
            }
            lines.push("");
          }
          fs.writeFileSync(path.join(projectDir, "backlog.md"), lines.join("\n"));
          imported.push("backlog.md");
        }

        await rebuildIndex();
        return jsonResponse({
          ok: true,
          message: `Imported project "${parsed.project}": ${imported.join(", ")}`,
          data: { project: parsed.project, files: imported },
        });
      });
    }
  );

  // ── #210: Archive/Unarchive ────────────────────────────────────────────

  server.registerTool(
    "manage_project",
    {
      title: "◆ cortex · manage project",
      description: "Archive or unarchive a project. Archive moves it out of the active index without deleting data (renamed with .archived suffix). Unarchive restores it.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        action: z.enum(["archive", "unarchive"]).describe("Action to perform."),
      }),
    },
    async ({ project, action }) => {
      if (!isValidProjectName(project)) return jsonResponse({ ok: false, error: `Invalid project name: "${project}"` });
      const projectDir = path.join(cortexPath, project);
      const archiveDir = path.join(cortexPath, `${project}.archived`);

      if (action === "archive") {
        if (!fs.existsSync(projectDir)) {
          return jsonResponse({ ok: false, error: `Project "${project}" not found.` });
        }
        if (fs.existsSync(archiveDir)) {
          return jsonResponse({ ok: false, error: `Archive "${project}.archived" already exists. Unarchive or remove it first.` });
        }

        fs.renameSync(projectDir, archiveDir);
        await rebuildIndex();
        return jsonResponse({
          ok: true,
          message: `Archived project "${project}". Data preserved at ${archiveDir}.`,
          data: { project, archivePath: archiveDir },
        });
      }

      // unarchive
      if (fs.existsSync(projectDir)) {
        return jsonResponse({ ok: false, error: `Project "${project}" already exists as an active project.` });
      }
      if (!fs.existsSync(archiveDir)) {
        const entries = fs.readdirSync(cortexPath).filter((e) => e.endsWith(".archived"));
        const available = entries.map((e) => e.replace(/\.archived$/, ""));
        return jsonResponse({ ok: false, error: `No archive found for "${project}".`, data: { availableArchives: available } });
      }

      fs.renameSync(archiveDir, projectDir);
      await rebuildIndex();
      return jsonResponse({
        ok: true,
        message: `Unarchived project "${project}". It is now active again.`,
        data: { project, path: projectDir },
      });
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`cortex-mcp running (${cortexPath})`);
}

main().catch((err) => {
  console.error("Failed to start cortex-mcp:", err);
  process.exit(1);
});

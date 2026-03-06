#!/usr/bin/env node

import { parseMcpMode, runInit } from "./init.js";
import * as os from "os";

if (process.argv[2] === "--help" || process.argv[2] === "-h" || process.argv[2] === "help") {
  console.log(`cortex - Long-term memory for Claude Code

Usage:
  cortex                                 Open interactive shell
  cortex init [--machine <n>] [--profile <n>] [--mcp on|off]
                                         Set up cortex in ~/.cortex
  cortex status                          Health, active project, stats
  cortex search <query> [--project <n>] [--type <t>] [--limit <n>]
                                         Search your knowledge base
  cortex add-learning <project> "..."    Save an insight
  cortex pin-memory <project> "..."      Pin a canonical memory
  cortex backlog                         Cross-project backlog view
  cortex skill-list                      List installed skills
  cortex doctor [--fix]                  Health check and self-heal
  cortex memory-ui [--port=3499]         Memory review web UI
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
`);
  process.exit(0);
}

if (process.argv[2] === "init") {
  const initArgs = process.argv.slice(3);
  const machineIdx = initArgs.indexOf("--machine");
  const profileIdx = initArgs.indexOf("--profile");
  const mcpIdx = initArgs.indexOf("--mcp");
  const mcpMode = mcpIdx !== -1 ? parseMcpMode(initArgs[mcpIdx + 1]) : undefined;
  if (mcpIdx !== -1 && !mcpMode) {
    console.error(`Invalid --mcp value "${initArgs[mcpIdx + 1] || ""}". Use "on" or "off".`);
    process.exit(1);
  }
  await runInit({
    machine: machineIdx !== -1 ? initArgs[machineIdx + 1] : undefined,
    profile: profileIdx !== -1 ? initArgs[profileIdx + 1] : undefined,
    mcp: mcpMode,
    applyStarterUpdate: initArgs.includes("--apply-starter-update"),
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
  const cortexPath = process.env.CORTEX_PATH || os.homedir() + "/.cortex";
  const result = runPostInitVerify(cortexPath);
  console.log(`cortex verify: ${result.ok ? "ok" : "issues found"}`);
  for (const check of result.checks) {
    console.log(`  ${check.ok ? "pass" : "FAIL"} ${check.name}: ${check.detail}`);
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
  await runLink(process.env.CORTEX_PATH || os.homedir() + "/.cortex", {
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
  "memory-ui",
  "quality-feedback",
  "skill-list",
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
  await runCliCommand(process.argv[2], process.argv.slice(3));
  process.exit(0);
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { isValidProjectName, buildRobustFtsQuery } from "./utils.js";
import {
  addBacklogItem as addBacklogItemStore,
  backlogMarkdown,
  completeBacklogItem as completeBacklogItemStore,
  readBacklog,
  readBacklogs,
  removeLearning as removeLearningStore,
  updateBacklogItem as updateBacklogItemStore,
} from "./data-access.js";
import {
  findCortexPathWithArg,
  buildIndex,
  extractSnippet,
  queryRows,
  addLearningToFile,
  autoMergeConflicts,
  debugLog,
  upsertCanonicalMemory,
  recordMemoryFeedback,
} from "./shared.js";

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

async function main() {
  let db = await buildIndex(cortexPath, profile);
  async function rebuildIndex() {
    try { db.close(); } catch { /* best effort */ }
    db = await buildIndex(cortexPath, profile);
  }

  const server = new McpServer({
    name: "cortex-mcp",
    version: PACKAGE_VERSION,
  });

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
      const result = upsertCanonicalMemory(cortexPath, project, memory);
      return textResponse(result);
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
      recordMemoryFeedback(cortexPath, key, feedback);
      return textResponse(`Recorded feedback ${feedback} for ${key}`);
    }
  );

  server.registerTool(
    "search_cortex",
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
      }),
    },
    async ({ query, limit, project, type }) => {
      try {
        const maxResults = limit ?? 5;
        const filterType = type === "skills" ? "skill" : type;
        const filterProject = project?.trim();
        if (filterProject && !isValidProjectName(filterProject)) {
          return textResponse(`Invalid project name: "${project}"`);
        }
        const safeQuery = buildRobustFtsQuery(query);

        if (!safeQuery) return textResponse("Search query is empty after sanitization.");

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

        const rows = queryRows(db, sql, params);
        if (!rows) {
          const scope: string[] = [`"${query}"`];
          if (filterProject) scope.push(`project=${filterProject}`);
          if (filterType) scope.push(`type=${filterType}`);
          return textResponse(`No results found for ${scope.join(", ")}`);
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

        const formatted = scored.map(({ row }) => {
          const [project, filename, docType, content, filePath] = row as string[];
          const snippet = extractSnippet(content, query);
          return `### ${project}/${filename} (${docType})\n${snippet}\n\n\`${filePath}\``;
        });

        const scope: string[] = [`"${query}"`];
        if (filterProject) scope.push(`project=${filterProject}`);
        if (filterType) scope.push(`type=${filterType}`);
        return textResponse(`Found ${rows.length} result(s) for ${scope.join(", ")}:\n\n${formatted.join("\n\n---\n\n")}`);
      } catch (err: any) {
        return textResponse(`Search error: ${err.message}`);
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
        const names = projectRows ? projectRows.map((r: any[]) => r[0]).join(", ") : "(none)";
        return textResponse(`Project "${name}" not found.\n\nAvailable projects: ${names}`);
      }

      const summaryRow = queryRows(db, "SELECT content, path FROM docs WHERE project = ? AND type = 'summary'", [name]);
      const claudeRow = queryRows(db, "SELECT content, path FROM docs WHERE project = ? AND type = 'claude'", [name]);

      const parts: string[] = [`# ${name}`];

      if (summaryRow) {
        parts.push(`\n## Summary\n${summaryRow[0][0]}`);
      } else {
        parts.push("\n*No summary.md found for this project.*");
      }

      if (claudeRow) {
        parts.push(`\n## CLAUDE.md path\n\`${claudeRow[0][1]}\``);
      }

      const fileList = files.map((f: any[]) => `- ${f[0]} (${f[1]})`).join("\n");
      parts.push(`\n## Indexed files\n${fileList}`);

      return textResponse(parts.join("\n"));
    }
  );

  server.registerTool(
    "list_projects",
    {
      title: "◆ cortex · projects",
      description:
        "List all projects in the active cortex profile with a brief summary of each. " +
        "Shows which documentation files exist per project.",
      inputSchema: z.object({}),
    },
    async () => {
      const projectRows = queryRows(db, "SELECT DISTINCT project FROM docs ORDER BY project", []);
      if (!projectRows) return textResponse("No projects indexed.");

      const projects = projectRows.map((r: any[]) => r[0] as string);

      const lines: string[] = [`# Cortex Projects (${projects.length})`];
      if (profile) lines.push(`Profile: ${profile}`);
      lines.push(`Path: ${cortexPath}\n`);

      const badgeTypes = ["claude", "learnings", "summary", "backlog"] as const;
      const badgeLabels: Record<string, string> = { claude: "CLAUDE.md", learnings: "LEARNINGS", summary: "summary", backlog: "backlog" };

      for (const proj of projects) {
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

        const badges = badgeTypes.filter(t => types.includes(t)).map(t => badgeLabels[t]).join(" | ");

        lines.push(`## ${proj}`);
        if (brief) lines.push(brief);
        lines.push(`[${badges}] - ${rows.length} file(s)\n`);
      }

      return textResponse(lines.join("\n"));
    }
  );

  // list_machines and list_profiles moved to CLI: cortex config machines|profiles

  server.registerTool(
    "get_backlog",
    {
      title: "◆ cortex · backlog",
      description: "Get the backlog for a project, or all projects if no name given. Returns active and queued items.",
      inputSchema: z.object({
        project: z.string().optional().describe("Project name. Omit to get all projects."),
      }),
    },
    async ({ project }) => {
      if (project) {
        if (!isValidProjectName(project)) return textResponse(`Invalid project name: "${project}"`);
        const doc = readBacklog(cortexPath, project);
        if (typeof doc === "string") return textResponse(doc);
        if (!fs.existsSync(doc.path)) return textResponse(`No backlog found for "${project}".`);
        return textResponse(`## ${project}\n${backlogMarkdown(doc)}`);
      }

      const docs = readBacklogs(cortexPath, profile);
      const parts = docs.map((doc) => `## ${doc.project}\n${backlogMarkdown(doc)}`);
      if (!parts.length) return textResponse("No backlogs found.");
      return textResponse(parts.join("\n\n"));
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
      if (!isValidProjectName(project)) return textResponse(`Invalid project name: "${project}"`);
      const result = addBacklogItemStore(cortexPath, project, item);
      return textResponse(result);
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
      if (!isValidProjectName(project)) return textResponse(`Invalid project name: "${project}"`);
      const result = completeBacklogItemStore(cortexPath, project, item);
      return textResponse(result);
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
          priority: z.string().optional().describe("New priority tag: high, medium, or low."),
          context: z.string().optional().describe("Text to append to (or create) the Context: line below the item."),
          section: z.string().optional().describe("Move item to this section: Queue, Active, or Done."),
        }).describe("Fields to update. All are optional."),
      }),
    },
    async ({ project, item, updates }) => {
      if (!isValidProjectName(project)) return textResponse(`Invalid project name: "${project}"`);
      const result = updateBacklogItemStore(cortexPath, project, item, updates);
      return textResponse(result);
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
        citation_file: z.string().optional().describe("Optional source file path that supports this learning."),
        citation_line: z.number().int().positive().optional().describe("Optional 1-based line number in citation_file."),
        citation_repo: z.string().optional().describe("Optional git repository root path for citation validation."),
        citation_commit: z.string().optional().describe("Optional git commit SHA that supports this learning."),
      }),
    },
    async ({ project, learning, citation_file, citation_line, citation_repo, citation_commit }) => {
      if (!isValidProjectName(project)) return textResponse(`Invalid project name: "${project}"`);
      const result = addLearningToFile(cortexPath, project, learning, {
        file: citation_file,
        line: citation_line,
        repo: citation_repo,
        commit: citation_commit,
      });
      await rebuildIndex();
      return textResponse(result);
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
      const result = removeLearningStore(cortexPath, project, learning);
      await rebuildIndex();
      return textResponse(result);
    }
  );

  server.registerTool(
    "save_learnings",
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
      const { execFileSync } = await import("child_process");
      const commitMsg = message || "update cortex";
      const DEFAULT_GIT_TIMEOUT = 30_000;
      const runGit = (args: string[], opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {}): string => execFileSync(
        "git",
        args,
        {
          cwd: cortexPath,
          encoding: "utf8",
          timeout: opts.timeout ?? DEFAULT_GIT_TIMEOUT,
          env: opts.env,
          stdio: ["ignore", "pipe", "pipe"],
        }
      ).trim();

      try {
        const status = runGit(["status", "--porcelain"]);
        if (!status) return textResponse("Nothing to save. Cortex is up to date.");

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
          return textResponse(`Saved ${changedFiles} changed file(s). (No remote configured — skipping push.)`);
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
        if (pushed) {
          return textResponse(`Saved ${changedFiles} changed file(s). Pushed to remote.`);
        } else {
          return textResponse(`Saved ${changedFiles} changed file(s) locally. Push failed: ${lastPushError}`);
        }
      } catch (err: any) {
        return textResponse(`Save failed: ${err.message}`);
      }
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

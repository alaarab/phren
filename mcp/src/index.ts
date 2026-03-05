#!/usr/bin/env node

import { runInit } from "./init.js";

if (process.argv[2] === "init") {
  await runInit();
  process.exit(0);
}

if (process.argv[2] === "--health") {
  process.exit(0);
}

// CLI subcommands (run before MCP server starts)
const CLI_COMMANDS = ["search", "hook-prompt", "hook-context", "add-learning"];
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
import * as yaml from "js-yaml";
import { isValidProjectName, safeProjectPath, sanitizeFts5Query, expandSynonyms } from "./utils.js";
import { findCortexPathWithArg, buildIndex, extractSnippet, queryRows, addLearningToFile } from "./shared.js";

// MCP mode: first non-flag arg is the cortex path
const cortexArg = process.argv.find((a, i) => i >= 2 && !a.startsWith("-"));
const cortexPath = findCortexPathWithArg(cortexArg);
const profile = process.env.CORTEX_PROFILE || "";

function textResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

async function main() {
  const db = await buildIndex(cortexPath, profile);

  const server = new McpServer({
    name: "cortex-mcp",
    version: "1.7.2",
  });

  server.registerTool(
    "search_cortex",
    {
      title: "Search Cortex",
      description: "Search the user's personal knowledge base. Call this at the start of any session to get project context, and any time the user asks about their codebase, stack, architecture, past decisions, commands, conventions, or lessons learned. Prefer this over asking the user to re-explain things they've already documented.",
      inputSchema: z.object({
        query: z.string().describe("Search query (supports FTS5 syntax: AND, OR, NOT, phrase matching with quotes)"),
        limit: z.number().min(1).max(20).optional().describe("Max results to return (1-20, default 5)"),
        type: z.enum(["claude", "learnings", "knowledge", "skills", "summary", "backlog", "changelog", "skill", "other"])
          .optional()
          .describe("Filter by document type: claude, learnings, knowledge, summary, backlog, skill"),
      }),
    },
    async ({ query, limit, type }) => {
      try {
        const maxResults = limit ?? 5;
        const filterType = type === "skills" ? "skill" : type;
        const safeQuery = expandSynonyms(sanitizeFts5Query(query));

        if (!safeQuery) return textResponse("Search query is empty after sanitization.");

        const sql = filterType
          ? `SELECT project, filename, type, content, path FROM docs WHERE docs MATCH ? AND type = ? ORDER BY rank LIMIT ?`
          : `SELECT project, filename, type, content, path FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT ?`;
        const params: (string | number)[] = filterType
          ? [safeQuery, filterType, maxResults]
          : [safeQuery, maxResults];

        const rows = queryRows(db, sql, params);
        if (!rows) return textResponse(`No results found for "${query}"`);

        const formatted = rows.map((row: any[]) => {
          const [project, filename, docType, content, filePath] = row as string[];
          const snippet = extractSnippet(content, query);
          return `### ${project}/${filename} (${docType})\n${snippet}\n\n\`${filePath}\``;
        });

        return textResponse(`Found ${rows.length} result(s) for "${query}":\n\n${formatted.join("\n\n---\n\n")}`);
      } catch (err: any) {
        return textResponse(`Search error: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "get_project_summary",
    {
      title: "Get Project Summary",
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
      title: "List Projects",
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

  server.registerTool(
    "list_machines",
    {
      title: "List Machines",
      description: "Show which machines are registered and which profile each uses. Useful for understanding the multi-machine setup.",
      inputSchema: z.object({}),
    },
    async () => {
      const machinesPath = path.join(cortexPath, "machines.yaml");
      if (!fs.existsSync(machinesPath)) return textResponse("No machines.yaml found. Run `./link.sh` to register this machine.");
      const raw = fs.readFileSync(machinesPath, "utf8");
      const data = yaml.load(raw) as Record<string, string> | null;
      if (!data || typeof data !== "object") return textResponse("machines.yaml is empty or invalid.");
      const lines = Object.entries(data).map(([machine, prof]) => `- ${machine}: ${prof}`);
      return textResponse(`# Registered Machines\n\n${lines.join("\n")}`);
    }
  );

  server.registerTool(
    "list_profiles",
    {
      title: "List Profiles",
      description: "Show all profiles and which projects each includes. Profiles control which projects are visible on each machine.",
      inputSchema: z.object({}),
    },
    async () => {
      const profilesDir = path.join(cortexPath, "profiles");
      if (!fs.existsSync(profilesDir)) return textResponse("No profiles directory found.");
      const files = fs.readdirSync(profilesDir).filter(f => f.endsWith(".yaml"));
      if (!files.length) return textResponse("No profiles found.");
      const parts = files.map(file => {
        const raw = fs.readFileSync(path.join(profilesDir, file), "utf8");
        const data = yaml.load(raw) as Record<string, unknown> | null;
        const name = (data?.name as string) || file.replace(".yaml", "");
        const projects = Array.isArray(data?.projects) ? (data.projects as string[]) : [];
        return `## ${name}\n${projects.map(p => `- ${p}`).join("\n") || "(no projects)"}`;
      });
      return textResponse(`# Profiles\n\n${parts.join("\n\n")}`);
    }
  );

  server.registerTool(
    "get_backlog",
    {
      title: "Get Backlog",
      description: "Get the backlog for a project, or all projects if no name given. Returns active and queued items.",
      inputSchema: z.object({
        project: z.string().optional().describe("Project name. Omit to get all projects."),
      }),
    },
    async ({ project }) => {
      const sql = project
        ? "SELECT project, content, path FROM docs WHERE project = ? AND type = 'backlog'"
        : "SELECT project, content, path FROM docs WHERE type = 'backlog' ORDER BY project";
      const params = project ? [project] : [];
      const rows = queryRows(db, sql, params);
      if (!rows) return textResponse(project ? `No backlog found for "${project}".` : "No backlogs found.");
      const parts = rows.map((r) => `## ${r[0]}\n${r[1]}`);
      return textResponse(parts.join("\n\n"));
    }
  );

  server.registerTool(
    "add_backlog_item",
    {
      title: "Add Backlog Item",
      description: "Append a task to a project's backlog.md. Adds to the Queue section.",
      inputSchema: z.object({
        project: z.string().describe("Project name (must match a directory in your cortex)."),
        item: z.string().describe("The task to add."),
      }),
    },
    async ({ project, item }) => {
      if (!isValidProjectName(project)) return textResponse(`Invalid project name: "${project}".`);
      const resolvedDir = safeProjectPath(cortexPath, project);
      if (!resolvedDir) return textResponse(`Invalid project name: "${project}".`);
      const backlogPath = path.join(resolvedDir, "backlog.md");
      if (!fs.existsSync(backlogPath)) {
        if (!fs.existsSync(resolvedDir)) return textResponse(`Project "${project}" not found in cortex.`);
        fs.writeFileSync(backlogPath, `# ${project} backlog\n\n## Active\n\n## Queue\n\n- ${item}\n\n## Done\n`);
        return textResponse(`Created backlog.md for "${project}" and added: ${item}`);
      }
      const content = fs.readFileSync(backlogPath, "utf8");
      const queueMatch = content.match(/^(## Queue\s*\n)/m);
      const updated = queueMatch
        ? content.replace(queueMatch[0], `${queueMatch[0]}\n- ${item}\n`)
        : content + `\n- ${item}\n`;
      fs.writeFileSync(backlogPath, updated);
      return textResponse(`Added to ${project} backlog: ${item}`);
    }
  );

  server.registerTool(
    "complete_backlog_item",
    {
      title: "Complete Backlog Item",
      description: "Move a backlog item to the Done section by matching text.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        item: z.string().describe("Exact or partial text of the item to complete."),
      }),
    },
    async ({ project, item }) => {
      if (!isValidProjectName(project)) return textResponse(`Invalid project name: "${project}".`);
      const resolvedDir = safeProjectPath(cortexPath, project);
      if (!resolvedDir) return textResponse(`Invalid project name: "${project}".`);
      const backlogPath = path.join(resolvedDir, "backlog.md");
      if (!fs.existsSync(backlogPath)) return textResponse(`No backlog found for "${project}".`);
      const content = fs.readFileSync(backlogPath, "utf8");
      const lines = content.split("\n");
      const idx = lines.findIndex(l => l.match(/^- /) && l.toLowerCase().includes(item.toLowerCase()));
      if (idx === -1) return textResponse(`No item matching "${item}" found in ${project} backlog.`);
      const matched = lines[idx];
      const removed = lines.filter((_, i) => i !== idx).join("\n");
      const doneMatch = removed.match(/^(## Done\s*\n)/m);
      const updated = doneMatch
        ? removed.replace(doneMatch[0], `${doneMatch[0]}\n${matched}\n`)
        : removed + `\n## Done\n\n${matched}\n`;
      fs.writeFileSync(backlogPath, updated);
      return textResponse(`Marked done in ${project}: ${matched.replace(/^- /, "")}`);
    }
  );

  server.registerTool(
    "update_backlog_item",
    {
      title: "Update Backlog Item",
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
      if (!isValidProjectName(project)) return textResponse(`Invalid project name: "${project}".`);
      const resolvedDir = safeProjectPath(cortexPath, project);
      if (!resolvedDir) return textResponse(`Invalid project name: "${project}".`);
      const backlogPath = path.join(resolvedDir, "backlog.md");
      if (!fs.existsSync(backlogPath)) return textResponse(`No backlog found for "${project}".`);

      let lines = fs.readFileSync(backlogPath, "utf8").split("\n");

      const idx = lines.findIndex(l => l.match(/^- /) && l.toLowerCase().includes(item.toLowerCase()));
      if (idx === -1) return textResponse(`No item matching "${item}" found in ${project} backlog.`);

      const changes: string[] = [];

      if (updates.priority) {
        const before = lines[idx];
        lines[idx] = lines[idx].replace(/\s*\[(high|medium|low)\]/gi, "").trimEnd() + ` [${updates.priority}]`;
        if (lines[idx] !== before) changes.push(`priority -> ${updates.priority}`);
      }

      if (updates.context) {
        const contextLineIdx = idx + 1;
        const hasContext = contextLineIdx < lines.length && lines[contextLineIdx].trim().startsWith("Context:");
        if (hasContext) {
          lines[contextLineIdx] = lines[contextLineIdx].trimEnd() + "; " + updates.context;
        } else {
          lines.splice(contextLineIdx, 0, `  Context: ${updates.context}`);
        }
        changes.push(`context updated`);
      }

      if (updates.section) {
        const targetSection = updates.section;
        const sectionPattern = new RegExp(`^## ${targetSection}\\s*$`, "i");

        const itemLine = lines[idx];
        const contextIdx = idx + 1;
        const hasContext = contextIdx < lines.length && lines[contextIdx].trim().startsWith("Context:");
        const extraLine = hasContext ? lines[contextIdx] : null;

        const removeCount = extraLine !== null ? 2 : 1;
        lines.splice(idx, removeCount);

        const targetIdx = lines.findIndex(l => sectionPattern.test(l));
        if (targetIdx === -1) {
          lines.push(`\n## ${targetSection}\n`, itemLine);
          if (extraLine) lines.push(extraLine);
        } else {
          let insertAt = targetIdx + 1;
          if (insertAt < lines.length && lines[insertAt].trim() === "") insertAt++;
          const toInsert = extraLine !== null ? [itemLine, extraLine] : [itemLine];
          lines.splice(insertAt, 0, ...toInsert);
        }

        changes.push(`moved to ${targetSection}`);
      }

      fs.writeFileSync(backlogPath, lines.join("\n"));
      return textResponse(`Updated item in ${project}: ${changes.join(", ")}`);
    }
  );

  server.registerTool(
    "add_learning",
    {
      title: "Add Learning",
      description:
        "Record a single insight to a project's LEARNINGS.md. Call this the moment you discover " +
        "a non-obvious pattern, hit a subtle bug, find a workaround, or learn something that would " +
        "save time in a future session. Do not wait until the end of the session.",
      inputSchema: z.object({
        project: z.string().describe("Project name (must match a directory in your cortex)."),
        learning: z.string().describe("The insight, written as a single bullet point. Be specific enough that someone could act on it without extra context."),
      }),
    },
    async ({ project, learning }) => {
      const result = addLearningToFile(cortexPath, project, learning);
      return textResponse(result);
    }
  );

  server.registerTool(
    "remove_learning",
    {
      title: "Remove Learning",
      description:
        "Remove a learning from a project's LEARNINGS.md by matching text. Use this when a " +
        "previously captured insight turns out to be wrong, outdated, or no longer relevant.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        learning: z.string().describe("Partial text to match against existing learnings."),
      }),
    },
    async ({ project, learning }) => {
      if (!isValidProjectName(project)) return textResponse(`Invalid project name: "${project}".`);
      const resolvedDir = safeProjectPath(cortexPath, project);
      if (!resolvedDir) return textResponse(`Invalid project name: "${project}".`);
      const learningsPath = path.join(resolvedDir, "LEARNINGS.md");
      if (!fs.existsSync(learningsPath)) return textResponse(`No LEARNINGS.md found for "${project}".`);

      const content = fs.readFileSync(learningsPath, "utf8");
      const lines = content.split("\n");
      const idx = lines.findIndex(l => l.startsWith("- ") && l.toLowerCase().includes(learning.toLowerCase()));
      if (idx === -1) return textResponse(`No learning matching "${learning}" found in ${project}.`);

      const matched = lines[idx];
      lines.splice(idx, 1);
      fs.writeFileSync(learningsPath, lines.join("\n"));
      return textResponse(`Removed from ${project}: ${matched}`);
    }
  );

  server.registerTool(
    "save_learnings",
    {
      title: "Save Learnings",
      description:
        "Commit and push any changes in the cortex repo. Call this at the end of a session " +
        "or after adding multiple learnings/backlog items. Commits all modified files in the " +
        "cortex directory and pushes if a remote is configured.",
      inputSchema: z.object({
        message: z.string().optional().describe("Commit message. Defaults to 'update cortex'."),
      }),
    },
    async ({ message }) => {
      const { execSync } = await import("child_process");
      const commitMsg = message || "update cortex";

      try {
        const status = execSync("git status --porcelain", { cwd: cortexPath, encoding: "utf8" }).trim();
        if (!status) return textResponse("Nothing to save. Cortex is up to date.");

        execSync("git add -A", { cwd: cortexPath, encoding: "utf8" });
        execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { cwd: cortexPath, encoding: "utf8" });

        let pushed = false;
        try {
          execSync("git push", { cwd: cortexPath, encoding: "utf8", timeout: 15000 });
          pushed = true;
        } catch {
          // No remote or push failed
        }

        const changedFiles = status.split("\n").length;
        return textResponse(`Saved ${changedFiles} changed file(s).${pushed ? " Pushed to remote." : ""}`);
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

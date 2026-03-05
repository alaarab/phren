#!/usr/bin/env node

import { runInit } from "./init.js";

if (process.argv[2] === "init") {
  await runInit();
  process.exit(0);
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as yaml from "js-yaml";
import { globSync } from "glob";
import { createRequire } from "module";
import { isValidProjectName, safeProjectPath, sanitizeFts5Query } from "./utils.js";

// sql.js-fts5 is CJS only, use createRequire for ESM compat
const require = createRequire(import.meta.url);
const initSqlJs = require("sql.js-fts5") as (config?: Record<string, unknown>) => Promise<any>;

// Validate that a path is a safe, existing directory
function requireDirectory(resolved: string, label: string): string {
  if (!fs.existsSync(resolved)) {
    console.error(`${label} not found: ${resolved}`);
    process.exit(1);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    console.error(`${label} is not a directory: ${resolved}`);
    process.exit(1);
  }
  return resolved;
}

// Resolve the cortex root directory
// Priority: CLI arg > CORTEX_PATH env > ~/.cortex > ~/cortex (auto-creates ~/.cortex on first run)
function findCortexPath(): string {
  const arg = process.argv[2];
  if (arg) {
    const resolved = arg.replace(/^~/, process.env.HOME || process.env.USERPROFILE || "");
    return requireDirectory(resolved, "cortex path");
  }
  if (process.env.CORTEX_PATH) return process.env.CORTEX_PATH;
  const home = process.env.HOME || process.env.USERPROFILE || "";
  for (const name of [".cortex", "cortex"]) {
    const candidate = path.join(home, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  // First run: bootstrap ~/.cortex with a starter README
  const defaultPath = path.join(home, ".cortex");
  fs.mkdirSync(defaultPath, { recursive: true });
  fs.writeFileSync(
    path.join(defaultPath, "README.md"),
    `# My Cortex\n\nThis is your personal knowledge base. Each subdirectory is a project.\n\nGet started:\n\n\`\`\`bash\nmkdir my-project\ncd my-project\ntouch CLAUDE.md summary.md LEARNINGS.md backlog.md\n\`\`\`\n\nOr run \`/cortex:init my-project\` in Claude Code to scaffold one.\n\nPush this directory to a private GitHub repo to sync across machines.\n`
  );
  console.error(`Created ~/.cortex — see github.com/alaarab/cortex-starter to populate it`);
  return defaultPath;
}

const cortexPath = findCortexPath();
const profile = process.env.CORTEX_PROFILE || "";


// Figure out which project directories to index
function getProjectDirs(): string[] {
  if (profile) {
    if (!isValidProjectName(profile)) {
      console.error(`Invalid CORTEX_PROFILE value: ${profile}`);
      return [];
    }
    const profilePath = path.join(cortexPath, "profiles", `${profile}.yaml`);
    if (fs.existsSync(profilePath)) {
      const data = yaml.load(fs.readFileSync(profilePath, "utf-8")) as Record<string, unknown>;
      const projects = data?.projects;
      if (Array.isArray(projects)) {
        return projects
          .map((p: unknown) => {
            const name = String(p);
            if (!isValidProjectName(name)) {
              console.error(`Skipping invalid project name in profile: ${name}`);
              return null;
            }
            return safeProjectPath(cortexPath, name);
          })
          .filter((p): p is string => p !== null && fs.existsSync(p));
      }
    }
  }

  // No profile or profile not found: index all top-level directories
  return fs.readdirSync(cortexPath, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith(".") && d.name !== "profiles" && d.name !== "templates")
    .map(d => path.join(cortexPath, d.name));
}

// Classify a file by its name and path
const FILE_TYPE_MAP: Record<string, string> = {
  "claude.md": "claude",
  "summary.md": "summary",
  "learnings.md": "learnings",
  "knowledge.md": "knowledge",
  "backlog.md": "backlog",
  "changelog.md": "changelog",
};

function classifyFile(filename: string, relPath: string): string {
  const mapped = FILE_TYPE_MAP[filename.toLowerCase()];
  if (mapped) return mapped;
  if (relPath.includes("skills/") || relPath.includes("skills\\")) return "skill";
  return "other";
}

// Find and load the WASM binary for sql.js-fts5
function findWasmBinary(): Buffer | undefined {
  const __filename = fileURLToPath(import.meta.url);
  let dir = path.dirname(__filename);
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "node_modules", "sql.js-fts5", "dist", "sql-wasm.wasm");
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate);
    dir = path.dirname(dir);
  }
  return undefined;
}

async function buildIndex(): Promise<any> {
  const wasmBinary = findWasmBinary();
  const SQL = await initSqlJs(wasmBinary ? { wasmBinary } : {});
  const db = new SQL.Database();

  db.run(`
    CREATE VIRTUAL TABLE docs USING fts5(
      project, filename, type, content, path
    );
  `);

  const projectDirs = getProjectDirs();
  let fileCount = 0;

  for (const dir of projectDirs) {
    const projectName = path.basename(dir);
    const mdFiles = globSync("**/*.md", { cwd: dir, nodir: true });

    for (const relFile of mdFiles) {
      const fullPath = path.join(dir, relFile);
      const filename = path.basename(relFile);
      const type = classifyFile(filename, relFile);

      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        db.run(
          "INSERT INTO docs (project, filename, type, content, path) VALUES (?, ?, ?, ?, ?)",
          [projectName, filename, type, content, fullPath]
        );
        fileCount++;
      } catch {
        // Skip files we can't read
      }
    }
  }

  console.error(`Indexed ${fileCount} files from ${projectDirs.length} projects`);
  return db;
}


// Extract a snippet around the match. FTS5 snippet() works in sql.js but
// to keep things simple and reliable, we do our own snippet extraction.
function extractSnippet(content: string, query: string, lines: number = 5): string {
  const terms = query.replace(/\b(AND|OR|NOT|NEAR)\b/gi, "")
    .replace(/['"]/g, "")
    .split(/\s+/)
    .filter(t => t.length > 1)
    .map(t => t.toLowerCase());

  if (terms.length === 0) {
    return content.split("\n").slice(0, lines).join("\n");
  }

  const contentLines = content.split("\n");

  // Find heading positions and section boundaries
  const headingIndices: number[] = [];
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trimStart().startsWith("#")) headingIndices.push(i);
  }

  // For each line, find its section (between two headings) and distance to nearest heading
  function nearestHeadingDist(idx: number): number {
    let min = Infinity;
    for (const h of headingIndices) {
      const d = Math.abs(idx - h);
      if (d < min) min = d;
    }
    return min;
  }

  function sectionMiddle(idx: number): number {
    let sectionStart = 0;
    let sectionEnd = contentLines.length;
    for (const h of headingIndices) {
      if (h <= idx) sectionStart = h;
      else { sectionEnd = h; break; }
    }
    return (sectionStart + sectionEnd) / 2;
  }

  let bestIdx = 0;
  let bestScore = 0;
  let bestHeadingDist = Infinity;
  let bestMidDist = Infinity;

  for (let i = 0; i < contentLines.length; i++) {
    const lineLower = contentLines[i].toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (lineLower.includes(term)) score++;
    }
    if (score === 0) continue;

    const hDist = nearestHeadingDist(i);
    const nearHeading = hDist <= 3;
    const mDist = Math.abs(i - sectionMiddle(i));

    // Prefer: higher term count, then near a heading, then closer to section middle
    const better =
      score > bestScore ||
      (score === bestScore && nearHeading && bestHeadingDist > 3) ||
      (score === bestScore && nearHeading === (bestHeadingDist <= 3) && mDist < bestMidDist);

    if (better) {
      bestScore = score;
      bestIdx = i;
      bestHeadingDist = hDist;
      bestMidDist = mDist;
    }
  }

  const start = Math.max(0, bestIdx - 1);
  const end = Math.min(contentLines.length, bestIdx + lines - 1);
  return contentLines.slice(start, end).join("\n");
}

// Build a standard MCP text response
function textResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// Extract rows from a db.exec result, or null if empty
function queryRows(db: any, sql: string, params: (string | number)[]): any[][] | null {
  const results = db.exec(sql, params);
  if (!results.length || !results[0].values.length) return null;
  return results[0].values;
}

async function main() {
  const db = await buildIndex();

  const server = new McpServer({
    name: "cortex-mcp",
    version: "0.1.0",
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
        const safeQuery = sanitizeFts5Query(query);

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
      description: "Get a project's summary card and available docs. Call this when starting work on a specific project to orient yourself — what it is, the stack, current status, and how to run it.",
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

        // Pull brief from summary first, then fall back to claude doc
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

      // Find the item line
      const idx = lines.findIndex(l => l.match(/^- /) && l.toLowerCase().includes(item.toLowerCase()));
      if (idx === -1) return textResponse(`No item matching "${item}" found in ${project} backlog.`);

      const changes: string[] = [];

      // Apply priority update
      if (updates.priority) {
        const before = lines[idx];
        // Remove any existing [high], [medium], [low] tag then add the new one
        lines[idx] = lines[idx].replace(/\s*\[(high|medium|low)\]/gi, "").trimEnd() + ` [${updates.priority}]`;
        if (lines[idx] !== before) changes.push(`priority -> ${updates.priority}`);
      }

      // Apply context update
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

      // Apply section move
      if (updates.section) {
        const targetSection = updates.section;
        const sectionPattern = new RegExp(`^## ${targetSection}\\s*$`, "i");

        // Collect the item and its context line (if any)
        const itemLine = lines[idx];
        const contextIdx = idx + 1;
        const hasContext = contextIdx < lines.length && lines[contextIdx].trim().startsWith("Context:");
        const extraLine = hasContext ? lines[contextIdx] : null;

        // Remove item (and context if present) from current location
        const removeCount = extraLine !== null ? 2 : 1;
        lines.splice(idx, removeCount);

        // Find target section header
        const targetIdx = lines.findIndex(l => sectionPattern.test(l));
        if (targetIdx === -1) {
          // Section not found: append it
          lines.push(`\n## ${targetSection}\n`, itemLine);
          if (extraLine) lines.push(extraLine);
        } else {
          // Insert after the section header (and any blank line right after it)
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

  // Start the server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`cortex-mcp running (${cortexPath})`);
}

main().catch((err) => {
  console.error("Failed to start cortex-mcp:", err);
  process.exit(1);
});

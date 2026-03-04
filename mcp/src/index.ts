#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as yaml from "js-yaml";
import { globSync } from "glob";
import { createRequire } from "module";

// sql.js-fts5 is CJS only, use createRequire for ESM compat
const require = createRequire(import.meta.url);
const initSqlJs = require("sql.js-fts5") as (config?: Record<string, unknown>) => Promise<any>;

// Resolve the cortex root directory
function findCortexPath(): string {
  if (process.env.CORTEX_PATH) return process.env.CORTEX_PATH;
  const home = process.env.HOME || process.env.USERPROFILE || "";
  for (const name of ["cortex", "my-cortex"]) {
    const candidate = path.join(home, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  console.error("No cortex found. Set CORTEX_PATH or create ~/cortex");
  process.exit(1);
}

const cortexPath = findCortexPath();
const profile = process.env.CORTEX_PROFILE || "";

// Figure out which project directories to index
function getProjectDirs(): string[] {
  if (profile) {
    const profilePath = path.join(cortexPath, "profiles", `${profile}.yaml`);
    if (fs.existsSync(profilePath)) {
      const data = yaml.load(fs.readFileSync(profilePath, "utf-8")) as Record<string, unknown>;
      const projects = data?.projects;
      if (Array.isArray(projects)) {
        return projects
          .map((p: unknown) => path.join(cortexPath, String(p)))
          .filter((p: string) => fs.existsSync(p));
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
  let bestIdx = 0;
  let bestScore = 0;

  for (let i = 0; i < contentLines.length; i++) {
    const lineLower = contentLines[i].toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (lineLower.includes(term)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
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
      description: "Search across all cortex docs. Finds architecture notes, patterns, learnings, skills, backlogs.",
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

        const sql = filterType
          ? `SELECT project, filename, type, content, path FROM docs WHERE docs MATCH ? AND type = ? ORDER BY rank LIMIT ?`
          : `SELECT project, filename, type, content, path FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT ?`;
        const params: (string | number)[] = filterType
          ? [query, filterType, maxResults]
          : [query, maxResults];

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
      description: "Get a project's summary card and available docs. Pass the project name (e.g. 'ogrid', 'AlphaLens').",
      inputSchema: z.object({
        name: z.string().describe("Project name (e.g. 'ogrid', 'AlphaLens', 'livemcp')"),
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

  // Start the server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`cortex-mcp running (${cortexPath})`);
}

main().catch((err) => {
  console.error("Failed to start cortex-mcp:", err);
  process.exit(1);
});

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext } from "./mcp-types.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { isValidProjectName, buildRobustFtsQuery, STOP_WORDS } from "./utils.js";
import { readFindings } from "./data-access.js";
import {
  debugLog,
  runtimeDir,
} from "./shared.js";
import {
  queryRows,
  cosineFallback,
  queryEntityLinks,
  extractSnippet,
  queryDocBySourceKey,
  type SqlJsDatabase,
  type DbRow,
} from "./shared-index.js";
import { runCustomHooks } from "./hooks.js";
import { getCachedEmbedding, cosineSimilarity } from "./embedding.js";

interface FeedbackScoreEntry {
  key: string;
  weight: number;
  timestamp: string;
}

function loadFeedbackScores(cortexPath: string): Map<string, { score: number; lastFeedback: string }> {
  const scoresFile = path.join(runtimeDir(cortexPath), "scores.jsonl");
  const result = new Map<string, { score: number; lastFeedback: string }>();
  if (!fs.existsSync(scoresFile)) return result;
  try {
    const lines = fs.readFileSync(scoresFile, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      const entry = JSON.parse(line) as FeedbackScoreEntry;
      const existing = result.get(entry.key);
      const currentScore = existing ? existing.score + entry.weight : entry.weight;
      result.set(entry.key, { score: currentScore, lastFeedback: entry.timestamp });
    }
  } catch { /* ignore parse errors */ }
  return result;
}

function computeFeedbackMultiplier(score: number, lastFeedbackTs: string): number {
  const daysSince = Math.max(0, (Date.now() - new Date(lastFeedbackTs).getTime()) / 86400000);
  const decayed = score * Math.pow(0.95, daysSince);
  const multiplier = 1.0 + decayed * 0.2;
  return Math.max(0.3, Math.min(2.0, multiplier));
}

function jsonResponse(payload: { ok: boolean; data?: unknown; error?: string; message?: string }) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

export function register(server: McpServer, ctx: McpContext): void {
  const { cortexPath, profile } = ctx;

  server.registerTool(
    "get_memory_detail",
    {
      title: "◆ cortex · memory detail",
      description:
        "Fetch the full content of a specific memory entry by its ID. Use this after receiving a compact " +
        "memory index from the hook-prompt (when CORTEX_FEATURE_PROGRESSIVE_DISCLOSURE is enabled). " +
        "The id format is `mem:project/path/to/file.md` as shown in the memory index.",
      inputSchema: z.object({
        id: z.string().describe(
          "Memory ID in the format `mem:project/path/to/file.md` (e.g. `mem:my-app/reference/api/auth.md`). " +
          "Returned by the hook-prompt compact index when CORTEX_FEATURE_PROGRESSIVE_DISCLOSURE=1."
        ),
      }),
    },
    async ({ id }) => {
      const match = id.match(/^mem:([^/]+)\/(.+)$/);
      if (!match) {
        return jsonResponse({ ok: false, error: `Invalid memory id format "${id}". Expected mem:project/path/to/file.md.` });
      }
      const [, project] = match;
      if (!isValidProjectName(project)) {
        return jsonResponse({ ok: false, error: `Invalid project name: "${project}"` });
      }

      const db = ctx.db();
      const doc = queryDocBySourceKey(db, cortexPath, id.slice(4));
      if (!doc) {
        return jsonResponse({ ok: false, error: `Memory not found: ${id}` });
      }

      return jsonResponse({
        ok: true,
        message: `[${id.slice(4)}] (${doc.type})\n\n${doc.content}`,
        data: { id, project: doc.project, filename: doc.filename, type: doc.type, content: doc.content, path: doc.path },
      });
    }
  );

  server.registerTool(
    "search_cortex",
    {
      title: "◆ cortex · search",
      description: "Search the user's cortex. Call this at the start of any session to get project context, and any time the user asks about their codebase, stack, architecture, past decisions, commands, conventions, or findings. Prefer this over asking the user to re-explain things they've already documented.",
      inputSchema: z.object({
        query: z.string().describe("Search query (supports FTS5 syntax: AND, OR, NOT, phrase matching with quotes)"),
        limit: z.number().min(1).max(20).optional().describe("Max results to return (1-20, default 5)"),
        project: z.string().optional().describe("Filter by project name."),
        type: z.enum(["claude", "findings", "reference", "skills", "summary", "backlog", "changelog", "canonical", "memory-queue", "skill", "other"])
          .optional()
          .describe("Filter by document type: claude, findings, reference, summary, backlog, skill"),
        tag: z.enum(["decision", "pitfall", "pattern", "tradeoff", "architecture", "bug"])
          .optional()
          .describe("Filter findings by type tag (decision, pitfall, pattern are canonical; tradeoff, architecture, bug are legacy aliases)."),
        since: z.string().optional().describe('Filter findings by creation date. Formats: "7d" (last 7 days), "30d" (last 30 days), "YYYY-MM" (since start of month), "YYYY-MM-DD" (since date).'),
      }),
    },
    async ({ query, limit, project, type, tag, since }) => {
      try {
        if (query.length > 1000) return jsonResponse({ ok: false, error: "Search query exceeds 1000 character limit." });
        const db = ctx.db();
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
        if (rows && rows.length < 3) {
          const ftsRowids = new Set<number>();
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

        // API embedding fallback: if results < 3 and CORTEX_EMBEDDING_PROVIDER=api
        if (rows && rows.length < 3 && process.env.CORTEX_EMBEDDING_PROVIDER === "api") {
          const apiKey = process.env.OPENAI_API_KEY || "";
          const model = process.env.CORTEX_EMBEDDING_MODEL || "text-embedding-3-small";
          if (apiKey) {
            try {
              const queryEmbed = await getCachedEmbedding(cortexPath, query, apiKey, model);
              const allDocs = queryRows(db, "SELECT project, filename, type, content, path FROM docs", []);
              if (allDocs) {
                const existingPaths = new Set(rows.map((r: DbRow) => r[4]));
                const scored: Array<{ row: DbRow; score: number }> = [];
                for (const doc of allDocs) {
                  if (existingPaths.has(doc[4])) continue;
                  try {
                    const docEmbed = await getCachedEmbedding(cortexPath, String(doc[3]).slice(0, 2000), apiKey, model);
                    const sim = cosineSimilarity(queryEmbed, docEmbed);
                    if (sim > 0.3) scored.push({ row: doc, score: sim });
                  } catch { /* skip docs that fail embedding */ }
                }
                scored.sort((a, b) => b.score - a.score);
                const toAdd = scored.slice(0, maxResults - rows.length);
                if (toAdd.length > 0) {
                  rows = [...rows, ...toAdd.map(s => s.row)];
                  usedFallback = true;
                }
              }
            } catch (err: unknown) {
              debugLog(`API embedding fallback failed: ${err instanceof Error ? err.message : String(err)}`);
            }
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
                .map((row: DbRow) => {
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
          rows = rows.filter((row: DbRow) => {
            const content = (row[3] as string).toLowerCase();
            return content.includes(tagPattern);
          });
          if (rows.length === 0) {
            return jsonResponse({ ok: true, message: `No results found with tag [${filterTag}].`, data: { query, results: [] } });
          }
        }

        // Filter by since date if requested
        if (since && rows) {
          let sinceDate: Date | null = null;
          const daysMatch = since.match(/^(\d+)d$/);
          if (daysMatch) {
            sinceDate = new Date(Date.now() - parseInt(daysMatch[1], 10) * 86400000);
          } else if (/^\d{4}-\d{2}$/.test(since)) {
            sinceDate = new Date(`${since}-01T00:00:00Z`);
          } else if (/^\d{4}-\d{2}-\d{2}$/.test(since)) {
            sinceDate = new Date(`${since}T00:00:00Z`);
          }
          if (sinceDate && !isNaN(sinceDate.getTime())) {
            const sinceMs = sinceDate.getTime();
            rows = rows.filter((row: DbRow) => {
              const content = row[3] as string;
              const createdDates = [...content.matchAll(/<!-- created: (\d{4}-\d{2}-\d{2}) -->/g)];
              if (createdDates.length === 0) return true;
              return createdDates.some(m => new Date(`${m[1]}T00:00:00Z`).getTime() >= sinceMs);
            });
            if (rows.length === 0) {
              return jsonResponse({ ok: true, message: `No results found since ${since}.`, data: { query, results: [] } });
            }
          }
        }

        // Filter out superseded entries from results
        if (rows) {
          rows = rows.map((row: DbRow) => {
            const content = row[3] as string;
            if (!content.includes("<!-- superseded_by:")) return row;
            const filteredLines = content.split("\n").filter(l => !l.includes("<!-- superseded_by:"));
            return [row[0], row[1], row[2], filteredLines.join("\n"), row[4]];
          });
        }

        const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
        const feedbackScores = loadFeedbackScores(cortexPath);
        const scored = rows.map((row: DbRow, idx: number) => {
          const filePath = row[4] as string;
          const rowProject = row[0] as string;
          const filename = row[1] as string;
          const content = row[3] as string;
          let boost = 1.0;
          try {
            const mtime = fs.statSync(filePath).mtimeMs;
            if (mtime > thirtyDaysAgo) boost = 1.2;
          } catch { /* file may not exist on disk */ }

          const memKey = `${rowProject}/${filename}`;
          const feedback = feedbackScores.get(memKey);
          if (feedback) {
            boost *= computeFeedbackMultiplier(feedback.score, feedback.lastFeedback);
          }

          return { row, rank: (rows.length - idx) * boost };
        });
        scored.sort((a, b) => b.rank - a.rank);

        const results = scored.map(({ row }) => {
          const [proj, filename, docType, content, filePath] = row as string[];
          const snippet = extractSnippet(content, query);
          return { project: proj, filename, type: docType, snippet, path: filePath };
        });

        let relatedEntities: string[] = [];
        try {
          const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
          for (const term of queryTerms) {
            const links = queryEntityLinks(db, term);
            if (links.related.length > 0) {
              relatedEntities.push(...links.related);
            }
          }
          relatedEntities = [...new Set(relatedEntities)].slice(0, 10);
        } catch { /* entity graph is optional */ }

        const formatted = results.map((r) =>
          `### ${r.project}/${r.filename} (${r.type})\n${r.snippet}\n\n\`${r.path}\``
        );

        const fallbackNote = usedFallback ? " (keyword fallback)" : "";
        const entityNote = relatedEntities.length > 0 ? `\n\nRelated entities: ${relatedEntities.join(", ")}` : "";
        runCustomHooks(cortexPath, "post-search", { CORTEX_QUERY: query, CORTEX_RESULT_COUNT: String(results.length) });
        return jsonResponse({
          ok: true,
          message: `Found ${results.length} result(s) for "${query}"${fallbackNote}:\n\n${formatted.join("\n\n---\n\n")}${entityNote}`,
          data: { query, count: results.length, results, fallback: usedFallback, relatedEntities: relatedEntities.length > 0 ? relatedEntities : undefined },
        });
      } catch (err: unknown) {
        return jsonResponse({ ok: false, error: `Search error: ${err instanceof Error ? err.message : String(err)}` });
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
      const db = ctx.db();
      const files = queryRows(db, "SELECT filename, type, path FROM docs WHERE project = ?", [name]);

      if (!files) {
        const projectRows = queryRows(db, "SELECT DISTINCT project FROM docs ORDER BY project", []);
        const names = projectRows ? projectRows.map((r: DbRow) => r[0]) : [];
        return jsonResponse({ ok: false, error: `Project "${name}" not found.`, data: { available: names } });
      }

      const summaryRow = queryRows(db, "SELECT content, path FROM docs WHERE project = ? AND type = 'summary'", [name]);
      const claudeRow = queryRows(db, "SELECT content, path FROM docs WHERE project = ? AND type = 'claude'", [name]);

      const indexedFiles = files.map((f: DbRow) => ({ filename: f[0], type: f[1], path: f[2] }));

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
      const db = ctx.db();
      const projectRows = queryRows(db, "SELECT DISTINCT project FROM docs ORDER BY project", []);
      if (!projectRows) return jsonResponse({ ok: true, message: "No projects indexed.", data: { projects: [], total: 0 } });

      const projects = projectRows.map((r: DbRow) => r[0] as string);
      const pageSize = page_size ?? 20;
      const pageNum = page ?? 1;
      const start = Math.max(0, (pageNum - 1) * pageSize);
      const end = start + pageSize;
      const pageProjects = projects.slice(start, end);
      const totalPages = Math.max(1, Math.ceil(projects.length / pageSize));
      if (pageNum > totalPages) {
        return jsonResponse({ ok: false, error: `Page ${pageNum} out of range. Total pages: ${totalPages}.` });
      }

      const badgeTypes = ["claude", "findings", "summary", "backlog"] as const;
      const badgeLabels: Record<string, string> = { claude: "CLAUDE.md", findings: "FINDINGS", summary: "summary", backlog: "backlog" };

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

  server.registerTool(
    "get_findings",
    {
      title: "◆ cortex · findings",
      description: "List recent findings for a project without requiring a search query.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        limit: z.number().int().min(1).max(200).optional().describe("Max rows to return (default 50)."),
      }),
    },
    async ({ project, limit }) => {
      if (!isValidProjectName(project)) return jsonResponse({ ok: false, error: `Invalid project name: "${project}"` });
      const result = readFindings(cortexPath, project);
      if (!result.ok) return jsonResponse({ ok: false, error: result.error });
      const items = result.data;
      if (!items.length) return jsonResponse({ ok: true, message: `No findings found for "${project}".`, data: { project, findings: [], total: 0 } });
      const capped = items.slice(0, limit ?? 50);
      const lines = capped.map((entry) => `- [${entry.id}] ${entry.date}: ${entry.text}${entry.citation ? ` (${entry.citation})` : ""}`);
      return jsonResponse({
        ok: true,
        message: `Findings for ${project} (${capped.length}/${items.length}):\n` + lines.join("\n"),
        data: { project, findings: capped, total: items.length },
      });
    }
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpContext, mcpResponse } from "./mcp-types.js";
import { z } from "zod";
import * as fs from "fs";
import { createHash } from "crypto";
import { isValidProjectName, errorMessage } from "./utils.js";
import { readFindings } from "./data-access.js";
import {
  debugLog,
  runtimeFile,
  DOC_TYPES,
  FINDING_TAGS,
} from "./shared.js";
import {
  decodeStringRow,
  queryRows,
  queryDocRows,
  queryEntityLinks,
  logEntityMiss,
  extractSnippet,
  queryDocBySourceKey,
  normalizeMemoryId,
} from "./shared-index.js";
import { runCustomHooks } from "./hooks.js";
import { entryScoreKey, getQualityMultiplier } from "./shared-governance.js";
import { callLlm } from "./content-dedup.js";
import { rankResults, searchKnowledgeRows } from "./shared-retrieval.js";

/**
 * Q30: Log zero-result queries to .runtime/search-misses.jsonl.
 * Strips PII-like tokens (emails, UUIDs, numbers) and keeps only query terms.
 */
export function logSearchMiss(cortexPath: string, query: string, project?: string): void {
  try {
    const sanitized = query
      .replace(/\S+@\S+\.\S+/g, "<email>")      // strip emails
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")  // strip UUIDs
      .replace(/\b\d{3,}\b/g, "<num>")             // strip long numbers
      .trim();
    if (!sanitized) return;
    const entry = JSON.stringify({
      query: sanitized,
      ts: Date.now(),
      project: project ?? null,
    });
    const missFile = runtimeFile(cortexPath, "search-misses.jsonl");
    fs.appendFileSync(missFile, entry + "\n");
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] logSearchMiss: ${err instanceof Error ? err.message : String(err)}\n`);
  }
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
    async ({ id: rawId }) => {
      // Normalize ID: decode URL encoding and normalize path separators
      const id = normalizeMemoryId(rawId);
      const match = id.match(/^mem:([^/]+)\/(.+)$/);
      if (!match) {
        return mcpResponse({ ok: false, error: `Invalid memory id format "${rawId}". Expected mem:project/path/to/file.md.` });
      }
      const [, project] = match;
      if (!isValidProjectName(project)) {
        return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      }

      const db = ctx.db();
      const doc = queryDocBySourceKey(db, cortexPath, id.slice(4));
      if (!doc) {
        return mcpResponse({ ok: false, error: `Memory not found: ${id}` });
      }

      // Extract metadata from filesystem and content
      let updatedAt: string | null = null;
      let createdAt: string | null = null;
      try {
        const stat = fs.statSync(doc.path);
        updatedAt = stat.mtime.toISOString();
        createdAt = stat.birthtime.toISOString();
      } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] search_knowledge statFile: ${errorMessage(err)}\n`);
      }

      // Extract tags from content (e.g. [decision], [pitfall], [pattern])
      const tagMatches = doc.content.match(/\[(decision|pitfall|pattern|tradeoff|architecture|bug)\]/gi);
      const tags = tagMatches ? [...new Set(tagMatches.map(t => t.slice(1, -1).toLowerCase()))] : [];

      // Get quality score if available
      const scoreKey = entryScoreKey(doc.project, doc.filename, doc.content);
      const qualityMultiplier = getQualityMultiplier(cortexPath, scoreKey);

      return mcpResponse({
        ok: true,
        message: `[${id.slice(4)}] (${doc.type})\n\n${doc.content}`,
        data: {
          id,
          project: doc.project,
          filename: doc.filename,
          type: doc.type,
          content: doc.content,
          path: doc.path,
          created_at: createdAt,
          updated_at: updatedAt,
          tags: tags.length > 0 ? tags : undefined,
          score: qualityMultiplier,
          // Relevance metadata: rank and relevance_score are populated when
          // the detail is fetched as part of a search result set. When fetched
          // directly by ID they are not available.
          rank: undefined,
          relevance_score: undefined,
        },
      });
    }
  );

  server.registerTool(
    "search_knowledge",
    {
      title: "◆ cortex · search",
      description: "Search the user's cortex. Call this at the start of any session to get project context, and any time the user asks about their codebase, stack, architecture, past decisions, commands, conventions, or findings. Prefer this over asking the user to re-explain things they've already documented.",
      inputSchema: z.object({
        query: z.string().describe("Search query (supports FTS5 syntax: AND, OR, NOT, phrase matching with quotes)"),
        limit: z.number().min(1).max(20).optional().describe("Max results to return (1-20, default 5)"),
        project: z.string().optional().describe("Filter by project name."),
        type: z.enum(DOC_TYPES)
          .optional()
          .describe("Filter by document type: claude, findings, reference, summary, backlog, skill"),
        tag: z.preprocess(
          value => typeof value === "string" ? value.toLowerCase() : value,
          z.enum(FINDING_TAGS)
        )
          .optional()
          .describe("Filter findings by type tag: decision, pitfall, pattern, tradeoff, architecture, bug."),
        since: z.string().optional().describe('Filter findings by creation date. Formats: "7d" (last 7 days), "30d" (last 30 days), "YYYY-MM" (since start of month), "YYYY-MM-DD" (since date).'),
        synthesize: z.boolean().optional().describe("When true, generate a short synthesis paragraph from the top results using an LLM. Requires CORTEX_LLM_ENDPOINT, ANTHROPIC_API_KEY, or OPENAI_API_KEY."),
      }),
    },
    async ({ query, limit, project, type, tag, since, synthesize }) => {
      try {
        if (query.length > 1000) return mcpResponse({ ok: false, error: "Search query exceeds 1000 character limit." });
        const db = ctx.db();
        const maxResults = limit ?? 5;
        const filterType = type === "skills" ? "skill" : type;
        const filterTag = tag?.toLowerCase();
        const filterProject = project?.trim();
        if (filterProject && !isValidProjectName(filterProject)) {
          return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
        }
        const hasPostFilter = Boolean(filterTag || since);
        const fetchLimit = hasPostFilter ? Math.min(maxResults * 5, 200) : maxResults;
        const retrieval = await searchKnowledgeRows(db, {
          query,
          maxResults,
          fetchLimit,
          filterProject,
          filterType,
          cortexPath,
        });
        const safeQuery = retrieval.safeQuery;

        if (!safeQuery) return mcpResponse({ ok: false, error: "Search query is empty after sanitization." });
        let rows = retrieval.rows;
        const usedFallback = retrieval.usedFallback;

        if (!rows || rows.length === 0) {
          logSearchMiss(cortexPath, query, filterProject);
          return mcpResponse({ ok: true, message: "No results found.", data: { query, results: [] } });
        }

        // Filter by observation tag if requested
        if (filterTag && rows) {
          const tagPattern = `[${filterTag.toLowerCase()}]`;
          rows = rows.filter(row => row.content.toLowerCase().includes(tagPattern));
          if (rows.length === 0) {
            logSearchMiss(cortexPath, query, filterProject);
            return mcpResponse({ ok: true, message: `No results found with tag [${filterTag}].`, data: { query, results: [] } });
          }
        }

        // Filter by since date if requested
        if (since && rows) {
          let sinceDate: Date | null = null;
          const daysMatch = since.match(/^(\d+)d$/);
          if (daysMatch) {
            sinceDate = new Date(Date.now() - parseInt(daysMatch[1], 10) * 86400000);
          } else if (/^\d{4}-\d{2}$/.test(since)) {
            // Validate month is 01-12
            const [, mm] = since.split("-");
            const month = parseInt(mm, 10);
            if (month < 1 || month > 12) {
              return mcpResponse({ ok: false, error: `Invalid since value "${since}": month must be 01-12.` });
            }
            sinceDate = new Date(`${since}-01T00:00:00Z`);
          } else if (/^\d{4}-\d{2}-\d{2}$/.test(since)) {
            // Validate month and day strictly (reject impossible dates like 2026-02-31)
            const [, mm, dd] = since.split("-");
            const month = parseInt(mm, 10);
            const day = parseInt(dd, 10);
            if (month < 1 || month > 12 || day < 1 || day > 31) {
              return mcpResponse({ ok: false, error: `Invalid since value "${since}": month or day out of range.` });
            }
            const candidate = new Date(`${since}T00:00:00Z`);
            // new Date() normalizes impossible dates (e.g. Feb 31 → Mar 3); detect by comparing parsed month/day
            if (candidate.getUTCMonth() + 1 !== month || candidate.getUTCDate() !== day) {
              return mcpResponse({ ok: false, error: `Invalid since value "${since}": date does not exist on the calendar.` });
            }
            sinceDate = candidate;
          } else if (since) {
            return mcpResponse({ ok: false, error: `Invalid since format "${since}". Use "7d", "YYYY-MM", or "YYYY-MM-DD".` });
          }
          if (sinceDate && !isNaN(sinceDate.getTime())) {
            const sinceMs = sinceDate.getTime();
            rows = rows.filter(row => {
              const createdDates = [...row.content.matchAll(/<!-- created: (\d{4}-\d{2}-\d{2}) -->/g)];
              if (createdDates.length === 0) return true;
              return createdDates.some(m => new Date(`${m[1]}T00:00:00Z`).getTime() >= sinceMs);
            });
            if (rows.length === 0) {
              logSearchMiss(cortexPath, query, filterProject);
            return mcpResponse({ ok: true, message: `No results found since ${since}.`, data: { query, results: [] } });
            }
          }
        }

        // Trim back to requested limit after post-query filters
        if (hasPostFilter && rows && rows.length > maxResults) {
          rows = rows.slice(0, maxResults);
        }

        // Filter out superseded entries from results
        if (rows) {
          rows = rows.map(row => {
            if (!row.content.includes("<!-- superseded_by:")) return row;
            const filteredLines = row.content.split("\n").filter(line => !line.includes("<!-- superseded_by:"));
            return { ...row, content: filteredLines.join("\n") };
          });
        }

        rows = rankResults(
          rows,
          "general",
          null,
          filterProject ?? null,
          cortexPath,
          db,
          undefined,
          query,
          { skipBacklogFilter: true, filterType: filterType ?? null }
        ).slice(0, maxResults);

        const results = rows.map((row) => {
          const snippet = extractSnippet(row.content, query);
          return { project: row.project, filename: row.filename, type: row.type, snippet, path: row.path };
        });

        let relatedEntities: string[] = [];
        try {
          const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
          for (const term of terms) {
            const links = queryEntityLinks(db, term);
            if (links.related.length > 0) {
              relatedEntities.push(...links.related);
            } else {
              logEntityMiss(cortexPath, term, "search_knowledge", filterProject);
            }
          }
          relatedEntities = [...new Set(relatedEntities)].slice(0, 10);
        } catch (err: unknown) {
          if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] entityGraph query: ${err instanceof Error ? err.message : String(err)}\n`);
        }

        const formatted = results.map((r) =>
          `### ${r.project}/${r.filename} (${r.type})\n${r.snippet}\n\n\`${r.path}\``
        );

        // Memory synthesis: generate a concise paragraph from top results when requested
        let synthesis: string | undefined;
        if (synthesize && results.length > 0) {
          try {
            const synthKey = createHash("sha256").update([query, filterProject ?? "", filterType ?? "", filterTag ?? "", since ?? ""].join("|")).digest("hex").slice(0, 16);
            const synthCachePath = runtimeFile(cortexPath, "synth-cache.json");
            let synthCache: Record<string, { result: string; ts: number }> = {};
            try { synthCache = JSON.parse(fs.readFileSync(synthCachePath, "utf8")); } catch (err: unknown) {
              if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] search_knowledge synthCacheRead: ${errorMessage(err)}\n`);
            }
            const cached = synthCache[synthKey];
            const SYNTH_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
            if (cached && Date.now() - cached.ts < SYNTH_CACHE_TTL_MS) {
              synthesis = cached.result;
            } else {
              const snippets = results.slice(0, 5).map((r, i) => `[${i + 1}] ${r.snippet}`).join("\n");
              const synthPrompt = `Summarize these search results for "${query}" in 2-3 sentences. No headers, no lists. Plain paragraph only.\n\n${snippets}`;
              synthesis = await callLlm(synthPrompt, undefined, 300);
              if (synthesis) {
                synthCache[synthKey] = { result: synthesis, ts: Date.now() };
                // Trim cache to 100 entries
                const cacheKeys = Object.keys(synthCache);
                if (cacheKeys.length > 100) {
                  const oldest = cacheKeys.sort((a, b) => synthCache[a].ts - synthCache[b].ts).slice(0, cacheKeys.length - 100);
                  for (const k of oldest) delete synthCache[k];
                }
                try { fs.writeFileSync(synthCachePath, JSON.stringify(synthCache)); } catch (err: unknown) {
                  if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] synthCache write: ${err instanceof Error ? err.message : String(err)}\n`);
                }
              }
            }
          } catch (err: unknown) {
            debugLog(`search synthesis failed: ${errorMessage(err)}`);
          }
        }

        const fallbackNote = usedFallback ? " (keyword fallback)" : "";
        const entityNote = relatedEntities.length > 0 ? `\n\nRelated entities: ${relatedEntities.join(", ")}` : "";
        const synthesisBlock = synthesis ? `\n\n${synthesis}\n\n---\n\n` : "\n\n";
        runCustomHooks(cortexPath, "post-search", { CORTEX_QUERY: query, CORTEX_RESULT_COUNT: String(results.length) });
        return mcpResponse({
          ok: true,
          message: `Found ${results.length} result(s) for "${query}"${fallbackNote}:${synthesisBlock}${formatted.join("\n\n---\n\n")}${entityNote}`,
          data: { query, count: results.length, results, fallback: usedFallback, relatedEntities: relatedEntities.length > 0 ? relatedEntities : undefined, ...(synthesis ? { synthesis } : {}) },
        });
      } catch (err: unknown) {
        return mcpResponse({ ok: false, error: `Search error: ${errorMessage(err)}`, errorCode: "INTERNAL_ERROR" });
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
      const docs = queryDocRows(db, "SELECT project, filename, type, content, path FROM docs WHERE project = ?", [name]);

      if (!docs) {
        const projectRows = queryRows(db, "SELECT DISTINCT project FROM docs ORDER BY project", []);
        const names = projectRows ? projectRows.map(row => decodeStringRow(row, 1, "get_project_summary.projects")[0]) : [];
        return mcpResponse({ ok: false, error: `Project "${name}" not found.`, data: { available: names } });
      }

      const summaryDoc = docs.find(doc => doc.type === "summary");
      const claudeDoc = docs.find(doc => doc.type === "claude");
      const indexedFiles = docs.map(doc => ({ filename: doc.filename, type: doc.type, path: doc.path }));

      const parts: string[] = [`# ${name}`];
      if (summaryDoc) {
        parts.push(`\n## Summary\n${summaryDoc.content}`);
      } else {
        parts.push("\n*No summary.md found for this project.*");
      }
      if (claudeDoc) {
        parts.push(`\n## CLAUDE.md path\n\`${claudeDoc.path}\``);
      }
      const fileList = indexedFiles.map((f) => `- ${f.filename} (${f.type})`).join("\n");
      parts.push(`\n## Indexed files\n${fileList}`);

      return mcpResponse({
        ok: true,
        message: parts.join("\n"),
        data: {
          name,
          summary: summaryDoc?.content ?? null,
          claudeMdPath: claudeDoc?.path ?? null,
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
      if (!projectRows) return mcpResponse({ ok: true, message: "No projects indexed.", data: { projects: [], total: 0 } });

      const projects = projectRows.map(row => decodeStringRow(row, 1, "list_projects.projects")[0]);
      const pageSize = page_size ?? 20;
      const pageNum = page ?? 1;
      const start = Math.max(0, (pageNum - 1) * pageSize);
      const end = start + pageSize;
      const pageProjects = projects.slice(start, end);
      const totalPages = Math.max(1, Math.ceil(projects.length / pageSize));
      if (pageNum > totalPages) {
        return mcpResponse({ ok: false, error: `Page ${pageNum} out of range. Total pages: ${totalPages}.` });
      }

      const badgeTypes = ["claude", "findings", "summary", "backlog"] as const;
      const badgeLabels: Record<string, string> = { claude: "CLAUDE.md", findings: "FINDINGS", summary: "summary", backlog: "backlog" };

      const projectList = pageProjects.map((proj) => {
        const rows = queryDocRows(db, "SELECT project, filename, type, content, path FROM docs WHERE project = ?", [proj]) ?? [];
        const types = rows.map(row => row.type);
        const summaryRow = rows.find(row => row.type === "summary");
        const claudeRow = rows.find(row => row.type === "claude");
        const source = summaryRow?.content ?? claudeRow?.content;
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

      return mcpResponse({
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
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      const result = readFindings(cortexPath, project);
      if (!result.ok) return mcpResponse({ ok: false, error: result.error });
      const items = result.data;
      if (!items.length) return mcpResponse({ ok: true, message: `No findings found for "${project}".`, data: { project, findings: [], total: 0 } });
      const capped = items.slice(0, limit ?? 50);
      const lines = capped.map((entry) => {
        const metadata: string[] = [];
        if (entry.backlogItem) metadata.push(`backlog=${entry.backlogItem}`);
        if (entry.sessionId) metadata.push(`session=${entry.sessionId.slice(0, 8)}`);
        if (entry.actor) metadata.push(`actor=${entry.actor}`);
        if (entry.tool) metadata.push(`tool=${entry.tool}`);
        if (entry.model) metadata.push(`model=${entry.model}`);
        const idLabel = entry.stableId ? `${entry.id}|fid:${entry.stableId}` : entry.id;
        return `- [${idLabel}] ${entry.date}: ${entry.text}${entry.confidence !== undefined ? ` [confidence ${entry.confidence.toFixed(2)}]` : ""}${metadata.length > 0 ? ` [${metadata.join(" ")}]` : ""}${entry.citation ? ` (${entry.citation})` : ""}`;
      });
      return mcpResponse({
        ok: true,
        message: `Findings for ${project} (${capped.length}/${items.length}):\n` + lines.join("\n"),
        data: { project, findings: capped, total: items.length },
      });
    }
  );
}

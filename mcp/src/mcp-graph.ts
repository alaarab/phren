import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpContext, mcpResponse } from "./mcp-types.js";
import { z } from "zod";
import * as fs from "fs";
import * as crypto from "crypto";
import { isValidProjectName } from "./utils.js";
import { queryDocBySourceKey, queryRows, queryEntityLinks, queryCrossProjectEntities } from "./shared-index.js";
import { runtimeFile } from "./shared.js";
import { withFileLock } from "./shared-governance.js";



export function register(server: McpServer, ctx: McpContext): void {

  // ── search_entities ───────────────────────────────────────────────────────
  server.registerTool(
    "search_entities",
    {
      title: "◆ cortex · search entities",
      description:
        "Search named entities in the knowledge graph (libraries, tools, concepts mentioned in findings). " +
        "Returns matching entity names and how many findings reference each.",
      inputSchema: z.object({
        query: z.string().describe("Entity name to search for (partial match)."),
        project: z.string().optional().describe("Filter to a specific project."),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)."),
      }),
    },
    async ({ query, project, limit }) => {
      const db = ctx.db();
      const max = limit ?? 10;
      const pattern = `%${query.toLowerCase()}%`;

      let sql: string;
      let params: (string | number)[];

      if (project) {
        sql = `
          SELECT e.name, e.type, COUNT(el.source_id) as ref_count
          FROM entities e
          LEFT JOIN entity_links el ON el.target_id = e.id
          WHERE e.name LIKE ? AND el.source_doc LIKE ?
          GROUP BY e.id, e.name, e.type
          ORDER BY ref_count DESC
          LIMIT ?
        `;
        params = [pattern, `${project}/%`, max];
      } else {
        sql = `
          SELECT e.name, e.type, COUNT(el.source_id) as ref_count
          FROM entities e
          LEFT JOIN entity_links el ON el.target_id = e.id
          WHERE e.name LIKE ?
          GROUP BY e.id, e.name, e.type
          ORDER BY ref_count DESC
          LIMIT ?
        `;
        params = [pattern, max];
      }

      const rows = queryRows(db, sql, params);
      if (!rows || rows.length === 0) {
        return mcpResponse({ ok: true, data: [], message: `No entities matching "${query}".` });
      }

      const entities = rows.map(r => ({
        name: String(r[0]),
        type: String(r[1]),
        refCount: Number(r[2]),
      }));

      return mcpResponse({ ok: true, data: entities });
    },
  );

  // ── get_related_docs ──────────────────────────────────────────────────────
  server.registerTool(
    "get_related_docs",
    {
      title: "◆ cortex · related docs",
      description:
        "Find all findings and docs that mention a specific entity (library, tool, concept). " +
        "Use this to see how a technology is used across projects.",
      inputSchema: z.object({
        entity: z.string().describe("Entity name to look up."),
        project: z.string().optional().describe("Filter to a specific project."),
        limit: z.number().int().min(1).max(50).optional().describe("Max docs to return (default 10)."),
      }),
    },
    async ({ entity, project, limit }) => {
      const db = ctx.db();
      const max = limit ?? 10;

      const links = queryEntityLinks(db, entity.toLowerCase());
      let relatedDocs = links.related.filter(r => r.includes("/"));

      if (project) {
        relatedDocs = relatedDocs.filter(d => d.startsWith(`${project}/`));
      }

      relatedDocs = relatedDocs.slice(0, max);

      if (relatedDocs.length === 0) {
        return mcpResponse({ ok: true, data: [], message: `No docs found referencing "${entity}".` });
      }

      const results: { sourceDoc: string; snippet: string }[] = [];
      for (const doc of relatedDocs) {
        const docRow = queryDocBySourceKey(db, ctx.cortexPath, doc);
        const snippet = docRow?.content ? docRow.content.slice(0, 200) : "";
        results.push({ sourceDoc: doc, snippet });
      }

      return mcpResponse({ ok: true, data: results });
    },
  );

  // ── read_graph ────────────────────────────────────────────────────────────
  server.registerTool(
    "read_graph",
    {
      title: "◆ cortex · knowledge graph",
      description:
        "Read the entity relationship graph. Returns top entities by reference count " +
        "and their connected documents.",
      inputSchema: z.object({
        project: z.string().optional().describe("Filter to a specific project."),
        limit: z.number().int().min(1).max(2000).optional().describe("Max entities to return (default 500, max 2000)."),
        offset: z.number().int().min(0).optional().describe("Number of entities to skip for pagination (default 0)."),
      }),
    },
    async ({ project, limit, offset }) => {
      const db = ctx.db();
      const max = limit ?? 500;
      const skip = offset ?? 0;

      // First get total count
      let countSql: string;
      let countParams: (string | number)[];
      if (project) {
        countSql = `
          SELECT COUNT(*) FROM (
            SELECT e.id FROM entities e
            JOIN entity_links el ON el.target_id = e.id
            WHERE e.type != 'document' AND el.source_doc LIKE ?
            GROUP BY e.id
          )
        `;
        countParams = [`${project}/%`];
      } else {
        countSql = `
          SELECT COUNT(*) FROM (
            SELECT e.id FROM entities e
            JOIN entity_links el ON el.target_id = e.id
            WHERE e.type != 'document'
            GROUP BY e.id
          )
        `;
        countParams = [];
      }
      const countRows = queryRows(db, countSql, countParams);
      const total = countRows && countRows.length > 0 ? Number(countRows[0][0]) : 0;

      let sql: string;
      let params: (string | number)[];

      if (project) {
        sql = `
          SELECT e.name, e.type, COUNT(el.source_id) as ref_count,
                 GROUP_CONCAT(DISTINCT el.source_doc) as docs
          FROM entities e
          JOIN entity_links el ON el.target_id = e.id
          WHERE e.type != 'document' AND el.source_doc LIKE ?
          GROUP BY e.id, e.name, e.type
          ORDER BY ref_count DESC
          LIMIT ? OFFSET ?
        `;
        params = [`${project}/%`, max, skip];
      } else {
        sql = `
          SELECT e.name, e.type, COUNT(el.source_id) as ref_count,
                 GROUP_CONCAT(DISTINCT el.source_doc) as docs
          FROM entities e
          JOIN entity_links el ON el.target_id = e.id
          WHERE e.type != 'document'
          GROUP BY e.id, e.name, e.type
          ORDER BY ref_count DESC
          LIMIT ? OFFSET ?
        `;
        params = [max, skip];
      }

      const rows = queryRows(db, sql, params);
      if (!rows || rows.length === 0) {
        return mcpResponse({ ok: true, data: { entities: [], total, hasMore: false }, message: "No entities in the graph." });
      }

      const entities = rows.map(r => ({
        name: String(r[0]),
        type: String(r[1]),
        refCount: Number(r[2]),
        docs: String(r[3] || "").split(",").filter(Boolean),
      }));

      const hasMore = skip + entities.length < total;
      return mcpResponse({ ok: true, data: { entities, total, hasMore, offset: skip, limit: max } });
    },
  );

  // ── link_findings ─────────────────────────────────────────────────────────
  server.registerTool(
    "link_findings",
    {
      title: "◆ cortex · link findings",
      description:
        "Manually link a finding to an entity (technology/concept) that wasn't auto-detected. " +
        "Use this to explicitly connect a finding to a library or tool.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        finding_text: z.string().describe("Partial text of the finding to link (used to locate the source doc)."),
        entity: z.string().describe("Entity name to link to (e.g. 'Redis', 'Docker')."),
        relation: z.string().optional().describe("Relationship type (default: 'mentions')."),
        entity_type: z.string().optional().describe("Entity type (e.g. 'library', 'service', 'concept', 'architecture'). Defaults to 'entity'."),
      }),
    },
    async ({ project, finding_text, entity, relation, entity_type }) => {
      if (!isValidProjectName(project)) {
        return mcpResponse({ ok: false, error: `Invalid project: "${project}"` });
      }

      return ctx.withWriteQueue(async () => {
        const db = ctx.db();
        const relType = relation ?? "mentions";
        const entityName = entity.toLowerCase();
        const resolvedEntityType = entity_type ?? "entity";

        // 1. Find or create entity
        try {
          db.run("INSERT OR IGNORE INTO entities (name, type) VALUES (?, ?)", [entityName, resolvedEntityType]);
        } catch { /* ignore */ }
        const entityResult = db.exec("SELECT id FROM entities WHERE name = ? AND type = ?", [entityName, resolvedEntityType]);
        if (!entityResult?.length || !entityResult[0]?.values?.length) {
          return mcpResponse({ ok: false, error: "Failed to create entity." });
        }
        const targetId = Number(entityResult[0].values[0][0]);

        // 2. Find source doc — look for FINDINGS.md (or legacy LEARNINGS.md) containing the finding text
        let docCheck = queryRows(db, "SELECT content FROM docs WHERE project = ? AND filename = 'FINDINGS.md' LIMIT 1", [project]);
        let sourceDoc = `${project}/FINDINGS.md`;
        if (!docCheck || docCheck.length === 0) {
          docCheck = queryRows(db, "SELECT content FROM docs WHERE project = ? AND filename = 'LEARNINGS.md' LIMIT 1", [project]);
          sourceDoc = `${project}/LEARNINGS.md`;
        }
        if (!docCheck || docCheck.length === 0) {
          return mcpResponse({ ok: false, error: `No FINDINGS.md found for project "${project}".` });
        }
        const content = String(docCheck[0][0]);
        if (!content.toLowerCase().includes(finding_text.toLowerCase())) {
          return mcpResponse({ ok: false, error: `Finding text not found in ${sourceDoc}.` });
        }

        // 3. Find or create document entity
        try {
          db.run("INSERT OR IGNORE INTO entities (name, type) VALUES (?, ?)", [sourceDoc, "document"]);
        } catch { /* ignore */ }
        const docEntityResult = db.exec("SELECT id FROM entities WHERE name = ? AND type = ?", [sourceDoc, "document"]);
        if (!docEntityResult?.length || !docEntityResult[0]?.values?.length) {
          return mcpResponse({ ok: false, error: "Failed to create document entity." });
        }
        const sourceId = Number(docEntityResult[0].values[0][0]);

        // 4. Insert entity_link
        try {
          db.run(
            "INSERT OR IGNORE INTO entity_links (source_id, target_id, rel_type, source_doc) VALUES (?, ?, ?, ?)",
            [sourceId, targetId, relType, sourceDoc],
          );
        } catch {
          return mcpResponse({ ok: false, error: "Failed to insert entity link." });
        }

        // 4b. Persist manual link so it survives index rebuilds (mandatory — failure aborts the operation)
        const manualLinksPath = runtimeFile(ctx.cortexPath, "manual-links.json");
        try {
          withFileLock(manualLinksPath, () => {
            let existing: Array<{ entity: string; entityType: string; sourceDoc: string; relType: string }> = [];
            if (fs.existsSync(manualLinksPath)) {
              try { existing = JSON.parse(fs.readFileSync(manualLinksPath, "utf8")); } catch { /* corrupt file — start fresh */ }
            }
            const newEntry = { entity: entityName, entityType: resolvedEntityType, sourceDoc, relType };
            const alreadyStored = existing.some(
              (e) => e.entity === newEntry.entity && e.entityType === newEntry.entityType && e.sourceDoc === newEntry.sourceDoc && e.relType === newEntry.relType
            );
            if (!alreadyStored) {
              existing.push(newEntry);
              const tmpPath = manualLinksPath + `.tmp-${crypto.randomUUID()}`;
              fs.writeFileSync(tmpPath, JSON.stringify(existing, null, 2));
              fs.renameSync(tmpPath, manualLinksPath);
            }
          });
        } catch (persistErr) {
          // Persistence failed — return error without rebuilding (in-memory link would be discarded by rebuild)
          return mcpResponse({
            ok: false,
            error: `Failed to persist manual link: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
            errorCode: "INTERNAL_ERROR",
          });
        }

        // 5. Rebuild index to refresh (only after successful persistence)
        await ctx.rebuildIndex();

        return mcpResponse({
          ok: true,
          message: `Linked "${entity}" to ${sourceDoc} with relation "${relType}".`,
        });
      });
    },
  );

  // ── cross_project_entities (Q20) ───────────────────────────────────────────
  server.registerTool(
    "cross_project_entities",
    {
      title: "◆ cortex · cross-project entities",
      description:
        "Find entities (libraries, tools, concepts) shared across multiple projects. " +
        "Use this to discover how a technology or concept is used in other projects.",
      inputSchema: z.object({
        entity: z.string().describe("Entity name to search for (partial match)."),
        exclude_project: z.string().optional().describe("Exclude a specific project from results."),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 20)."),
      }),
    },
    async ({ entity, exclude_project, limit }) => {
      const db = ctx.db();
      const max = limit ?? 20;
      const results = queryCrossProjectEntities(db, entity, exclude_project);
      const capped = results.slice(0, max);

      if (capped.length === 0) {
        return mcpResponse({ ok: true, data: [], message: `No cross-project references found for "${entity}".` });
      }

      // Group by project for cleaner output
      const byProject = new Map<string, Array<{ entity: string; docKey: string }>>();
      for (const r of capped) {
        const arr = byProject.get(r.project) ?? [];
        arr.push({ entity: r.entity, docKey: r.docKey });
        byProject.set(r.project, arr);
      }

      const lines: string[] = [];
      for (const [proj, refs] of byProject) {
        lines.push(`### ${proj}`);
        for (const ref of refs) {
          lines.push(`- ${ref.entity} (${ref.docKey})`);
        }
      }

      return mcpResponse({
        ok: true,
        message: `Cross-project references for "${entity}" (${capped.length} results):\n\n${lines.join("\n")}`,
        data: capped,
      });
    },
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext } from "./mcp-types.js";
import { z } from "zod";
import * as fs from "fs";
import { isValidProjectName } from "./utils.js";
import { queryDocBySourceKey, queryRows, queryEntityLinks } from "./shared-index.js";
import { runtimeFile } from "./shared.js";

function jsonResponse(payload: { ok: boolean; data?: unknown; error?: string; message?: string }) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

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
        return jsonResponse({ ok: true, data: [], message: `No entities matching "${query}".` });
      }

      const entities = rows.map(r => ({
        name: String(r[0]),
        type: String(r[1]),
        refCount: Number(r[2]),
      }));

      return jsonResponse({ ok: true, data: entities });
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
        return jsonResponse({ ok: true, data: [], message: `No docs found referencing "${entity}".` });
      }

      const results: { sourceDoc: string; snippet: string }[] = [];
      for (const doc of relatedDocs) {
        const docRow = queryDocBySourceKey(db, ctx.cortexPath, doc);
        const snippet = docRow?.content ? docRow.content.slice(0, 200) : "";
        results.push({ sourceDoc: doc, snippet });
      }

      return jsonResponse({ ok: true, data: results });
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
        limit: z.number().int().min(1).max(100).optional().describe("Max entities to return (default 20)."),
      }),
    },
    async ({ project, limit }) => {
      const db = ctx.db();
      const max = limit ?? 20;

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
          LIMIT ?
        `;
        params = [`${project}/%`, max];
      } else {
        sql = `
          SELECT e.name, e.type, COUNT(el.source_id) as ref_count,
                 GROUP_CONCAT(DISTINCT el.source_doc) as docs
          FROM entities e
          JOIN entity_links el ON el.target_id = e.id
          WHERE e.type != 'document'
          GROUP BY e.id, e.name, e.type
          ORDER BY ref_count DESC
          LIMIT ?
        `;
        params = [max];
      }

      const rows = queryRows(db, sql, params);
      if (!rows || rows.length === 0) {
        return jsonResponse({ ok: true, data: [], message: "No entities in the graph." });
      }

      const entities = rows.map(r => ({
        name: String(r[0]),
        type: String(r[1]),
        refCount: Number(r[2]),
        docs: String(r[3] || "").split(",").filter(Boolean),
      }));

      return jsonResponse({ ok: true, data: entities });
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
      }),
    },
    async ({ project, finding_text, entity, relation }) => {
      if (!isValidProjectName(project)) {
        return jsonResponse({ ok: false, error: `Invalid project: "${project}"` });
      }

      return ctx.withWriteQueue(async () => {
        const db = ctx.db();
        const relType = relation ?? "mentions";
        const entityName = entity.toLowerCase();

        // 1. Find or create entity
        try {
          db.run("INSERT OR IGNORE INTO entities (name, type) VALUES (?, ?)", [entityName, "library"]);
        } catch { /* ignore */ }
        const entityResult = db.exec("SELECT id FROM entities WHERE name = ? AND type = ?", [entityName, "library"]);
        if (!entityResult?.length || !entityResult[0]?.values?.length) {
          return jsonResponse({ ok: false, error: "Failed to create entity." });
        }
        const targetId = Number(entityResult[0].values[0][0]);

        // 2. Find source doc — look for FINDINGS.md containing the finding text
        const sourceDoc = `${project}/FINDINGS.md`;
        const docCheck = queryRows(db, "SELECT content FROM docs WHERE project = ? AND filename = 'FINDINGS.md' LIMIT 1", [project]);
        if (!docCheck || docCheck.length === 0) {
          return jsonResponse({ ok: false, error: `No FINDINGS.md found for project "${project}".` });
        }
        const content = String(docCheck[0][0]);
        if (!content.toLowerCase().includes(finding_text.toLowerCase())) {
          return jsonResponse({ ok: false, error: `Finding text not found in ${project}/FINDINGS.md.` });
        }

        // 3. Find or create document entity
        try {
          db.run("INSERT OR IGNORE INTO entities (name, type) VALUES (?, ?)", [sourceDoc, "document"]);
        } catch { /* ignore */ }
        const docEntityResult = db.exec("SELECT id FROM entities WHERE name = ? AND type = ?", [sourceDoc, "document"]);
        if (!docEntityResult?.length || !docEntityResult[0]?.values?.length) {
          return jsonResponse({ ok: false, error: "Failed to create document entity." });
        }
        const sourceId = Number(docEntityResult[0].values[0][0]);

        // 4. Insert entity_link
        try {
          db.run(
            "INSERT OR IGNORE INTO entity_links (source_id, target_id, rel_type, source_doc) VALUES (?, ?, ?, ?)",
            [sourceId, targetId, relType, sourceDoc],
          );
        } catch {
          return jsonResponse({ ok: false, error: "Failed to insert entity link." });
        }

        // 4b. Persist manual link so it survives index rebuilds
        const manualLinksPath = runtimeFile(ctx.cortexPath, "manual-links.json");
        try {
          let existing: Array<{ entity: string; entityType: string; sourceDoc: string; relType: string }> = [];
          if (fs.existsSync(manualLinksPath)) {
            existing = JSON.parse(fs.readFileSync(manualLinksPath, "utf8"));
          }
          const newEntry = { entity: entityName, entityType: "library", sourceDoc, relType };
          const alreadyStored = existing.some(
            (e) => e.entity === newEntry.entity && e.sourceDoc === newEntry.sourceDoc && e.relType === newEntry.relType
          );
          if (!alreadyStored) {
            existing.push(newEntry);
            fs.writeFileSync(manualLinksPath, JSON.stringify(existing, null, 2));
          }
        } catch { /* non-fatal — link is still in DB for this session */ }

        // 5. Rebuild index to refresh
        await ctx.rebuildIndex();

        return jsonResponse({
          ok: true,
          message: `Linked "${entity}" to ${sourceDoc} with relation "${relType}".`,
        });
      });
    },
  );
}

import { mcpResponse } from "./mcp-types.js";
import { z } from "zod";
import * as fs from "fs";
import * as crypto from "crypto";
import { isValidProjectName } from "./utils.js";
import { queryDocBySourceKey, queryRows, queryFragmentLinks, queryCrossProjectFragments, ensureGlobalEntitiesTable, logFragmentMiss } from "./shared-index.js";
import { runtimeFile } from "./shared.js";
import { withFileLock } from "./shared-governance.js";
export function register(server, ctx) {
    // ── search_fragments ──────────────────────────────────────────────────
    server.registerTool("search_fragments", {
        title: "phren : search fragments",
        description: "Search named fragments in the knowledge graph (libraries, tools, concepts mentioned in findings). " +
            "Returns matching fragment names and how many findings reference each.",
        inputSchema: z.object({
            query: z.string().describe("Fragment name to search for (partial match)."),
            project: z.string().optional().describe("Filter to a specific project."),
            limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)."),
        }),
    }, async ({ query, project, limit }) => {
        const db = ctx.db();
        const max = limit ?? 10;
        const pattern = `%${query.toLowerCase()}%`;
        let sql;
        let params;
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
        }
        else {
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
            logFragmentMiss(ctx.phrenPath, query, "search_fragments", project);
            return mcpResponse({ ok: true, data: [], message: `No fragments matching "${query}".` });
        }
        const fragments = rows.map(r => ({
            name: String(r[0]),
            type: String(r[1]),
            refCount: Number(r[2]),
        }));
        return mcpResponse({ ok: true, data: fragments });
    });
    // ── get_related_docs ──────────────────────────────────────────────────
    server.registerTool("get_related_docs", {
        title: "phren : related docs",
        description: "Find all findings and docs that mention a specific fragment (library, tool, concept). " +
            "Use this to see how a technology is used across projects.",
        inputSchema: z.object({
            entity: z.string().describe("Fragment name to look up."),
            project: z.string().optional().describe("Filter to a specific project."),
            limit: z.number().int().min(1).max(50).optional().describe("Max docs to return (default 10)."),
        }),
    }, async ({ entity, project, limit }) => {
        const db = ctx.db();
        const max = limit ?? 10;
        const links = queryFragmentLinks(db, entity.toLowerCase());
        let relatedDocs = links.related.filter(r => r.includes("/"));
        if (project) {
            relatedDocs = relatedDocs.filter(d => d.startsWith(`${project}/`));
        }
        relatedDocs = relatedDocs.slice(0, max);
        if (relatedDocs.length === 0) {
            logFragmentMiss(ctx.phrenPath, entity, "get_related_docs", project);
            return mcpResponse({ ok: true, data: [], message: `No docs found referencing fragment "${entity}".` });
        }
        const results = [];
        for (const doc of relatedDocs) {
            const docRow = queryDocBySourceKey(db, ctx.phrenPath, doc);
            const snippet = docRow?.content ? docRow.content.slice(0, 200) : "";
            results.push({ sourceDoc: doc, snippet });
        }
        return mcpResponse({ ok: true, data: results });
    });
    // ── read_graph ────────────────────────────────────────────────────────
    server.registerTool("read_graph", {
        title: "phren : knowledge graph",
        description: "Read the fragment relationship graph. Returns top fragments by reference count " +
            "and their connected documents.",
        inputSchema: z.object({
            project: z.string().optional().describe("Filter to a specific project."),
            limit: z.number().int().min(1).max(2000).optional().describe("Max fragments to return (default 500, max 2000)."),
            offset: z.number().int().min(0).optional().describe("Number of fragments to skip for pagination (default 0)."),
        }),
    }, async ({ project, limit, offset }) => {
        const db = ctx.db();
        const max = limit ?? 500;
        const skip = offset ?? 0;
        // First get total count
        let countSql;
        let countParams;
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
        }
        else {
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
        let sql;
        let params;
        // Step 1: Get fragment list with counts (no GROUP_CONCAT to avoid comma-in-value bugs)
        if (project) {
            sql = `
          SELECT e.id, e.name, e.type, COUNT(el.source_id) as ref_count
          FROM entities e
          JOIN entity_links el ON el.target_id = e.id
          WHERE e.type != 'document' AND el.source_doc LIKE ?
          GROUP BY e.id, e.name, e.type
          ORDER BY ref_count DESC
          LIMIT ? OFFSET ?
        `;
            params = [`${project}/%`, max, skip];
        }
        else {
            sql = `
          SELECT e.id, e.name, e.type, COUNT(el.source_id) as ref_count
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
            return mcpResponse({ ok: true, data: { fragments: [], total, hasMore: false }, message: "No fragments in the graph." });
        }
        // Step 2: For each fragment, fetch its docs as separate rows
        const fragments = rows.map(r => {
            const fragmentId = Number(r[0]);
            const docSql = project
                ? "SELECT DISTINCT el.source_doc FROM entity_links el WHERE el.target_id = ? AND el.source_doc LIKE ?"
                : "SELECT DISTINCT el.source_doc FROM entity_links el WHERE el.target_id = ?";
            const docParams = project ? [fragmentId, `${project}/%`] : [fragmentId];
            const docRows = queryRows(db, docSql, docParams);
            const docs = (docRows || []).map(dr => String(dr[0]));
            const fragmentName = String(r[1]);
            return {
                id: `fragment:${fragmentName}`,
                name: fragmentName,
                type: String(r[2]),
                refCount: Number(r[3]),
                docs,
            };
        });
        const hasMore = skip + fragments.length < total;
        return mcpResponse({ ok: true, data: { fragments, total, hasMore, offset: skip, limit: max } });
    });
    // ── link_findings ─────────────────────────────────────────────────────
    server.registerTool("link_findings", {
        title: "phren : link findings",
        description: "Manually link a finding to a fragment (technology/concept) that wasn't auto-detected. " +
            "Use this to explicitly connect a finding to a library or tool.",
        inputSchema: z.object({
            project: z.string().describe("Project name."),
            finding_text: z.string().describe("Partial text of the finding to link (used to locate the source doc)."),
            entity: z.string().describe("Fragment name to link to (e.g. 'Redis', 'Docker')."),
            relation: z.string().optional().describe("Relationship type (default: 'mentions')."),
            entity_type: z.string().optional().describe("Fragment type (e.g. 'library', 'service', 'concept', 'architecture'). Defaults to 'fragment'."),
        }),
    }, async ({ project, finding_text, entity, relation, entity_type }) => {
        if (!isValidProjectName(project)) {
            return mcpResponse({ ok: false, error: `Invalid project: "${project}"` });
        }
        return ctx.withWriteQueue(async () => {
            const db = ctx.db();
            const relType = relation ?? "mentions";
            const fragmentName = entity.toLowerCase();
            const resolvedFragmentType = entity_type ?? "fragment";
            // 1. Find or create fragment
            try {
                db.run("INSERT OR IGNORE INTO entities (name, type, first_seen_at) VALUES (?, ?, ?)", [fragmentName, resolvedFragmentType, new Date().toISOString().slice(0, 10)]);
            }
            catch (err) {
                if (process.env.PHREN_DEBUG || (process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
                    process.stderr.write(`[phren] link_findings fragmentInsert: ${err instanceof Error ? err.message : String(err)}\n`);
            }
            const fragmentResult = db.exec("SELECT id FROM entities WHERE name = ? AND type = ?", [fragmentName, resolvedFragmentType]);
            if (!fragmentResult?.length || !fragmentResult[0]?.values?.length) {
                return mcpResponse({ ok: false, error: "Failed to create fragment." });
            }
            const targetId = Number(fragmentResult[0].values[0][0]);
            // 2. Find source doc in the canonical findings document
            const docCheck = queryRows(db, "SELECT content FROM docs WHERE project = ? AND filename = 'FINDINGS.md' LIMIT 1", [project]);
            let sourceDoc = `${project}/FINDINGS.md`;
            if (!docCheck || docCheck.length === 0) {
                return mcpResponse({ ok: false, error: `No FINDINGS.md found for project "${project}".` });
            }
            const content = String(docCheck[0][0]);
            if (!content.toLowerCase().includes(finding_text.toLowerCase())) {
                return mcpResponse({ ok: false, error: `Finding text not found in ${sourceDoc}.` });
            }
            // 3. Find or create document fragment
            try {
                db.run("INSERT OR IGNORE INTO entities (name, type, first_seen_at) VALUES (?, ?, ?)", [sourceDoc, "document", new Date().toISOString().slice(0, 10)]);
            }
            catch (err) {
                if (process.env.PHREN_DEBUG || (process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
                    process.stderr.write(`[phren] link_findings docFragmentInsert: ${err instanceof Error ? err.message : String(err)}\n`);
            }
            const docFragmentResult = db.exec("SELECT id FROM entities WHERE name = ? AND type = ?", [sourceDoc, "document"]);
            if (!docFragmentResult?.length || !docFragmentResult[0]?.values?.length) {
                return mcpResponse({ ok: false, error: "Failed to create document fragment." });
            }
            const sourceId = Number(docFragmentResult[0].values[0][0]);
            // 4. Insert fragment link
            try {
                db.run("INSERT OR IGNORE INTO entity_links (source_id, target_id, rel_type, source_doc) VALUES (?, ?, ?, ?)", [sourceId, targetId, relType, sourceDoc]);
            }
            catch (err) {
                if (process.env.PHREN_DEBUG || (process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
                    process.stderr.write(`[phren] link_findings linkInsert: ${err instanceof Error ? err.message : String(err)}\n`);
                return mcpResponse({ ok: false, error: "Failed to insert fragment link." });
            }
            // 4a. Also populate global_entities so manual links appear in cross_project_fragments
            try {
                ensureGlobalEntitiesTable(db);
                db.run("INSERT OR IGNORE INTO global_entities (entity, project, doc_key) VALUES (?, ?, ?)", [fragmentName, project, sourceDoc]);
            }
            catch (err) {
                if (process.env.PHREN_DEBUG || (process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
                    process.stderr.write(`[phren] link_findings globalFragments: ${err instanceof Error ? err.message : String(err)}\n`);
            }
            // 4b. Persist manual link so it survives index rebuilds (mandatory — failure aborts the operation)
            const manualLinksPath = runtimeFile(ctx.phrenPath, "manual-links.json");
            try {
                withFileLock(manualLinksPath, () => {
                    let existing = [];
                    if (fs.existsSync(manualLinksPath)) {
                        try {
                            existing = JSON.parse(fs.readFileSync(manualLinksPath, "utf8"));
                        }
                        catch (err) {
                            if (process.env.PHREN_DEBUG || (process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
                                process.stderr.write(`[phren] link_findings manualLinksRead: ${err instanceof Error ? err.message : String(err)}\n`);
                        }
                    }
                    const newEntry = { entity: fragmentName, entityType: resolvedFragmentType, sourceDoc, relType };
                    const alreadyStored = existing.some((e) => e.entity === newEntry.entity && e.entityType === newEntry.entityType && e.sourceDoc === newEntry.sourceDoc && e.relType === newEntry.relType);
                    if (!alreadyStored) {
                        existing.push(newEntry);
                        const tmpPath = manualLinksPath + `.tmp-${crypto.randomUUID()}`;
                        fs.writeFileSync(tmpPath, JSON.stringify(existing, null, 2));
                        fs.renameSync(tmpPath, manualLinksPath);
                    }
                });
            }
            catch (persistErr) {
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
    });
    // ── cross_project_fragments ───────────────────────────────────────────
    server.registerTool("cross_project_fragments", {
        title: "phren : cross-project fragments",
        description: "Find fragments (libraries, tools, concepts) shared across multiple projects. " +
            "Use this to discover how a technology or concept is used in other projects.",
        inputSchema: z.object({
            entity: z.string().describe("Fragment name to search for (partial match)."),
            exclude_project: z.string().optional().describe("Exclude a specific project from results."),
            limit: z.number().int().min(1).max(50).optional().describe("Max results (default 20)."),
        }),
    }, async ({ entity, exclude_project, limit }) => {
        const db = ctx.db();
        const max = limit ?? 20;
        const results = queryCrossProjectFragments(db, entity, exclude_project);
        const capped = results.slice(0, max);
        if (capped.length === 0) {
            logFragmentMiss(ctx.phrenPath, entity, "cross_project_fragments", exclude_project);
            return mcpResponse({ ok: true, data: [], message: `No cross-project references found for "${entity}".` });
        }
        // Group by project for cleaner output
        const byProject = new Map();
        for (const r of capped) {
            const arr = byProject.get(r.project) ?? [];
            arr.push({ fragment: r.fragment, docKey: r.docKey });
            byProject.set(r.project, arr);
        }
        const lines = [];
        for (const [proj, refs] of byProject) {
            lines.push(`### ${proj}`);
            for (const ref of refs) {
                lines.push(`- ${ref.fragment} (${ref.docKey})`);
            }
        }
        return mcpResponse({
            ok: true,
            message: `Cross-project references for "${entity}" (${capped.length} results):\n\n${lines.join("\n")}`,
            data: capped,
        });
    });
}

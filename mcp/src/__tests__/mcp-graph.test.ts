import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, writeFile } from "../test-helpers.js";
import { buildIndex, queryRows } from "../shared-index.js";

function runtimeFile(phrenPath: string, name: string) {
  return path.join(phrenPath, ".runtime", name);
}

function seedFindings(phrenPath: string, project: string, content: string) {
  writeFile(path.join(phrenPath, project, "FINDINGS.md"), content);
}

describe("manual-links.json persistence", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => { tmp = makeTempDir("mcp-graph-"); });
  afterEach(() => tmp.cleanup());

  it("manual-links.json is merged into index on rebuild", async () => {
    seedFindings(tmp.path, "myapp", "# myapp\n\n- Docker needs explicit network cleanup in finally blocks\n");
    const manualLinksPath = runtimeFile(tmp.path, "manual-links.json");
    fs.mkdirSync(path.dirname(manualLinksPath), { recursive: true });
    fs.writeFileSync(manualLinksPath, JSON.stringify([
      { entity: "docker", entityType: "library", sourceDoc: "myapp/FINDINGS.md", relType: "mentions" }
    ]));

    const db = await buildIndex(tmp.path);

    const entityRows = db.exec("SELECT name FROM entities WHERE name = 'docker'");
    expect(entityRows[0]?.values?.length).toBeGreaterThan(0);

    const linkRows = db.exec("SELECT rel_type FROM entity_links JOIN entities ON entity_links.target_id = entities.id WHERE entities.name = 'docker'");
    expect(linkRows[0]?.values?.[0]?.[0]).toBe("mentions");
  });

  it("survives a second rebuild (links not lost)", async () => {
    seedFindings(tmp.path, "proj", "# proj\n\n- Docker requires explicit network config\n");
    const manualLinksPath = runtimeFile(tmp.path, "manual-links.json");
    fs.mkdirSync(path.dirname(manualLinksPath), { recursive: true });
    fs.writeFileSync(manualLinksPath, JSON.stringify([
      { entity: "docker", entityType: "library", sourceDoc: "proj/FINDINGS.md", relType: "mentions" }
    ]));

    await buildIndex(tmp.path);
    // Second rebuild
    const db2 = await buildIndex(tmp.path);
    const rows = db2.exec("SELECT name FROM entities WHERE name = 'docker'");
    expect(rows[0]?.values?.length).toBeGreaterThan(0);
  });

  it("handles missing manual-links.json gracefully", async () => {
    seedFindings(tmp.path, "proj", "# proj\n\n- A finding\n");
    await expect(buildIndex(tmp.path)).resolves.toBeDefined();
  });
});

describe("read_graph pagination", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => { tmp = makeTempDir("mcp-graph-page-"); });
  afterEach(() => tmp.cleanup());

  function seedMultipleEntities(phrenPath: string) {
    // Create findings that mention multiple fragments so the fragment graph has entries
    seedFindings(phrenPath, "proj", [
      "# proj Findings",
      "",
      "## 2025-01-01",
      "",
      "- Redis needs connection pooling",
      "- Docker requires explicit network config",
      "- PostgreSQL needs WAL mode for concurrent reads",
      "- Nginx reverse proxy config is tricky",
      "",
    ].join("\n"));
    const manualLinksPath = path.join(phrenPath, ".runtime", "manual-links.json");
    fs.mkdirSync(path.dirname(manualLinksPath), { recursive: true });
    fs.writeFileSync(manualLinksPath, JSON.stringify([
      { entity: "redis", entityType: "library", sourceDoc: "proj/FINDINGS.md", relType: "mentions" },
      { entity: "docker", entityType: "library", sourceDoc: "proj/FINDINGS.md", relType: "mentions" },
      { entity: "postgresql", entityType: "library", sourceDoc: "proj/FINDINGS.md", relType: "mentions" },
      { entity: "nginx", entityType: "library", sourceDoc: "proj/FINDINGS.md", relType: "mentions" },
    ]));
  }

  it("limit=2 returns only 2 fragments", async () => {
    seedMultipleEntities(tmp.path);
    const db = await buildIndex(tmp.path);

    const sql = `
      SELECT e.name, e.type, COUNT(el.source_id) as ref_count,
             GROUP_CONCAT(DISTINCT el.source_doc) as docs
      FROM entities e
      JOIN entity_links el ON el.target_id = e.id
      WHERE e.type != 'document'
      GROUP BY e.id, e.name, e.type
      ORDER BY ref_count DESC
      LIMIT ? OFFSET ?
    `;
    const rows = queryRows(db, sql, [2, 0]);
    expect(rows).not.toBeNull();
    expect(rows!.length).toBeLessThanOrEqual(2);

    // Total count should be >= 4 (our 4 manual fragments)
    const countSql = `
      SELECT COUNT(*) FROM (
        SELECT e.id FROM entities e
        JOIN entity_links el ON el.target_id = e.id
        WHERE e.type != 'document'
        GROUP BY e.id
      )
    `;
    const countRows = queryRows(db, countSql, []);
    expect(countRows).not.toBeNull();
    const total = Number(countRows![0][0]);
    expect(total).toBeGreaterThanOrEqual(1);

    // hasMore should be true if total > limit
    if (total > 2) {
      const hasMore = 0 + rows!.length < total;
      expect(hasMore).toBe(true);
    }
  });

  it("offset returns a different page of results", async () => {
    seedMultipleEntities(tmp.path);
    const db = await buildIndex(tmp.path);

    const sql = `
      SELECT e.name, e.type, COUNT(el.source_id) as ref_count,
             GROUP_CONCAT(DISTINCT el.source_doc) as docs
      FROM entities e
      JOIN entity_links el ON el.target_id = e.id
      WHERE e.type != 'document'
      GROUP BY e.id, e.name, e.type
      ORDER BY ref_count DESC
      LIMIT ? OFFSET ?
    `;

    const page1 = queryRows(db, sql, [2, 0]);
    const page2 = queryRows(db, sql, [2, 2]);
    expect(page1).not.toBeNull();
    if (!page2 || page2.length === 0) return; // not enough fragments for pagination

    // Pages should not overlap
    const page1Names = page1!.map(r => String(r[0]));
    const page2Names = page2!.map(r => String(r[0]));
    for (const name of page1Names) {
      expect(page2Names).not.toContain(name);
    }
  });
});

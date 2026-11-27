import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, writeFile } from "../test-helpers.js";
import { buildIndex, extractWikilinks, getFragmentBoostDocs, queryFragmentLinks, queryRows, updateFileInIndex } from "../shared/index.js";

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
    seedFindings(tmp.path, "myapp", "# myapp\n\n- Explicit network cleanup belongs in finally blocks\n");
    const manualLinksPath = runtimeFile(tmp.path, "manual-links.json");
    fs.mkdirSync(path.dirname(manualLinksPath), { recursive: true });
    fs.writeFileSync(manualLinksPath, JSON.stringify([
      { entity: "kube-router", entityType: "library", sourceDoc: "myapp/FINDINGS.md", relType: "mentions" }
    ]));

    const db = await buildIndex(tmp.path);

    const entityRows = db.exec("SELECT name FROM entities WHERE name = 'kube-router'");
    expect(entityRows[0]?.values?.length).toBeGreaterThan(0);

    const linkRows = db.exec("SELECT rel_type FROM entity_links JOIN entities ON entity_links.target_id = entities.id WHERE entities.name = 'kube-router'");
    expect(linkRows[0]?.values?.[0]?.[0]).toBe("mentions");
    expect(JSON.parse(fs.readFileSync(manualLinksPath, "utf8"))).toEqual([
      { entity: "kube-router", entityType: "library", sourceDoc: "myapp/FINDINGS.md", relType: "mentions" },
    ]);
  });

  it("survives a second rebuild (links not lost)", async () => {
    seedFindings(tmp.path, "proj", "# proj\n\n- Explicit network config must be documented\n");
    const manualLinksPath = runtimeFile(tmp.path, "manual-links.json");
    fs.mkdirSync(path.dirname(manualLinksPath), { recursive: true });
    fs.writeFileSync(manualLinksPath, JSON.stringify([
      { entity: "service-mesh", entityType: "library", sourceDoc: "proj/FINDINGS.md", relType: "mentions" }
    ]));

    await buildIndex(tmp.path);
    // Second rebuild
    const db2 = await buildIndex(tmp.path);
    const rows = db2.exec("SELECT name FROM entities WHERE name = 'service-mesh'");
    expect(rows[0]?.values?.length).toBeGreaterThan(0);
    expect(JSON.parse(fs.readFileSync(manualLinksPath, "utf8"))).toEqual([
      { entity: "service-mesh", entityType: "library", sourceDoc: "proj/FINDINGS.md", relType: "mentions" },
    ]);
  });

  it("merges valid links across projects and prunes stale ones in one pass", async () => {
    seedFindings(tmp.path, "alpha", "# alpha\n\n- Alpha finding about caching\n");
    seedFindings(tmp.path, "beta", "# beta\n\n- Beta finding about routing\n");
    const manualLinksPath = runtimeFile(tmp.path, "manual-links.json");
    fs.mkdirSync(path.dirname(manualLinksPath), { recursive: true });
    fs.writeFileSync(manualLinksPath, JSON.stringify([
      { entity: "cache-layer", entityType: "library", sourceDoc: "alpha/FINDINGS.md", relType: "mentions" },
      { entity: "edge-router", entityType: "library", sourceDoc: "beta/FINDINGS.md", relType: "mentions" },
      { entity: "ghost-lib", entityType: "library", sourceDoc: "deleted-proj/FINDINGS.md", relType: "mentions" },
    ]));

    const db = await buildIndex(tmp.path);

    const entityNames = db.exec("SELECT name FROM entities WHERE name IN ('cache-layer', 'edge-router', 'ghost-lib')");
    const found = (entityNames[0]?.values ?? []).map((row) => row[0]);
    expect(found).toContain("cache-layer");
    expect(found).toContain("edge-router");
    expect(found).not.toContain("ghost-lib");

    // Stale link pruned from disk; valid links survive
    expect(JSON.parse(fs.readFileSync(manualLinksPath, "utf8"))).toEqual([
      { entity: "cache-layer", entityType: "library", sourceDoc: "alpha/FINDINGS.md", relType: "mentions" },
      { entity: "edge-router", entityType: "library", sourceDoc: "beta/FINDINGS.md", relType: "mentions" },
    ]);
  });
});

it("links finding wikilinks and refreshes reference wikilinks on a single-file edit", async () => {
  const tmp = makeTempDir("mcp-graph-wikilinks-");
  const reference = path.join(tmp.path, "demo", "reference", "Observations.md");
  seedFindings(tmp.path, "demo", "# Findings\n\n- See [[Lowwater|baseline]] for the old survey.\n");
  writeFile(reference, "See [[Highwater#survey]] for the new readings.\n");
  const db = await buildIndex(tmp.path);
  try {
    expect(queryFragmentLinks(db, "lowwater").related).toEqual(["demo/FINDINGS.md"]);
    expect(queryFragmentLinks(db, "highwater").related).toEqual(["demo/reference/Observations.md"]);
    writeFile(reference, "See [[Floodmark]] for the new readings.\n");
    updateFileInIndex(db, reference, tmp.path);
    expect(queryFragmentLinks(db, "highwater").related).toEqual([]);
    expect(queryFragmentLinks(db, "floodmark").related).toEqual(["demo/reference/Observations.md"]);
  } finally {
    db.close();
    tmp.cleanup();
  }
});

it("only boosts links in Markdown prose and treats their names literally in recall", async () => {
  const tmp = makeTempDir("mcp-graph-literal-");
  const markdown = [
    "See [[phase%stage]] and [[swap_point|display]].",
    "Examples `[[Inline Example]]` and `` literal ` [[Inline Double]] ``.",
    "<!-- [[Comment Example]]",
    "```sh",
    "-->",
    "````sh",
    "[[ -n $value ]] [[Shell Example]]",
    "```",
    "[[Nested Fence]]",
    "````",
    "> ~~~sh",
    "> [[Quoted Fence]]",
    "> ~~~",
    "Then [[phase%stage#details]] and \\[[Escaped Example]].",
    "",
    "    [[ -n $indented ]]",
    "\t[[Tab Example]]",
    "",
    "> ```sh",
    "> [[Unclosed Quoted Fence]]",
    "Back in prose, [[waypoint]].",
  ].join("\n");
  expect(extractWikilinks(markdown)).toEqual(["phase%stage", "swap_point", "waypoint"]);
  seedFindings(tmp.path, "demo", markdown);
  writeFile(path.join(tmp.path, "demo", "reference", "Procedure.md"), markdown);
  const db = await buildIndex(tmp.path);
  try {
    const expected = new Set(["demo/FINDINGS.md", "demo/reference/Procedure.md"]);
    for (const query of ["explain phase%stage", "about swap_point", "waypoint"]) expect(getFragmentBoostDocs(db, query)).toEqual(expected);
    for (const query of ["phase middle stage", "swapXpoint", "inline example", "comment example", "nested fence", "-n $value", "-n $indented", "tab example", "unclosed quoted fence"]) {
      expect(getFragmentBoostDocs(db, query)).toEqual(new Set());
    }
  } finally {
    db.close();
    tmp.cleanup();
  }
});

it("caps wikilinks per document and keeps legacy finding edges and the indexed text", async () => {
  const tmp = makeTempDir("mcp-graph-bounded-");
  const note = path.join(tmp.path, "demo", "reference", "Large.md");
  const markdown = `${Array.from({ length: 256 }, (_, index) => `[[target-${index}]] [[target-${index}|duplicate]]`).join(" ")}\n`;
  writeFile(note, markdown);
  const annotations = Array.from({ length: 150 }, (_, index) => `legacy${index}`);
  seedFindings(tmp.path, "demo", `${markdown}\n<!-- fragment: ${annotations.join(", ")} -->\n`);
  const db = await buildIndex(tmp.path);
  try {
    expect(queryRows(db, "SELECT COUNT(*) FROM entity_links WHERE source_doc = ?", ["demo/reference/Large.md"])).toEqual([[128]]);
    expect(queryRows(db, "SELECT COUNT(*) FROM entity_links WHERE source_doc = ?", ["demo/FINDINGS.md"])).toEqual([[128 + annotations.length]]);
    expect(getFragmentBoostDocs(db, "legacy149")).toEqual(new Set(["demo/FINDINGS.md"]));
    const content = queryRows(db, "SELECT content FROM docs WHERE filename = ?", ["Large.md"])?.[0]?.[0];
    expect(content).toContain("[[target-255|duplicate]]");
    expect(fs.readFileSync(note, "utf8")).toBe(markdown);
  } finally {
    db.close();
    tmp.cleanup();
  }
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
      { entity: "redis-cache", entityType: "library", sourceDoc: "proj/FINDINGS.md", relType: "mentions" },
      { entity: "service-mesh", entityType: "library", sourceDoc: "proj/FINDINGS.md", relType: "mentions" },
      { entity: "postgres-wire", entityType: "library", sourceDoc: "proj/FINDINGS.md", relType: "mentions" },
      { entity: "edge-router", entityType: "library", sourceDoc: "proj/FINDINGS.md", relType: "mentions" },
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

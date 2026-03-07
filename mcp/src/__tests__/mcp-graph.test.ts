import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, writeFile } from "../test-helpers.js";
import { buildIndex } from "../shared-index.js";

function runtimeFile(cortexPath: string, name: string) {
  return path.join(cortexPath, ".runtime", name);
}

function seedFindings(cortexPath: string, project: string, content: string) {
  writeFile(path.join(cortexPath, project, "FINDINGS.md"), content);
}

describe("manual-links.json persistence", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => { tmp = makeTempDir("mcp-graph-"); });
  afterEach(() => tmp.cleanup());

  it("manual-links.json is merged into index on rebuild", async () => {
    seedFindings(tmp.path, "myapp", "# myapp\n\n- Redis needs explicit close in finally blocks\n");
    const manualLinksPath = runtimeFile(tmp.path, "manual-links.json");
    fs.mkdirSync(path.dirname(manualLinksPath), { recursive: true });
    fs.writeFileSync(manualLinksPath, JSON.stringify([
      { entity: "redis", entityType: "library", sourceDoc: "myapp/FINDINGS.md", relType: "mentions" }
    ]));

    const db = await buildIndex(tmp.path);

    const entityRows = db.exec("SELECT name FROM entities WHERE name = 'redis'");
    expect(entityRows[0]?.values?.length).toBeGreaterThan(0);

    const linkRows = db.exec("SELECT rel_type FROM entity_links JOIN entities ON entity_links.target_id = entities.id WHERE entities.name = 'redis'");
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

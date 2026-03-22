import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { buildGraph } from "./ui/data.js";
import { makeTempDir, grantAdmin, writeFile } from "./test-helpers.js";

describe("buildGraph fragment refs", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => {
    tmp = makeTempDir("phren-memory-ui-data-");
    grantAdmin(tmp.path);
    writeFile(
      path.join(tmp.path, "demo", "FINDINGS.md"),
      [
        "# demo FINDINGS",
        "",
        "## 2026-03-01",
        "",
        "- Explicit network cleanup belongs in finally blocks",
        "",
      ].join("\n"),
    );

    const manualLinksPath = path.join(tmp.path, ".runtime", "manual-links.json");
    fs.mkdirSync(path.dirname(manualLinksPath), { recursive: true });
    fs.writeFileSync(
      manualLinksPath,
      JSON.stringify([
        { entity: "service-mesh", entityType: "library", sourceDoc: "demo/FINDINGS.md", relType: "mentions" },
      ]),
    );
  });

  afterEach(() => tmp.cleanup());

  it("resolves fragment ref docs by source key", async () => {
    const graph = await buildGraph(tmp.path);
    const entityNode = graph.nodes.find((node) => node.fullLabel === "service-mesh");
    expect(entityNode).toBeDefined();
    expect(entityNode?.refDocs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ doc: "demo/FINDINGS.md", project: "demo" }),
      ]),
    );
  });
});

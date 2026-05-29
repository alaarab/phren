import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as path from "path";
import { makeTempDir, grantAdmin, writeFile } from "../test-helpers.js";
import { buildGraph } from "../ui/data.js";
import { findingNodeIdForLine, bestFindingNodeId, findingStableId } from "../finding-graph-id.js";
import { entryScoreKey } from "../governance/scores.js";
import { FINDINGS_FILENAME } from "../data/access.js";

describe("finding-graph-id stays in lockstep with the graph builder", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => {
    tmp = makeTempDir("finding-graph-id-");
    grantAdmin(tmp.path);
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("every parseable bullet maps to a node id present in the built graph", async () => {
    const findings = [
      "# demo FINDINGS",
      "",
      "## 2026-03-01",
      "",
      "- [pattern] Redis caching uses a TTL of 300 seconds for hot keys",
      "- [decision] Authentication uses JWT tokens with refresh rotation",
      "- A plain finding that is definitely longer than ten characters",
      "",
    ];
    writeFile(path.join(tmp.path, "demo", FINDINGS_FILENAME), findings.join("\n"));

    const graph = await buildGraph(tmp.path);
    const nodeIds = new Set(graph.nodes.map((n) => n.id));

    let matched = 0;
    for (const line of findings) {
      const id = findingNodeIdForLine("demo", line);
      if (!id) continue;
      matched++;
      expect(nodeIds.has(id)).toBe(true);
    }
    // Two tagged bullets + one plain bullet.
    expect(matched).toBe(3);
  });

  it("ignores headings, blanks, and too-short bullets", () => {
    expect(findingNodeIdForLine("demo", "## 2026-03-01")).toBeNull();
    expect(findingNodeIdForLine("demo", "")).toBeNull();
    expect(findingNodeIdForLine("demo", "- too short")).toBeNull();
    expect(findingNodeIdForLine("demo", "- [pattern] long enough finding text")).not.toBeNull();
  });

  it("bestFindingNodeId picks the query-relevant finding and it exists in the graph", async () => {
    const findings = [
      "# demo FINDINGS",
      "",
      "## 2026-03-01",
      "",
      "- [pattern] Redis caching uses a TTL of 300 seconds",
      "- [decision] Postgres connection pooling tuned to 20",
      "",
    ];
    writeFile(path.join(tmp.path, "demo", FINDINGS_FILENAME), findings.join("\n"));

    const graph = await buildGraph(tmp.path);
    const nodeIds = new Set(graph.nodes.map((n) => n.id));

    const id = bestFindingNodeId("demo", findings.join("\n"), "redis caching ttl");
    expect(id).toBeTruthy();
    expect(nodeIds.has(id!)).toBe(true);
    // Resolves to the Redis finding specifically, not the Postgres one.
    const expected = findingStableId(
      entryScoreKey("demo", FINDINGS_FILENAME, "[pattern] Redis caching uses a TTL of 300 seconds"),
    );
    expect(id).toBe(expected);
  });

  it("returns null when no bullet shares a query term (caller falls back to project)", () => {
    const content = "- [pattern] Redis caching uses a TTL of 300 seconds\n";
    expect(bestFindingNodeId("demo", content, "kubernetes networking")).toBeNull();
  });
});

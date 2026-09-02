/**
 * The terminal graph asks buildGraph for two extra edge flavours that the web
 * viewer never needed: fragment↔fragment co-mentions and finding→finding
 * lifecycle links. They are opt-in, so the web payload must not change.
 */

import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { grantAdmin, makeTempDir, writeFile } from "../test-helpers.js";
import { buildGraph } from "./data.js";

describe("buildGraph enrichment edges", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => {
    tmp = makeTempDir("phren-graph-edges-");
    grantAdmin(tmp.path);
    writeFile(
      path.join(tmp.path, "hub", "FINDINGS.md"),
      [
        "# hub FINDINGS",
        "",
        "## 2026-08-01",
        "",
        "- [architecture] Retries use exponential backoff with jitter for every outbound call",
        '- [architecture] Retries are capped at five attempts before surfacing the error <!-- phren:supersedes "Retries use exponential backoff with jitter for every outbound call" -->',
        '- [debugging] Retry storms were caused by the missing cap on attempts <!-- conflicts_with: "Retries use exponential backoff with jitter for every outbound call" --> <!-- phren:contradicts "Retries use exponential backoff with jitter for every outbound call" -->',
        "- [testing] Contract tests cover the billing webhook payloads end to end",
        "",
      ].join("\n"),
    );
    writeFile(
      path.join(tmp.path, "billing", "FINDINGS.md"),
      ["# billing FINDINGS", "", "## 2026-08-02", "", "- [api] Webhook retries are idempotent by invoice id", ""].join("\n"),
    );
    const manualLinks = [
      { entity: "RetryPolicy", entityType: "class", sourceDoc: "hub/FINDINGS.md", relType: "mentions" },
      { entity: "RetryPolicy", entityType: "class", sourceDoc: "billing/FINDINGS.md", relType: "mentions" },
      { entity: "WebhookClient", entityType: "class", sourceDoc: "hub/FINDINGS.md", relType: "mentions" },
      { entity: "WebhookClient", entityType: "class", sourceDoc: "billing/FINDINGS.md", relType: "mentions" },
      { entity: "InvoiceStore", entityType: "class", sourceDoc: "billing/FINDINGS.md", relType: "mentions" },
    ];
    const manualLinksPath = path.join(tmp.path, ".runtime", "manual-links.json");
    fs.mkdirSync(path.dirname(manualLinksPath), { recursive: true });
    fs.writeFileSync(manualLinksPath, JSON.stringify(manualLinks));
  });

  afterEach(() => tmp.cleanup());

  it("emits no typed edges unless asked, so the web payload is unchanged", async () => {
    const graph = await buildGraph(tmp.path);
    expect(graph.links.every((link) => link.kind === undefined)).toBe(true);
  });

  it("links findings through supersedes and contradicts annotations", async () => {
    const graph = await buildGraph(tmp.path, undefined, undefined, null, { includeLifecycleEdges: true });
    const byLabel = (prefix: string) => graph.nodes.find((node) => node.fullLabel.startsWith(prefix))!.id;
    const older = byLabel("Retries use exponential");
    const newer = byLabel("Retries are capped");
    const storm = byLabel("Retry storms");
    expect(graph.links).toContainEqual({ source: newer, target: older, kind: "supersedes" });
    expect(graph.links).toContainEqual({ source: storm, target: older, kind: "contradicts" });
    // The plain spokes are still there alongside the typed edges.
    expect(graph.links).toContainEqual({ source: "hub", target: older });
    expect(graph.links.filter((link) => link.kind === "supersedes")).toHaveLength(1);
  });

  it("links fragments that are mentioned by the same documents, strongest first", async () => {
    const graph = await buildGraph(tmp.path, undefined, undefined, null, { includeFragmentEdges: true });
    const entity = (name: string) => graph.nodes.find((node) => node.group === "entity" && node.fullLabel === name)!.id;
    const fragmentEdges = graph.links.filter((link) => link.kind === "fragment");
    const pair = (a: string, b: string) => fragmentEdges.some((link) => (link.source === a && link.target === b) || (link.source === b && link.target === a));
    expect(pair(entity("RetryPolicy"), entity("WebhookClient"))).toBe(true);
    expect(pair(entity("WebhookClient"), entity("InvoiceStore"))).toBe(true);
    expect(fragmentEdges.every((link) => link.source !== link.target)).toBe(true);
    // Entity→project spokes are untouched.
    expect(graph.links).toContainEqual({ source: entity("RetryPolicy"), target: "hub" });
  });
});

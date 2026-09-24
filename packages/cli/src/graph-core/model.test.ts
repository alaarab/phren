/**
 * The graph model is shared by the browser 3D viewer and the terminal graph
 * view. These tests pin the behaviour that was ported out of
 * browser/graph/state.ts so a change in one host cannot silently reshape the
 * other's picture.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  StoreColorAssigner,
  bestSearchMatch,
  buildFullAdjacency,
  buildVisibleData,
  connectionCounts,
  deriveKind,
  inferHealth,
  nodeDetail,
  nodeMatchesFilters,
  normalizeNode,
  recomputeSearchMatches,
  seeded,
} from "./model.js";
import type { GraphFilters, GraphModel } from "./model.js";
import type { RawLink, RawNode, RuntimeNode } from "./types.js";
import { KIND_COLORS, STORE_COLORS, TOPIC_COLORS } from "./types.js";

const DAY = 86400000;
const NOW = Date.parse("2026-09-01T00:00:00Z");

const noStoreColor = () => null;

function filters(overrides: Partial<GraphFilters> = {}): GraphFilters {
  return {
    filterTypes: { project: true, finding: true, task: true, entity: true, reference: true },
    filterTopics: {},
    filterHealth: "all",
    filterProject: "all",
    filterStore: "all",
    searchQuery: "",
    nodeLimit: 4000,
    ...overrides,
  };
}

const RAW: RawNode[] = [
  { id: "p:hub", label: "hub", group: "project", project: "hub", refCount: 3 },
  { id: "p:api", label: "api", group: "project", project: "api" },
  { id: "f:1", label: "Retry uses jitter", group: "topic:architecture", project: "hub", topicSlug: "architecture", scoreKey: "hub/1", tagged: true },
  { id: "f:2", label: "Retries capped at 5", group: "topic:debugging", project: "hub", topicSlug: "debugging" },
  { id: "t:1", label: "Ship retry docs", group: "task-active", project: "hub", section: "Active", priority: "high" },
  { id: "e:1", label: "PolicyRetry", group: "entity", entityType: "class", refCount: 14, refDocs: [{ doc: "hub/FINDINGS.md", project: "hub" }, { doc: "api/FINDINGS.md", project: "api" }] },
  { id: "r:1", label: "policies.md", group: "reference", project: "api", refDocs: [{ doc: "api/reference/retry-policy.md" }] },
];

const LINKS: RawLink[] = [
  { source: "p:hub", target: "f:1" },
  { source: "p:hub", target: "f:2" },
  { source: "p:hub", target: "t:1" },
  { source: "e:1", target: "p:hub" },
  { source: "e:1", target: "p:api" },
  { source: "p:api", target: "r:1" },
  { source: "p:hub", target: "ghost" },
];

function model(): GraphModel {
  const scores = { "hub/1": { helpful: 3, impressions: 10, lastUsedAt: new Date(NOW - 2 * DAY).toISOString() } };
  const rawNodes = RAW.map((node) => normalizeNode(node, scores, noStoreColor));
  const nodeById = new Map(rawNodes.map((node) => [node.id, node] as const));
  return {
    rawNodes,
    rawLinks: LINKS,
    nodeById,
    fullAdjacency: buildFullAdjacency(rawNodes, LINKS),
    visibleAdjacency: new Map(),
    scores,
  };
}

describe("deriveKind + normalizeNode", () => {
  it("maps every group prefix the builder emits", () => {
    const kinds = RAW.map((node) => deriveKind(node));
    expect(kinds).toEqual(["project", "project", "finding", "finding", "task", "entity", "reference"]);
    expect(deriveKind({ id: "x", label: "x", group: "mystery" })).toBe("other");
  });

  it("colours findings by topic, tasks by section, and stores by assigner", () => {
    const assigner = new StoreColorAssigner();
    const byId = new Map(RAW.map((node) => [node.id, normalizeNode(node, {}, (s) => assigner.color(s))] as const));
    expect(byId.get("f:1")!.baseColor).toBe(TOPIC_COLORS.architecture);
    expect(byId.get("t:1")!.baseColor).toBe(KIND_COLORS["task-active"]);
    expect(byId.get("p:hub")!.baseColor).toBe(KIND_COLORS.project);
    const team = normalizeNode({ id: "p:t", label: "t", group: "project", store: "team" }, {}, (s) => assigner.color(s));
    expect(team.baseColor).toBe(STORE_COLORS[1]);
    expect(assigner.color("team")).toBe(STORE_COLORS[1]);
    expect(assigner.color("primary")).toBeNull();
  });

  it("forces labels on projects and heavily-referenced entities only", () => {
    const m = model();
    expect(m.nodeById.get("p:hub")!.forceLabel).toBe(true);
    expect(m.nodeById.get("e:1")!.forceLabel).toBe(true);
    expect(m.nodeById.get("f:1")!.forceLabel).toBe(false);
  });
});

describe("inferHealth", () => {
  it("degrades on age at 60 and 150 days", () => {
    expect(inferHealth(undefined, NOW)).toBe("healthy");
    expect(inferHealth({ lastUsedAt: new Date(NOW - 59 * DAY).toISOString() }, NOW)).toBe("healthy");
    expect(inferHealth({ lastUsedAt: new Date(NOW - 61 * DAY).toISOString() }, NOW)).toBe("decaying");
    expect(inferHealth({ lastUsedAt: new Date(NOW - 151 * DAY).toISOString() }, NOW)).toBe("stale");
  });

  it("degrades on penalties at 2 and 4 (regressions count double)", () => {
    const fresh = new Date(NOW).toISOString();
    expect(inferHealth({ lastUsedAt: fresh, repromptPenalty: 2 }, NOW)).toBe("decaying");
    expect(inferHealth({ lastUsedAt: fresh, regressionPenalty: 2 }, NOW)).toBe("stale");
  });
});

describe("adjacency + detail", () => {
  it("ignores links to unknown ids and counts neighbours by kind", () => {
    const m = model();
    expect(m.fullAdjacency.get("p:hub")!.has("ghost")).toBe(false);
    expect(connectionCounts(m, "p:hub")).toEqual({ total: 4, projects: 0, findings: 2, tasks: 1, entities: 1, references: 0 });
    expect(connectionCounts(m, "e:1").projects).toBe(2);
  });

  it("assembles a detail record with quality from the score map", () => {
    const m = model();
    const detail = nodeDetail(m, "f:1")!;
    expect(detail.projectName).toBe("hub");
    expect(detail.qualityScore).toBe(1); // 0.55 + 0.3 + 0.2 clamps to 1
    expect(detail.health).toBe("healthy");
    expect(nodeDetail(m, "nope")).toBeNull();
  });
});

describe("filters + visibility", () => {
  it("scopes to a project through direct membership and refDocs", () => {
    const m = model();
    const scoped = filters({ filterProject: "api" });
    const visible = m.rawNodes.filter((node) => nodeMatchesFilters(node, scoped)).map((node) => node.id);
    expect(visible).toEqual(["p:api", "e:1", "r:1"]);
  });

  it("keeps projects and the selected node when the cap trims the list", () => {
    const m = model();
    const capped = filters({ nodeLimit: 2 });
    const visible = buildVisibleData(m, capped, "f:2");
    const ids = visible.nodes.map((node) => node.id);
    expect(ids).toContain("p:hub");
    expect(ids).toContain("p:api");
    expect(ids).toContain("f:2");
    expect(visible.links.every((link) => ids.includes(link.source) && ids.includes(link.target))).toBe(true);
    expect(visible.visibleAdjacency.get("p:hub")!.has("f:2")).toBe(true);
  });

  it("hides project nodes with no visible edges once projects are filtered out", () => {
    const m = model();
    const noProjects = filters({ filterTypes: { project: false, finding: true, task: true, entity: true, reference: true } });
    const visible = buildVisibleData(m, noProjects, null);
    expect(visible.nodes.some((node) => node.kind === "project")).toBe(false);
  });
});

describe("search", () => {
  it("ranks label prefix over label substring over deep text", () => {
    const m = model();
    const f = filters({ searchQuery: "retry" });
    const matches = recomputeSearchMatches(m.rawNodes, "retry", f, m.scores);
    const order = matches.results.map((node: RuntimeNode) => node.id);
    // "Retry uses jitter" (label prefix) beats "PolicyRetry"/"Ship retry docs" (label substring) beats a refDocs-only hit (deep).
    expect(order[0]).toBe("f:1");
    expect(order.indexOf("e:1")).toBeLessThan(order.indexOf("r:1"));
    expect(order.indexOf("t:1")).toBeLessThan(order.indexOf("r:1"));
    expect(order).not.toContain("f:2");
    expect(matches.matchIds.has("p:api")).toBe(false);
    expect(bestSearchMatch(matches.results)!.id).toBe("f:1");
    expect(bestSearchMatch([])).toBeNull();
  });

  it("returns nothing for a blank query", () => {
    const m = model();
    expect(recomputeSearchMatches(m.rawNodes, "   ", filters(), m.scores).results).toEqual([]);
  });
});

describe("determinism", () => {
  it("seeded() is stable and in [0, 1)", () => {
    expect(seeded("f:1", "x")).toBe(seeded("f:1", "x"));
    expect(seeded("f:1", "x")).not.toBe(seeded("f:1", "y"));
    expect(seeded("f:1", "x")).toBeGreaterThanOrEqual(0);
    expect(seeded("f:1", "x")).toBeLessThan(1);
  });
});

describe("module boundary", () => {
  it("graph-core never imports outside itself (it is bundled for the browser)", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const source = fs.readFileSync(path.join(dir, file), "utf8");
      const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      for (const spec of specifiers) {
        expect(spec, `${file} imports ${spec}`).toMatch(/^\.\/[a-z-]+\.js$/);
      }
    }
  });
});

describe("the node cap under a real-sized store", () => {
  /** 40 projects, 250 findings and 40 tasks each — the survey's worst case. */
  function bigStore(projects = 40, findingsEach = 250, tasksEach = 40) {
    const raw: RawNode[] = [];
    for (let p = 0; p < projects; p++) {
      const name = `proj-${p}`;
      raw.push({ id: name, label: name, group: "project", project: name });
      for (let i = 0; i < findingsEach; i++) {
        raw.push({ id: `${name}:f${i}`, label: `${name} finding ${i}`, group: "topic:architecture", project: name, topicSlug: "architecture" });
      }
      for (let i = 0; i < tasksEach; i++) {
        raw.push({ id: `${name}:t${i}`, label: `${name} task ${i}`, group: "task-active", project: name, section: "Active" });
      }
    }
    raw.push({ id: "e:shared", label: "RetryPolicy", group: "entity", refCount: 40 });
    const links: RawLink[] = [];
    for (const node of raw) {
      if (node.kind === undefined && node.group !== "project" && node.project) links.push({ source: node.project, target: node.id });
    }
    const nodes = raw.map((node) => normalizeNode(node, {}, noStoreColor));
    for (const node of nodes) {
      if (node.kind !== "project" && node.project) links.push({ source: node.project, target: node.id });
    }
    links.push({ source: "e:shared", target: "proj-0" });
    return {
      rawNodes: nodes,
      rawLinks: links.filter((l, i, all) => all.findIndex((x) => x.source === l.source && x.target === l.target) === i),
      scores: {},
    };
  }

  it("gives every project a share instead of spending the budget on a few", () => {
    const model = bigStore();
    const visible = buildVisibleData(model, filters({ nodeLimit: 350 }), null);
    const perProject = new Map<string, number>();
    for (const node of visible.nodes) {
      if (node.kind === "project" || !node.project) continue;
      perProject.set(node.project, (perProject.get(node.project) ?? 0) + 1);
    }
    // Before the quota, two projects took everything and 38 got nothing.
    expect(perProject.size).toBe(40);
    for (const [project, count] of perProject) {
      expect(count, `${project} was starved`).toBeGreaterThan(0);
    }
    expect(visible.nodes.length).toBeLessThanOrEqual(350 + 1); // +1 for a selected node
  });

  it("keeps tasks visible instead of letting findings crowd them out", () => {
    const model = bigStore();
    const visible = buildVisibleData(model, filters({ nodeLimit: 350 }), null);
    const kinds = new Set(visible.nodes.map((node) => node.kind));
    expect(kinds).toContain("finding");
    expect(kinds).toContain("task");
    expect(kinds).toContain("project");
  });

  it("keeps the selected node even when its project's quota is spent", () => {
    const model = bigStore();
    const visible = buildVisibleData(model, filters({ nodeLimit: 350 }), "proj-39:f249");
    expect(visible.nodes.map((n) => n.id)).toContain("proj-39:f249");
  });

  it("leaves a store under the limit completely untouched", () => {
    const model = bigStore(3, 5, 2);
    const visible = buildVisibleData(model, filters({ nodeLimit: 350 }), null);
    expect(visible.nodes.length).toBe(model.rawNodes.length);
  });

  it("still spends the whole budget when projects are lopsided", () => {
    const model = bigStore(4, 2, 0);
    // Give one project far more than the others.
    for (let i = 0; i < 300; i++) {
      model.rawNodes.push(normalizeNode({ id: `proj-0:extra${i}`, label: `extra ${i}`, group: "topic:api", project: "proj-0", topicSlug: "api" }, {}, noStoreColor));
      model.rawLinks.push({ source: "proj-0", target: `proj-0:extra${i}` });
    }
    const visible = buildVisibleData(model, filters({ nodeLimit: 100 }), null);
    expect(visible.nodes.length).toBeGreaterThan(90);
    expect(visible.nodes.length).toBeLessThanOrEqual(100);
  });
});

/**
 * Every line the graph view emits goes straight into the shell frame, which
 * assumes exact widths. These tests render at wide, 80×24 and 60×20 sizes
 * and check the frame contract plus what the panes say.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { GraphPayload } from "../../graph-core/types.js";
import { displayWidth, stripAnsi } from "../render.js";
import { GraphController } from "./controller.js";
import { renderGraphView, wrapText } from "./graph-view.js";

function payload(): GraphPayload {
  const nodes: GraphPayload["nodes"] = [];
  const links: GraphPayload["links"] = [];
  for (const project of ["hub", "api", "billing"]) {
    nodes.push({ id: project, label: project, group: "project", project, findingCount: 6, taskCount: 1 });
    for (let i = 0; i < 6; i++) {
      const id = `${project}:f${i}`;
      nodes.push({ id, label: `${project} finding ${i} about retries 日本語`, fullLabel: `${project} finding ${i} about retries and backoff behaviour 日本語`, group: "topic:architecture", project, topicSlug: "architecture" });
      links.push({ source: project, target: id });
    }
    nodes.push({ id: `${project}:t`, label: `${project} task`, group: "task-active", project, section: "Active" });
    links.push({ source: project, target: `${project}:t` });
  }
  nodes.push({ id: "e", label: "RetryPolicy", group: "entity", entityType: "class", refCount: 3, refDocs: [{ doc: "hub/FINDINGS.md", project: "hub" }] });
  links.push({ source: "e", target: "hub" }, { source: "e", target: "api" }, { source: "hub:f0", target: "hub:f1", kind: "supersedes" }, { source: "hub:f2", target: "hub:f3", kind: "contradicts" });
  return { nodes, links, scores: {} };
}

const controllers: GraphController[] = [];
afterEach(() => { for (const c of controllers.splice(0)) c.dispose(); });

async function ready(): Promise<GraphController> {
  const c = new GraphController("/store", "", { builder: async () => payload(), tokenOf: () => "t" });
  controllers.push(c);
  await c.ensureData();
  return c;
}

function check(lines: string[], width: number, height: number): string[] {
  expect(lines).toHaveLength(height);
  for (const line of lines) expect(displayWidth(line)).toBe(width);
  return lines.map(stripAnsi);
}

describe("renderGraphView", () => {
  it("renders exact-width frames at wide, 80×24 and 60×20 sizes, selected or not", async () => {
    const c = await ready();
    for (const [w, h] of [[140, 38], [80, 24], [60, 20]] as const) {
      check(renderGraphView(c, w, h), w, h);
      c.select("hub");
      const plain = check(renderGraphView(c, w, h), w, h);
      expect(plain.join("\n")).toContain("◆");
      expect(plain.join("\n")).toContain("hub");
      c.select(null);
    }
  });

  it("shows the overview pane when nothing is selected and details when something is", async () => {
    const c = await ready();
    const overview = renderGraphView(c, 140, 38).map(stripAnsi).join("\n");
    expect(overview).toContain("knowledge graph");
    expect(overview).toContain("filter   all");
    expect(overview).toContain("◉ billing");
    c.select("hub:f0");
    const detail = renderGraphView(c, 140, 38).map(stripAnsi).join("\n");
    expect(detail).toContain("finding");
    expect(detail).toContain("project  hub");
    expect(detail).toContain("neighbours");
    expect(detail).toMatch(/1 ◉ hub/);
  });

  it("uses a bottom strip instead of a pane on narrow terminals", async () => {
    const c = await ready();
    c.select("e");
    const plain = renderGraphView(c, 80, 24).map(stripAnsi);
    expect(plain.some((line) => line.includes("│"))).toBe(false);
    expect(plain.slice(-6).join("\n")).toContain("fragment");
    expect(plain.slice(-6).join("\n")).toMatch(/1 ◉/);
  });

  it("renders the loading, error and empty states", async () => {
    const loading = new GraphController("/store", "", { builder: () => new Promise(() => {}), tokenOf: () => "t" });
    controllers.push(loading);
    loading.setRepaintHook(() => {});
    await loading.ensureData();
    expect(check(renderGraphView(loading, 100, 10), 100, 10).join("\n")).toContain("building your knowledge graph");
    const failing = new GraphController("/store", "", { builder: async () => { throw new Error("nope"); }, tokenOf: () => "t" });
    controllers.push(failing);
    await failing.ensureData();
    expect(check(renderGraphView(failing, 100, 10), 100, 10).join("\n")).toContain("nope");
    const empty = new GraphController("/store", "", { builder: async () => ({ nodes: [], links: [] }), tokenOf: () => "t" });
    controllers.push(empty);
    await empty.ensureData();
    expect(check(renderGraphView(empty, 100, 10), 100, 10).join("\n")).toContain("nothing to draw yet");
  });
});

describe("wrapText", () => {
  it("wraps on words, respects display width and ellipsises overflow", () => {
    expect(wrapText("the quick brown fox jumps", 10, 3)).toEqual(["the quick", "brown fox", "jumps"]);
    expect(wrapText("the quick brown fox jumps over", 10, 2)).toEqual(["the quick", "brown fox…"]);
    expect(wrapText("日本語 テキスト", 6, 2)).toEqual(["日本語", "テキ…"]);
    expect(wrapText("short", 10, 2)).toEqual(["short"]);
  });
});

describe("labels on a crowded canvas", () => {
  /** Distinct, non-overlapping names so a mangled one is unmistakable. */
  const NAMES = ["searchsvc", "webstore", "mobileapp", "billing", "edgecache", "identity", "warehouse", "telemetry", "scheduler", "mailer", "payments", "ledger"];

  function crowded(): GraphPayload {
    const nodes: GraphPayload["nodes"] = [];
    const links: GraphPayload["links"] = [];
    for (const [pi, name] of NAMES.entries()) {
      nodes.push({ id: name, label: name, group: "project", project: name, findingCount: 20 - pi, taskCount: 3 });
      for (let i = 0; i < 20; i++) {
        const id = `${name}:f${i}`;
        nodes.push({ id, label: `${name} finding ${i}`, fullLabel: `${name} finding ${i} about retries`, group: "topic:architecture", project: name, topicSlug: "architecture" });
        links.push({ source: name, target: id });
      }
    }
    return { nodes, links, scores: {} };
  }

  async function render(width: number, height: number): Promise<string> {
    const c = new GraphController("/store", "", { builder: async () => crowded(), tokenOf: () => "t" });
    controllers.push(c);
    await c.ensureData();
    c.setViewport(width * 2, height * 4);
    c.fitAll();
    return renderGraphView(c, width, height).map(stripAnsi).join("\n");
  }

  it("never punches a glyph through a label", async () => {
    // The bug drew each node's glyph and label together, so a later glyph
    // landed inside an earlier label: "searchsvc" rendered as "sear◉hsvc".
    for (const [w, h] of [[80, 20], [120, 30]] as const) {
      const frame = await render(w, h);
      for (const name of NAMES) {
        const stem = name.slice(0, 4);
        if (!frame.includes(stem)) continue; // this project went unlabelled, which is allowed
        expect(frame, `${name} appears mangled at ${w}x${h}`).toContain(name);
      }
    }
  });

  it("keeps a clear cell between neighbouring labels", async () => {
    const frame = await render(120, 30);
    for (const a of NAMES) {
      for (const b of NAMES) {
        expect(frame).not.toContain(`${a}${b}`);
      }
    }
  });

  it("labels only as many projects as the canvas can carry", async () => {
    const tight = await render(60, 16);
    const roomy = await render(200, 46);
    const named = (frame: string) => NAMES.filter((n) => frame.includes(n)).length;
    expect(named(tight)).toBeLessThan(NAMES.length);
    expect(named(tight)).toBeGreaterThan(0);
    // A bigger canvas earns more names, and the busiest projects are the ones kept.
    expect(named(roomy)).toBeGreaterThanOrEqual(named(tight));
    expect(tight).toContain(NAMES[0]);
  });
});

/**
 * The dossier's Previous/Next walk. The ranked order is the order the Memory
 * list shows a project's rows (findings newest date first, then tasks), and
 * the step wraps at both ends, so these tests pin the behaviour every host
 * (web dossier, phone webview, keyboard arrows) relies on.
 */

import { describe, expect, it } from "vitest";
import { rankedProjectIds, stepRanked } from "./model.js";
import type { RawNode } from "./types.js";

const PROJECT = "ledger";

function finding(id: string, project: string, date?: string): RawNode {
  return { id, label: id, group: "topic:general", project, date, tagged: true };
}

function task(id: string, project: string, section = "Active"): RawNode {
  return { id, label: id, group: section === "Active" ? "task-active" : "task-queue", project, section };
}

function project(id: string): RawNode {
  return { id, label: id, group: "project", project: id };
}

describe("stepRanked", () => {
  const ranked = ["f:1", "f:2", "f:3"];

  it("steps forward and backward in ranked order", () => {
    expect(stepRanked(ranked, "f:1", 1)).toBe("f:2");
    expect(stepRanked(ranked, "f:3", -1)).toBe("f:2");
    expect(stepRanked(ranked, "f:2", -1)).toBe("f:1");
  });

  it("wraps at both ends", () => {
    expect(stepRanked(ranked, "f:3", 1)).toBe("f:1");
    expect(stepRanked(ranked, "f:1", -1)).toBe("f:3");
  });

  it("returns null for an empty list or an id that is not ranked", () => {
    expect(stepRanked([], "f:1", 1)).toBeNull();
    expect(stepRanked(ranked, "missing", 1)).toBeNull();
    expect(stepRanked(ranked, "missing", -1)).toBeNull();
  });

  it("holds a single-entry list steady (wrap to itself)", () => {
    expect(stepRanked(["f:1"], "f:1", 1)).toBe("f:1");
    expect(stepRanked(["f:1"], "f:1", -1)).toBe("f:1");
  });
});

describe("rankedProjectIds", () => {
  it("orders a project's findings newest date first, then its tasks", () => {
    const nodes: RawNode[] = [
      project(PROJECT),
      finding("old", PROJECT, "2026-09-01"),
      finding("new", PROJECT, "2026-09-16"),
      finding("mid", PROJECT, "2026-09-10"),
      task("t:active", PROJECT, "Active"),
      task("t:queue", PROJECT, "Queue"),
      finding("other", "phren", "2026-09-20"),
      project("phren"),
    ];
    expect(rankedProjectIds(nodes, PROJECT)).toEqual(["new", "mid", "old", "t:active", "t:queue"]);
  });

  it("breaks date ties by payload order and keeps undated findings last", () => {
    const nodes: RawNode[] = [
      finding("a", PROJECT),
      finding("b", PROJECT),
      finding("dated", PROJECT, "2026-09-01"),
    ];
    expect(rankedProjectIds(nodes, PROJECT)).toEqual(["dated", "a", "b"]);
  });

  it("leaves other projects out", () => {
    const nodes: RawNode[] = [
      finding("here", PROJECT, "2026-09-01"),
      finding("there", "phren", "2026-09-02"),
    ];
    expect(rankedProjectIds(nodes, PROJECT)).toEqual(["here"]);
    expect(rankedProjectIds(nodes, "phren")).toEqual(["there"]);
  });

  it("feeds a wrap-around step across the whole ranked list", () => {
    const nodes: RawNode[] = [
      finding("first", PROJECT, "2026-09-16"),
      finding("second", PROJECT, "2026-09-16"),
      task("job", PROJECT),
    ];
    const ranked = rankedProjectIds(nodes, PROJECT);
    expect(stepRanked(ranked, "second", 1)).toBe("job");
    expect(stepRanked(ranked, "job", 1)).toBe("first");
    expect(stepRanked(ranked, "first", -1)).toBe("job");
  });
});

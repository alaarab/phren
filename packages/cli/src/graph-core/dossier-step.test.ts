/**
 * The browser renderer's dossier stepping (Previous/Next and the "n of m"
 * counter) sits on graph-core's ranked walk; state.ts imports only types and
 * graph-core, so it loads under node. It lives here because the vitest include
 * globs do not cover browser/.
 */

import { afterEach, describe, expect, it } from "vitest";
import { dossierPosition, normalizeNode, state, stepDossier } from "../../browser/graph/state.js";
import type { RawNode } from "./types.js";

const RAW: RawNode[] = [
  { id: "p:hub", label: "hub", group: "project", project: "hub" },
  { id: "tp:1", label: "Architecture", group: "topic", project: "hub", topicSlug: "architecture", refCount: 2 },
  { id: "f:1", label: "First", group: "topic:architecture", project: "hub", topicSlug: "architecture", date: "2026-09-02" },
  { id: "f:2", label: "Second", group: "topic:architecture", project: "hub", topicSlug: "architecture", date: "2026-09-01" },
  { id: "t:1", label: "Ship it", group: "task-active", project: "hub", section: "Active" },
  { id: "n:1", label: "2026-09-28", group: "note", project: "hub", date: "2026-09-28" },
  { id: "n:2", label: "2026-09-27", group: "note", project: "hub", date: "2026-09-27" },
];

afterEach(() => {
  state.rawNodes = [];
  state.nodeById = new Map();
  state.visibleNodes = [];
});

describe("dossier stepping over findings, tasks and notes", () => {
  it("walks forward and back, wrapping, with a five-row counter", () => {
    state.rawNodes = RAW.map((node) => normalizeNode(node));
    state.nodeById = new Map(state.rawNodes.map((node) => [node.id, node] as const));
    state.visibleNodes = [];

    const order = ["f:1", "f:2", "t:1", "n:1", "n:2"];
    order.forEach((id, index) => {
      expect(stepDossier(id, 1)).toBe(order[(index + 1) % order.length]);
      expect(stepDossier(id, -1)).toBe(order[(index + order.length - 1) % order.length]);
      expect(dossierPosition(id)).toEqual({ index, total: 5 });
    });

    expect(stepDossier("p:hub", 1)).toBeNull();
    expect(dossierPosition("p:hub")).toBeNull();
    expect(stepDossier("tp:1", 1)).toBeNull();
    expect(dossierPosition("tp:1")).toBeNull();
  });
});

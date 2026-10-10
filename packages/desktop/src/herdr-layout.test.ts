import { describe, expect, it } from "vitest";
// @ts-expect-error plain browser module without types
import { layoutTree } from "../ui/shell/herdr-layout.js";

const pane = (id: string, x: number, y: number, width: number, height: number) => ({ pane_id: id, rect: { x, y, width, height } });
const leaf = (ps: { pane_id: string }[]) => ({ docs: ps.map((p) => p.pane_id) });

describe("layoutTree", () => {
  it("keeps a lone pane as one tile", () => {
    expect(layoutTree([pane("p1", 0, 0, 100, 50)], leaf)).toEqual({ docs: ["p1"] });
  });

  it("splits side by side, then stacked, with Herdr's proportions", () => {
    const tree = layoutTree([pane("p1", 0, 0, 60, 50), pane("p2", 60, 0, 40, 25), pane("p3", 60, 25, 40, 25)], leaf);
    expect(tree).toEqual({ dir: "row", ratio: 0.6, a: { docs: ["p1"] }, b: { dir: "col", ratio: 0.5, a: { docs: ["p2"] }, b: { docs: ["p3"] } } });
  });

  it("falls back to tabs when no clean cut exists", () => {
    const pinwheel = [pane("a", 0, 0, 60, 20), pane("b", 60, 0, 40, 60), pane("c", 40, 60, 60, 40), pane("d", 0, 20, 40, 80), pane("e", 40, 20, 20, 40)];
    expect(layoutTree(pinwheel, leaf)).toEqual({ docs: ["a", "b", "c", "d", "e"] });
  });
});

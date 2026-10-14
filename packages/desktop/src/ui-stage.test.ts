import { describe, expect, it } from "vitest";
// @ts-expect-error git-review.js is plain ESM without type declarations
import { groupRuns, pipelineSegments } from "../ui/git-review.js";

// @ts-expect-error util.js is plain ESM without type declarations
import { stagePlan } from "../ui/changes/util.js";

describe("check ordering", () => {
  it("keeps the Hook's order in the pipeline, workflows and their runs", () => {
    const states = ["failing", "pending", "passing", "skipped", "neutral"];
    const runs = [...states].reverse().map((state) => ({ name: state, state }));
    expect(pipelineSegments(runs).map((segment: { state: string }) => segment.state)).toEqual(states);
    expect(groupRuns(runs)[0].runs.map((run: { state: string }) => run.state)).toEqual(states);
    expect(groupRuns(runs.map((run) => ({ ...run, workflow: run.state }))).map((group: { name: string }) => group.name)).toEqual(states);
  });
});


describe("staging confirmation", () => {
  const file = (path: string, extra = {}) => ({ path, status: "M", staged: false, countsComplete: true, ...extra });

  it.each([
    ["tracked text", file("app.ts"), false],
    ["tracked binary", file("logo.png", { binary: true }), false],
    ["untracked text", file("new.ts", { status: "?" }), false],
    ["directory", file("assets/", { status: "?", directory: true }), true],
    ["binary untracked file", file("logo.png", { status: "?", binary: true }), true],
    ["uncounted untracked file", file("huge.txt", { status: "?", countsComplete: false }), true],
    ["unknown untracked file", { path: "unknown", status: "?" }, true],
  ])("%s follows the Hook's gate", (_label, entry, confirm) => {
    expect(stagePlan([entry]).confirm).toBe(confirm);
  });

  it.each([100, 101, 500, 501])("enforces the confirmation and hard limits at %i paths", (count) => {
    const plan = stagePlan(Array.from({ length: count }, (_, index) => file(`file-${index}`)));
    expect(plan.confirm).toBe(count > 100);
    if (count > 500) expect(plan.error).toMatch(/at most 500 paths.*501 selected/);
    else expect(plan.error).toBe("");
  });

  it("counts distinct unstaged paths and names folders, binary and unknown files", () => {
    const plan = stagePlan([
      file("app.ts"), file("app.ts"), file("staged.png", { staged: true, status: "?", binary: true }),
      file("assets/", { directory: true, countsComplete: false, status: "?" }),
      file("new.png", { binary: true, status: "?" }), file("huge.txt", { countsComplete: false, status: "?" }),
    ]);
    expect(plan.paths).toEqual(["app.ts", "assets/", "new.png", "huge.txt"]);
    expect(plan.directories).toEqual(["assets/"]);
    expect(plan.binary).toEqual(["new.png"]);
    expect(plan.unknown).toEqual(["huge.txt"]);
    expect(stagePlan([])).toMatchObject({ paths: [], confirm: false, error: "" });
  });
});

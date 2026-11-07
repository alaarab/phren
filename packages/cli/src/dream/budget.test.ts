import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initTestPhrenRoot, makeTempDir } from "../test-helpers.js";
import { upsertCanonical } from "../content/learning.js";
import { checkPromotion, describeBudget, injectedSize, overBudget } from "./budget.js";

describe("dream injected budget", () => {
  let tmp: { path: string; cleanup: () => void };
  let store: string;
  const project = "lantern";
  const dir = () => path.join(store, project);

  const writeTruths = (lines: string[]) =>
    fs.writeFileSync(path.join(dir(), "truths.md"), `# ${project} Truths\n\n## Truths\n\n${lines.join("\n")}\n`);

  beforeEach(() => {
    tmp = makeTempDir("phren-budget-");
    store = tmp.path;
    initTestPhrenRoot(store);
    fs.mkdirSync(dir(), { recursive: true });
    fs.mkdirSync(path.join(store, ".runtime"), { recursive: true });
  });
  afterEach(() => tmp.cleanup());

  it("measures truths.md plus the knows block as the hook injects it", () => {
    expect(injectedSize(store, project).bytes).toBe(0);
    writeTruths(["- Deploys go through CI only _(added 2026-10-01)_"]);
    const knows = "k".repeat(600);
    fs.writeFileSync(path.join(dir(), "summary.md"), `# s\n\n<!-- phren:knows:start -->\n${knows}\n<!-- phren:knows:end -->\n`);
    const size = injectedSize(store, project);
    expect(size.truthsBytes).toBe(fs.statSync(path.join(dir(), "truths.md")).size);
    expect(size.truths).toEqual([expect.objectContaining({ text: "Deploys go through CI only", added: "2026-10-01" })]);
    // The hook trims the block to 520 characters (519 + an ellipsis).
    expect(size.knowsBytes).toBe(519 + Buffer.byteLength("…"));
    expect(size.bytes).toBe(size.truthsBytes + size.knowsBytes);
  });

  it("ranks demotion candidates least recently cited first and returns just enough to get under", () => {
    const pad = " — " + "detail ".repeat(20);
    writeTruths([
      `- Cited yesterday${pad} _(added 2026-01-01)_`,
      `- Old and never cited${pad} _(added 2026-02-01)_`,
      `- Newer, never cited${pad} _(added 2026-09-01)_`,
      `- Cited by a transcript${pad} _(added 2026-01-15)_`,
    ]);
    fs.writeFileSync(path.join(store, ".runtime", "lookup-events.jsonl"), JSON.stringify({
      at: "2026-11-05T10:00:00Z", query: "q", project, filename: "truths.md", type: "canonical", snippet: `Cited yesterday${pad}`, source: "search",
    }) + "\n");
    const size = injectedSize(store, project).bytes;
    const state = overBudget(store, project, (size - 50) / 1024, { citedAt: { [`Cited by a transcript${pad}`]: "2026-10-20" } });
    expect(state.over).toBe(true);
    expect(state.ranking.map((t) => t.text.split(" —")[0])).toEqual(["Old and never cited", "Newer, never cited", "Cited by a transcript", "Cited yesterday"]);
    expect(state.candidates.map((t) => t.text.split(" —")[0])).toEqual(["Old and never cited"]);
    expect(describeBudget(state)).toContain("over the");

    const under = overBudget(store, project, 100);
    expect(under).toMatchObject({ over: false, excessBytes: 0, candidates: [] });
  });

  it("refuses a promotion that would exceed the budget unless the changeset demotes enough", () => {
    upsertCanonical(store, project, "First truth that already sits in the file and takes up some room");
    const before = injectedSize(store, project).bytes;
    const text = "A new truth of moderate length promoted by the dream";
    const tight = (before + 20) / 1024;
    expect(checkPromotion(store, project, tight, text).fits).toBe(false);
    const swap = checkPromotion(store, project, tight, text, ["First truth that already sits in the file and takes up some room"]);
    expect(swap.fits).toBe(true);

    // The estimate matches what upsertCanonical actually writes.
    const roomy = checkPromotion(store, project, 64, text);
    upsertCanonical(store, project, text);
    expect(injectedSize(store, project).bytes).toBe(roomy.bytesAfter);
  });
});

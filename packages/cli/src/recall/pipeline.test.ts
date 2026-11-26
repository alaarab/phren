import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildIndex, type SqlJsDatabase } from "../shared/index.js";
import { selectSnippets } from "../shared/retrieval.js";
import { initTestPhrenRoot, makeTempDir } from "../test-helpers.js";
import { runPromptPipeline } from "./pipeline.js";

// Selection never comes back empty from a real store; one case forces it to check the reason.
vi.mock("../shared/retrieval.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/retrieval.js")>();
  return { ...actual, selectSnippets: vi.fn(actual.selectSnippets) };
});

describe("runPromptPipeline", () => {
  let tmp: { path: string; cleanup: () => void };
  let db: SqlJsDatabase;

  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(tmp.path, file)), { recursive: true });
    fs.writeFileSync(path.join(tmp.path, file), text);
  };
  const run = (prompt: string, detectedProject: string | null = null) =>
    runPromptPipeline({ prompt, phrenPath: tmp.path, db, detectedProject });

  beforeAll(async () => {
    tmp = makeTempDir("recall-pipeline-");
    initTestPhrenRoot(tmp.path);
    write("atlas/FINDINGS.md", "# atlas Findings\n\n- The ledger export retries webhook delivery three times before parking the batch.\n- Parked batches wait for an operator.\n");
    write("atlas/tasks.md", "# atlas Tasks\n\n## Queue\n\n- [ ] Polish the zorblat quintessa report\n");
    write("harbor/FINDINGS.md", "# harbor Findings\n\n- The saxophone tuner caches chart tiles for ten minutes.\n");
    for (let i = 0; i < 6; i++) write(`harbor/reference/notes-${i}.md`, `# notes ${i}\n\n- Widget ${i} settings live in the panel.\n`);
    db = await buildIndex(tmp.path);
  });
  afterAll(() => tmp?.cleanup());

  it.each([
    ["machine-prompt", '<agent-message from="worker-1">ledger webhook retries</agent-message>'],
    ["no-keywords", "?!"],
    ["no-query", "__"],
    ["no-search-results", "glimmerwick throttlebottom"],
    // Only the task matches, and the prompt is not about the work.
    ["trust-filtered", "zorblat quintessa"],
    // About the backlog, so the task survives trust, but it matches 2 of 7 keywords: too weak to rescue.
    ["ranked-empty", "backlog zorblat quintessa plimbo frabjous wuggle snarkle"],
  ])("abstains with %s", async (reason, prompt) => {
    const result = await run(prompt);
    expect(result.abstained).toBe(reason);
    expect(result.selected).toEqual([]);
  });

  it("counts trust survivors when a later stage abstains", async () => {
    const result = await run("backlog zorblat quintessa plimbo frabjous wuggle snarkle");
    expect(result.trustSurvivors).toBe(1);
    expect(result.candidates).toEqual([]);
  });

  it("abstains below the floor and names each drop's reason and matched keywords", async () => {
    // Each word lives in a different doc, so no bullet matches both.
    const result = await run("ledger saxophone");
    expect(result.abstained).toBe("below-floor");
    expect(result.candidates.map((c) => `${c.project}/${c.filename}`).sort()).toEqual(["atlas/FINDINGS.md", "harbor/FINDINGS.md"]);
    const byProject = Object.fromEntries(result.floor.map((d) => [d.project, d]));
    expect(byProject.atlas).toMatchObject({ passed: false, reason: "too-few-matches", distinct: 1, matched: ["ledger"] });
    expect(byProject.harbor).toMatchObject({ passed: false, reason: "too-few-matches", distinct: 1, matched: ["saxophone"] });
  });

  it("drops every row when the prompt has one keyword", async () => {
    const result = await run("ledger");
    expect(result.abstained).toBe("below-floor");
    expect(result.floor.length).toBeGreaterThan(0);
    expect(result.floor.every((d) => !d.passed && d.reason === "too-few-keywords" && d.matched.length === 0)).toBe(true);
  });

  it("abstains with nothing-selected when selection returns no snippet", async () => {
    vi.mocked(selectSnippets).mockReturnValueOnce({ selected: [], usedTokens: 36 });
    expect((await run("ledger webhook retries", "atlas")).abstained).toBe("nothing-selected");
  });

  it("selects the matching finding with its score, floor decision and feedback key", async () => {
    const result = await run("ledger webhook retries", "atlas");
    expect(result.abstained).toBeNull();
    expect(result.keywords).toEqual(expect.arrayContaining(["ledger", "webhook", "retries"]));
    const candidate = result.candidates.find((c) => c.project === "atlas" && c.filename === "FINDINGS.md");
    expect(candidate?.score).toEqual(expect.any(Number));
    const decision = result.floor.find((d) => d.project === "atlas" && d.filename === "FINDINGS.md");
    expect(decision).toMatchObject({ passed: true, reason: "pass" });
    expect(decision?.matched).toEqual(expect.arrayContaining(["ledger", "webhook"]));
    expect(result.selected[0]).toMatchObject({ project: "atlas", filename: "FINDINGS.md", type: "findings" });
    expect(result.selected[0].snippet).toContain("retries webhook delivery");
    expect(result.selected[0].key).toBe(result.selectedRows[0].key);
    expect(result.selected[0].key).not.toBe("");
    expect(result.usedTokens).toBeGreaterThan(0);
    expect(result.usedTokens).toBeLessThanOrEqual(result.tokenBudget);
  });
});

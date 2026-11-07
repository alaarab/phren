import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-helpers.js";
import { transcriptPath } from "../../bridge/transcripts.js";
import { overBudget } from "../budget.js";
import type { DreamFn, EvalDreamOptions } from "./contract-stub.js";
import { buildEvalFixture, CLAUDE_SESSION, CODEX_SESSION, FIDS } from "./fixture.js";
import { runDreamEval, scoreChanges } from "./index.js";

/**
 * Stands in for B's dream() until integration: the smallest collect → prompt →
 * runner → record loop over the fixture, reading only what the env points at.
 * `withTranscripts: false` models a collect that misses the transcripts.
 */
function fakeDream(withTranscripts = true): DreamFn {
  return async (project: string, opts: EvalDreamOptions) => {
    const store = process.env.PHREN_PATH!;
    const home = process.env.HOME!;
    const parts = [
      fs.readFileSync(path.join(store, project, "FINDINGS.md"), "utf8"),
      fs.readFileSync(path.join(store, project, "truths.md"), "utf8"),
    ];
    if (withTranscripts) {
      const files = [
        ...fs.readdirSync(path.join(home, ".claude", "projects"), { recursive: true, withFileTypes: true }),
        ...fs.readdirSync(path.join(home, ".codex", "sessions"), { recursive: true, withFileTypes: true }),
      ].filter((d) => d.isFile() && d.name.endsWith(".jsonl")).map((d) => path.join(d.parentPath, d.name));
      for (const file of files) {
        for (const line of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
          const row = JSON.parse(line);
          const content = row.message?.content ?? row.payload?.content;
          if (typeof content === "string") parts.push(content);
          else if (Array.isArray(content)) parts.push(...content.filter((c: { text?: string }) => typeof c.text === "string").map((c: { text: string }) => c.text));
        }
      }
    }
    const reply = await opts.runner!({ project, account: "default", model: "scripted", home: { id: "default", dir: home, configFile: "", isDefault: true } },
      { prompt: parts.join("\n\n"), cwd: store });
    const changeset = { project, runId: "run-1", startedAt: opts.now!.toISOString(), lookback: { from: "", to: "" },
      inputs: { transcripts: 2, findings: 4, truths: 36, pages: 0 }, ...JSON.parse(reply.output) };
    fs.mkdirSync(path.join(store, project, "dreams"), { recursive: true });
    fs.writeFileSync(path.join(store, project, "dreams", "run-1.json"), JSON.stringify({ changeset, outcomes: [] }));
    return { status: "proposed", runId: "run-1" };
  };
}

describe("dream eval", () => {
  let tmp: { path: string; cleanup: () => void } | undefined;
  afterEach(() => tmp?.cleanup());

  it("builds a fixture phren's own transcript readers find, with truths over budget", async () => {
    tmp = makeTempDir("phren-dream-fixture-");
    const fixture = buildEvalFixture(tmp.path);
    const saved = process.env.HOME;
    process.env.HOME = fixture.home;
    try {
      expect(await transcriptPath("claude", CLAUDE_SESSION)).toContain(fs.realpathSync(fixture.home));
      expect(await transcriptPath("codex", CODEX_SESSION)).toContain(CODEX_SESSION);
    } finally {
      process.env.HOME = saved;
    }
    const state = overBudget(fixture.store, fixture.project, fixture.budgetKB);
    expect(state.over).toBe(true);
    // Every stale truth ranks below every fresh one, so the candidates are all stale.
    expect(state.candidates.every((c) => fixture.staleTruths.includes(c.text))).toBe(true);
  });

  it("passes every check when the prompt carries the evidence, and restores the environment", async () => {
    const before = { PHREN_PATH: process.env.PHREN_PATH, HOME: process.env.HOME };
    const report = await runDreamEval({ dream: fakeDream() });
    expect(report.error).toBeUndefined();
    expect(report.score.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.score.ok).toBe(true);
    expect(report.prompts).toHaveLength(1);
    expect({ PHREN_PATH: process.env.PHREN_PATH, HOME: process.env.HOME }).toEqual(before);
    expect(fs.existsSync(report.root)).toBe(false);
  });

  it("fails the transcript-backed checks when collect misses the transcripts", async () => {
    const report = await runDreamEval({ dream: fakeDream(false) });
    const failed = report.score.checks.filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toEqual(["corrects the contradicted finding", "captures the unsaved decision"]);
  });

  it("reports a dream that throws and still restores the environment", async () => {
    const home = process.env.HOME;
    const report = await runDreamEval({ dream: async () => { throw new Error("helper unavailable"); } });
    expect(report.error).toBe("helper unavailable");
    expect(report.score.passed).toBeLessThan(report.score.total);
    expect(process.env.HOME).toBe(home);
  });

  it("marks precision failures: touching correct memory, demoting cited truths, unbacked claims", () => {
    tmp = makeTempDir("phren-dream-score-");
    const fixture = buildEvalFixture(tmp.path);
    const score = scoreChanges([
      { op: "edit", findingId: FIDS.control, newText: "Logging uses winston", evidence: [{ kind: "finding", ref: FIDS.control }] },
      { op: "demote_truth", truth: fixture.freshTruths[0], reason: "x" },
      { op: "add_finding", text: "Something unbacked", evidence: [] },
    ], fixture);
    const failed = new Set(score.checks.filter((c) => !c.ok).map((c) => c.name));
    expect(failed).toContain("leaves the correct finding alone");
    expect(failed).toContain("keeps recently cited truths");
    expect(failed).toContain("every claim carries evidence");
  });
});

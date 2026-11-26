import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { filterTrustedFindingsDetailed } from "../../content/citation.js";
import type { RecallResult } from "../types.js";
import type { RecallEvalCase } from "./cases.js";
import { buildRecallFixture } from "./fixture.js";
import { loadCases, runRecallEval } from "./index.js";
import { compareToBaseline, recallBaseline, scoreRecall } from "./score.js";

const scratch = fileURLToPath(new URL("../../../../../.scratch/", import.meta.url));
const casesFile = fileURLToPath(new URL("../../../fixtures/recall-eval/cases.jsonl", import.meta.url));

function tempDir(): string {
  fs.mkdirSync(scratch, { recursive: true });
  return fs.mkdtempSync(path.join(scratch, "recall-test-"));
}

function result(snippets: string[], usedTokens: number, totalMs: number): RecallResult {
  return {
    keywords: [], intent: "general", detectedProject: null,
    abstained: snippets.length ? null : "no-search-results",
    trustSurvivors: snippets.length, candidates: [], floor: [], selectedRows: [],
    selected: snippets.map(snippet => ({ project: "velvetquay", filename: "FINDINGS.md", type: "findings", path: "velvetquay/FINDINGS.md", key: "fixture", snippet })),
    usedTokens, tokenBudget: 550,
    stageMs: { searchMs: totalMs / 4, trustMs: totalMs / 4, rankMs: totalMs / 4, selectMs: totalMs / 4 },
  };
}

function positive(tier: "active" | "topic" | "older"): RecallEvalCase {
  return { id: `positive-${tier}`, prompt: "Where is the glyph ferry gutter?", project: "velvetquay", kind: "positive", class: "known-item", tier,
    relevant: [{ project: "velvetquay", fid: "00010000", match: "seven-cell gutter" }] };
}

const negative: RecallEvalCase = { id: "negative", prompt: "Tell me more", project: null, kind: "negative", class: "conversational", relevant: [], tier: null };

describe("recall eval", () => {
  it("anchors each relevant fid and substring to the same live finding in its declared project and tier", () => {
    const root = tempDir();
    try {
      const cases = loadCases(casesFile);
      const fixture = buildRecallFixture(root);
      expect(cases).toHaveLength(66);
      expect(cases.filter(c => c.kind === "negative")).toHaveLength(33);
      expect(fs.existsSync(path.join(root, "checkouts", "global"))).toBe(false);
      expect(fs.existsSync(path.join(fixture.phrenPath, "global", "phren.project.yaml"))).toBe(false);
      expect(cases.filter(c => c.kind === "positive" && c.project !== null && c.project !== "global" && c.relevant.some(r => r.project === "global")).length).toBeGreaterThanOrEqual(2);
      const archiveBullets: string[] = [];
      for (const project of fixture.projects) {
        for (const filename of ["mechanics.md", "mechanics.older.md"]) {
          const archive = fs.readFileSync(path.join(fixture.phrenPath, project, "reference", "topics", filename), "utf8");
          expect(archive).toContain("<!-- phren:auto-topic slug=mechanics -->");
          expect(archive).toMatch(/^## Archived \d{4}-\d{2}-\d{2}$/m);
          expect(archive).not.toMatch(/^## \d{4}-\d{2}-\d{2}$/m);
          archiveBullets.push(...archive.split("\n").filter(line => line.startsWith("- ")));
        }
      }
      const untaggedFraction = archiveBullets.filter(line => !/^- \[/.test(line)).length / archiveBullets.length;
      expect(untaggedFraction).toBeGreaterThan(0.85);
      expect(untaggedFraction).toBeLessThan(0.95);
      for (const tag of ["pitfall", "bug", "context", "decision"]) expect(archiveBullets.some(line => line.startsWith(`- [${tag}] `))).toBe(true);
      for (const c of cases) {
        if (c.project !== null) expect(fixture.projects, c.id).toContain(c.project);
        for (const relevant of c.relevant) {
          const filename = c.tier === "active" ? "FINDINGS.md" : `reference/topics/mechanics${c.tier === "older" ? ".older" : ""}.md`;
          const content = fs.readFileSync(path.join(fixture.phrenPath, relevant.project, filename), "utf8");
          const lines = content.split("\n");
          const findings = lines.filter(line => line.includes(`<!-- fid:${relevant.fid} -->`));
          expect(findings, c.id).toHaveLength(1);
          expect(findings[0], c.id).toContain(relevant.match);
          expect(findings[0], c.id).not.toMatch(/phren:status "(?:superseded|retracted)"/);
          expect(fixture.retiredTexts.some(text => findings[0].includes(text)), c.id).toBe(false);
          // The labeled expiry case stays positive so fixing trust can improve its score.
          if (c.class !== "trust-expiry") {
            expect(filterTrustedFindingsDetailed(content, { ttlDays: 120 }).content, c.id).toContain(`fid:${relevant.fid}`);
          }
        }
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects malformed, inconsistent and duplicate cases with their physical line number", () => {
    const root = tempDir();
    const file = path.join(root, "cases.jsonl");
    try {
      for (const line of ["{", JSON.stringify({ ...negative, kind: "positive" }), JSON.stringify(negative), JSON.stringify({ ...negative, class: "unknown" })]) {
        fs.writeFileSync(file, `${JSON.stringify(negative)}\n\n${line}\n`);
        expect(() => loadCases(file)).toThrow(`${file}:3:`);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("scores normalized matches, fid hits, top-three misses, abstentions and retired snippets", () => {
    const retired = "Do not validate the old seal";
    const rows = [
      { case: negative, result: result([retired], 60, 10) },
      { case: positive("active"), result: result(["The SEVEN-CELL\n  gutter prevents clipping"], 120, 20) },
      { case: positive("topic"), result: result(["A selected entry <!-- fid:00010000 -->"], 180, 30) },
      { case: positive("active"), result: result(["unrelated", "unrelated", "unrelated", "seven-cell gutter"], 240, 40) },
      { case: { ...negative, class: "off-domain" }, result: result([], 0, 50) },
      { case: positive("older"), result: result([], 0, 60) },
    ];
    const score = scoreRecall(rows, { retiredTexts: [retired] });
    expect(score).toEqual({
      cases: 6, negatives: 2, positives: 4, falseInjectionRate: 0.5,
      falseInjectionByClass: { conversational: 1, "off-domain": 0, "cross-project-lure": 0, typo: 0, envelope: 0, "other-tool": 0 },
      hitAt3: 0.5, hitAt3ByTier: { active: 0.5, topic: 1, older: 0 },
      abstainRate: 1 / 3, positiveAbstainRate: 0.25, retiredInjected: 1,
      meanUsedTokens: 150, p50StageMs: 30, p95StageMs: 60,
    });
    const baseline = recallBaseline(score);
    expect(baseline).not.toHaveProperty("p50StageMs");
    expect(baseline).not.toHaveProperty("p95StageMs");
    expect(baseline.abstainRate).toBe(0.3333);
    expect(compareToBaseline({ ...score, p95StageMs: 600 }, baseline).every(row => row.delta === 0)).toBe(true);
    expect(compareToBaseline({ ...score, hitAt3: 0.75 }, baseline).filter(row => row.delta !== 0)).toEqual([
      { metric: "hitAt3", baseline: 0.5, current: 0.75, delta: 0.25 },
    ]);
    expect(Object.values(scoreRecall([], { retiredTexts: [] })).filter(value => typeof value === "number").every(Number.isFinite)).toBe(true);
  });

  it("restores retrieval settings and removes the fixture after a runner fails", async () => {
    const root = tempDir();
    const saved = { PHREN_MIN_QUERY_RELEVANCE: process.env.PHREN_MIN_QUERY_RELEVANCE, PHREN_FEATURE_RECALL_TEST: process.env.PHREN_FEATURE_RECALL_TEST, PHREN_EMBEDDING_API_URL: process.env.PHREN_EMBEDDING_API_URL, PHREN_OLLAMA_URL: process.env.PHREN_OLLAMA_URL };
    const home = process.env.HOME;
    const phrenPath = process.env.PHREN_PATH;
    try {
      process.env.PHREN_MIN_QUERY_RELEVANCE = "0.99";
      process.env.PHREN_FEATURE_RECALL_TEST = "on";
      process.env.PHREN_EMBEDDING_API_URL = "https://unused.invalid";
      delete process.env.PHREN_OLLAMA_URL;
      await expect(runRecallEval({ root, cases: [negative], runner: async (_c, ctx) => {
        expect(process.env.PHREN_PATH).toBe(ctx.phrenPath);
        expect(process.env.PHREN_MIN_QUERY_RELEVANCE).toBeUndefined();
        expect(process.env.PHREN_FEATURE_RECALL_TEST).toBeUndefined();
        // Embeddings are off for the run, whatever the computer has configured.
        expect(process.env.PHREN_EMBEDDING_API_URL).toBe("off");
        expect(process.env.PHREN_OLLAMA_URL).toBe("off");
        expect(ctx.db.exec("SELECT COUNT(*) FROM docs")[0].values[0][0]).toBeGreaterThan(0);
        throw new Error("runner interrupted");
      } })).rejects.toThrow("runner interrupted");
      expect(process.env.PHREN_MIN_QUERY_RELEVANCE).toBe("0.99");
      expect(process.env.PHREN_FEATURE_RECALL_TEST).toBe("on");
      expect(process.env.PHREN_EMBEDDING_API_URL).toBe("https://unused.invalid");
      expect(process.env.PHREN_OLLAMA_URL).toBeUndefined();
      expect(process.env.HOME).toBe(home);
      expect(process.env.PHREN_PATH).toBe(phrenPath);
      expect(fs.existsSync(root)).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

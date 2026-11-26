import type { RecallResult } from "../types.js";
import { RECALL_NEGATIVE_CLASSES, RECALL_TIERS, type RecallEvalCase } from "./cases.js";
import { judgmentPairs, type RecallJudgments } from "./judgments.js";

export interface RecallEvalRow {
  case: RecallEvalCase;
  result: RecallResult;
}

export interface RecallScore {
  cases: number;
  negatives: number;
  positives: number;
  falseInjectionRate: number;
  falseInjectionByClass: Record<string, number>;
  hitAt3: number;
  hitAt3ByTier: Record<string, number>;
  abstainRate: number;
  positiveAbstainRate: number;
  retiredInjected: number;
  meanUsedTokens: number;
  judgedPairs: number;
  unjudgedPairs: number;
  /** Relevant plus half of partial, over judged (case, injected snippet) pairs. */
  judgedPrecision: number;
  p50StageMs: number;
  p95StageMs: number;
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
const rate = (count: number, total: number) => total ? count / total : 0;

function hit(row: RecallEvalRow): boolean {
  return row.result.selected.slice(0, 3).some(selected => {
    const snippet = normalize(selected.snippet);
    return row.case.relevant.some(relevant => snippet.includes(normalize(relevant.match)) || snippet.includes(`fid:${relevant.fid}`));
  });
}

export function scoreRecall(rows: RecallEvalRow[], fixture: { retiredTexts: string[]; judgments?: RecallJudgments }): RecallScore {
  const negatives = rows.filter(row => row.case.kind === "negative");
  const positives = rows.filter(row => row.case.kind === "positive");
  const injected = rows.filter(row => row.result.selected.length > 0);
  const falseRate = (group: RecallEvalRow[]) => rate(group.filter(row => row.result.selected.length > 0).length, group.length);
  const hitRate = (group: RecallEvalRow[]) => rate(group.filter(hit).length, group.length);
  const abstainRate = (group: RecallEvalRow[]) => rate(group.filter(row => row.result.abstained !== null).length, group.length);
  const timings = rows.map(row => Object.values(row.result.stageMs).reduce((sum, ms) => sum + ms, 0)).sort((a, b) => a - b);
  // Nearest-rank percentiles keep measured timings rather than interpolating them.
  const percentile = (p: number) => timings.length ? timings[Math.ceil(p * timings.length) - 1] : 0;
  const retired = fixture.retiredTexts.map(normalize).filter(Boolean);
  const pairs = judgmentPairs(rows);
  const judged = pairs.flatMap(pair => fixture.judgments?.get(pair.key)?.judgment ?? []);
  const relevance = judged.reduce((sum, judgment) => sum + (judgment === "relevant" ? 1 : judgment === "partial" ? 0.5 : 0), 0);
  return {
    cases: rows.length,
    negatives: negatives.length,
    positives: positives.length,
    falseInjectionRate: falseRate(negatives),
    falseInjectionByClass: Object.fromEntries(RECALL_NEGATIVE_CLASSES.map(c => [c, falseRate(negatives.filter(row => row.case.class === c))])),
    hitAt3: hitRate(positives),
    hitAt3ByTier: Object.fromEntries(RECALL_TIERS.map(tier => [tier, hitRate(positives.filter(row => row.case.tier === tier))])),
    abstainRate: abstainRate(rows),
    positiveAbstainRate: abstainRate(positives),
    retiredInjected: rows.reduce((count, row) => count + row.result.selected.filter(selected => retired.some(text => normalize(selected.snippet).includes(text))).length, 0),
    meanUsedTokens: rate(injected.reduce((sum, row) => sum + row.result.usedTokens, 0), injected.length),
    judgedPairs: judged.length,
    unjudgedPairs: pairs.length - judged.length,
    judgedPrecision: rate(relevance, judged.length),
    p50StageMs: percentile(0.5),
    p95StageMs: percentile(0.95),
  };
}

export function formatRecallScore(score: RecallScore): string {
  const line = (label: string, value: string) => `${label.padEnd(32)} ${value.padStart(12)}`;
  const percent = (value: number) => `${(100 * value).toFixed(2)}%`;
  return [
    line("Recall eval", `${score.cases} cases`),
    line("Negative / positive cases", `${score.negatives} / ${score.positives}`),
    line("False injection", percent(score.falseInjectionRate)),
    ...Object.entries(score.falseInjectionByClass).map(([key, value]) => line(`  ${key}`, percent(value))),
    line("Hit@3", percent(score.hitAt3)),
    ...Object.entries(score.hitAt3ByTier).map(([key, value]) => line(`  ${key}`, percent(value))),
    line("Abstain / positive abstain", `${percent(score.abstainRate)} / ${percent(score.positiveAbstainRate)}`),
    line("Retired snippets injected", String(score.retiredInjected)),
    line("Mean tokens when injecting", score.meanUsedTokens.toFixed(2)),
    line("Judged precision / unjudged", `${percent(score.judgedPrecision)} of ${score.judgedPairs} / ${score.unjudgedPairs}`),
    line("Total stage ms p50 / p95", `${score.p50StageMs.toFixed(2)} / ${score.p95StageMs.toFixed(2)}`),
  ].join("\n");
}

export type RecallBaseline = Omit<RecallScore, "p50StageMs" | "p95StageMs">;

export function recallBaseline(score: RecallScore): RecallBaseline {
  const { p50StageMs: _p50, p95StageMs: _p95, ...baseline } = score;
  return JSON.parse(JSON.stringify(baseline, (_key, value) => typeof value === "number" ? Number(value.toFixed(4)) : value)) as RecallBaseline;
}

export interface RecallMetricDelta {
  metric: string;
  baseline: number | null;
  current: number | null;
  delta: number | null;
}

/** Judged precision moves when judgments are added or revised, so only a drop of more than two points fails a check. */
export const PRECISION_DROP_TOLERANCE = 0.02;

export function failsCheck(row: RecallMetricDelta): boolean {
  if (row.metric === "judgedPrecision" && row.delta !== null) return row.delta < -PRECISION_DROP_TOLERANCE;
  return row.delta !== 0;
}

export function compareToBaseline(score: RecallScore, baseline: RecallBaseline): RecallMetricDelta[] {
  const flatten = (value: RecallBaseline): Record<string, number> => {
    const result: Record<string, number> = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "number") result[key] = item;
      else for (const [subkey, number] of Object.entries(item as Record<string, number>)) result[`${key}.${subkey}`] = number;
    }
    return result;
  };
  const current = flatten(recallBaseline(score));
  const previous = flatten(baseline);
  return [...new Set([...Object.keys(current), ...Object.keys(previous)])].sort().map(metric => ({
    metric,
    baseline: previous[metric] ?? null,
    current: current[metric] ?? null,
    delta: metric in previous && metric in current ? Number((current[metric] - previous[metric]).toFixed(4)) : null,
  }));
}

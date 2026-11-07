/**
 * Scores a dream's changeset against what the eval fixture calls for.
 * Recall checks (did it correct, merge, capture, demote) and precision checks
 * (did it leave correct memory alone, did every claim carry evidence).
 */

import * as fs from "fs";
import * as path from "path";
import type { DreamChange } from "./contract-stub.js";
import { FACTS, FIDS, type EvalFixture } from "./fixture.js";
import { overBudget, parseTruths } from "../budget.js";

export interface EvalCheck {
  name: string;
  kind: "recall" | "precision";
  ok: boolean;
  detail: string;
}

export interface EvalScore {
  checks: EvalCheck[];
  passed: number;
  total: number;
  ok: boolean;
  changes: number;
}

const ASSERTING_OPS = new Set(["add_finding", "supersede", "retract", "edit", "merge", "promote_truth"]);
const FINDING_TOUCHING = new Set(["supersede", "retract", "edit"]);

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Pulls the change list out of whatever the dream handed back: a changeset,
 * a `{ changeset }` wrapper (DreamResult or the dreams/<runId>.json record),
 * or a bare array.
 */
export function extractChanges(value: unknown): DreamChange[] {
  if (Array.isArray(value)) return value as DreamChange[];
  if (!value || typeof value !== "object") return [];
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.changes)) return obj.changes as DreamChange[];
  if (obj.changeset) return extractChanges(obj.changeset);
  return [];
}

/** The newest `dreams/<runId>.json` for the project, parsed, or null. */
export function readLatestDream(store: string, project: string): unknown {
  const dir = path.join(store, project, "dreams");
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "last-run.json"); } catch { return null; }
  const newest = files
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t || b.f.localeCompare(a.f))[0];
  if (!newest) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dir, newest.f), "utf8")); } catch { return null; }
}

function touches(change: DreamChange, fid: string): boolean {
  if (change.op === "merge") return change.findingIds.includes(fid);
  return "findingId" in change && change.findingId === fid;
}

/**
 * `budgetBefore` is the fixture's injected size before the dream ran; pass it
 * when the dream ran in apply mode, since truths.md has changed by then.
 */
export function scoreChanges(changes: DreamChange[], fixture: EvalFixture, budgetBefore = overBudget(fixture.store, fixture.project, fixture.budgetKB, { skipLookupLog: true })): EvalScore {
  const checks: EvalCheck[] = [];
  const add = (name: string, kind: EvalCheck["kind"], ok: boolean, detail: string) => checks.push({ name, kind, ok, detail });

  const fix = changes.find((c) => FINDING_TOUCHING.has(c.op) && touches(c, FIDS.contradicted));
  const fixText = fix && (fix.op === "supersede" || fix.op === "edit") ? fix.newText : "";
  const fixEvidence = fix && "evidence" in fix ? fix.evidence.some((e) => e.kind !== "finding") : false;
  add("corrects the contradicted finding", "recall",
    Boolean(fix) && fixEvidence && (fix?.op === "retract" || fixText.includes(FACTS.newPort)),
    fix ? `${fix.op} ${FIDS.contradicted}${fixText ? `: ${fixText}` : ""}${fixEvidence ? "" : " (no transcript/code/git evidence)"}` : `no change to ${FIDS.contradicted}`);

  const merged = changes.some((c) => c.op === "merge" && c.findingIds.includes(FIDS.dupA) && c.findingIds.includes(FIDS.dupB));
  const retired = (fid: string) => changes.some((c) => (c.op === "retract" || c.op === "supersede") && touches(c, fid));
  const folded = retired(FIDS.dupA) !== retired(FIDS.dupB);
  add("merges the duplicate findings", "recall", merged || folded,
    merged ? `merge ${FIDS.dupA} + ${FIDS.dupB}` : folded ? "one duplicate retired, the other kept" : "duplicates left as they are");

  const captured = changes.find((c) => c.op === "add_finding" && FACTS.decisionPattern.test(c.text) && FACTS.decisionTopicPattern.test(c.text));
  add("captures the unsaved decision", "recall", Boolean(captured),
    captured && captured.op === "add_finding" ? `${captured.findingType ?? "untyped"}: ${captured.text}` : "no finding about the rate limiter's advisory locks");

  const byKey = new Map(budgetBefore.ranking.map((t) => [normalize(t.text), t]));
  const demoted = [...new Set(changes.flatMap((c) => {
    if (c.op !== "demote_truth") return [];
    const hit = byKey.get(normalize(parseTruths(`- ${c.truth.replace(/^- /, "")}`)[0]?.text ?? ""));
    return hit ? [hit] : [];
  }))];
  const freed = demoted.reduce((sum, t) => sum + t.bytes, 0);
  add("brings truths under the injected budget", "recall", !budgetBefore.over || freed >= budgetBefore.excessBytes,
    `${(budgetBefore.bytes / 1024).toFixed(1)} KB of ${(budgetBefore.budgetBytes / 1024).toFixed(1)} KB; demotes free ${freed} of ${budgetBefore.excessBytes} bytes needed`);

  const fresh = new Set(fixture.freshTruths.map(normalize));
  const wrongDemotes = demoted.filter((t) => fresh.has(normalize(t.text)));
  add("keeps recently cited truths", "precision", wrongDemotes.length === 0,
    wrongDemotes.length ? `demoted: ${wrongDemotes.map((t) => t.text).join(" | ")}` : "none demoted");

  const controlHit = changes.filter((c) => c.op !== "link" && c.op !== "move_topic" && touches(c, FIDS.control));
  add("leaves the correct finding alone", "precision", controlHit.length === 0,
    controlHit.length ? controlHit.map((c) => c.op).join(", ") : `${FIDS.control} untouched`);

  const unbacked = changes.filter((c) => ASSERTING_OPS.has(c.op) && !("evidence" in c && Array.isArray(c.evidence) && c.evidence.length > 0));
  add("every claim carries evidence", "precision", unbacked.length === 0,
    unbacked.length ? `${unbacked.length} change(s) without evidence: ${unbacked.map((c) => c.op).join(", ")}` : `${changes.length} change(s) checked`);

  const passed = checks.filter((c) => c.ok).length;
  return { checks, passed, total: checks.length, ok: passed === checks.length, changes: changes.length };
}

export function formatScore(score: EvalScore): string {
  const lines = score.checks.map((c) => `${c.ok ? "PASS" : "FAIL"}  ${c.name} (${c.kind}): ${c.detail}`);
  lines.push(`${score.passed}/${score.total} checks passed, ${score.changes} change(s) proposed.`);
  return lines.join("\n");
}

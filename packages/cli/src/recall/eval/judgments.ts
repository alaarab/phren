// Relevance judgments for (case prompt, injected snippet) pairs, made once offline; the eval only looks them up.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { z } from "zod";
import type { RecallEvalRow } from "./score.js";

export const RECALL_JUDGMENT_RUBRIC = "Judge the snippet against the prompt alone, as the agent answering it would, not against the case's known item: "
  + "relevant = it answers the prompt or states something the agent would act on for it; "
  + "partial = on the prompt's subject without answering it, background or a neighbouring fact the agent might use; "
  + "irrelevant = it shares words or the project but not the subject. "
  + "The reason is one line naming what the snippet does or does not answer.";

const judgmentSchema = z.object({
  key: z.string().regex(/^[a-f0-9]{16}$/),
  judgment: z.enum(["relevant", "partial", "irrelevant"]),
  reason: z.string().trim().min(1).refine(reason => !reason.includes("\n"), "Reason must be one line"),
});

export type RecallJudgment = z.infer<typeof judgmentSchema>;
export type RecallJudgments = Map<string, RecallJudgment>;

export interface RecallJudgmentPair {
  key: string;
  case: string;
  project: string | null;
  prompt: string;
  snippet: string;
}

const flat = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** Stable across runs and reordering: comments (fid, created, citations) and dates change while the memory does not. */
export function judgmentKey(prompt: string, snippet: string): string {
  const bullet = flat(snippet.replace(/<!--[\s\S]*?-->/g, " ").replace(/\d{4}-\d{2}-\d{2}/g, " "));
  return createHash("sha256").update(`${flat(prompt)}\n${bullet}`).digest("hex").slice(0, 16);
}

/** A missing file has no judgments; a `{"rubric": ...}` header row is skipped; a later row for a key replaces an earlier one. */
export function loadJudgments(file: string): RecallJudgments {
  const judgments: RecallJudgments = new Map();
  if (!fs.existsSync(file)) return judgments;
  fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const raw = JSON.parse(line);
      if (raw && typeof raw === "object" && "rubric" in raw && !("key" in raw)) return;
      const judgment = judgmentSchema.parse(raw);
      judgments.set(judgment.key, judgment);
    } catch (error) {
      throw new Error(`${file}:${i + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return judgments;
}

/** Every (case, injected snippet) pair a run produced, in case order. */
export function judgmentPairs(rows: RecallEvalRow[]): RecallJudgmentPair[] {
  return rows.flatMap(row => row.result.selected.map(selected => ({
    key: judgmentKey(row.case.prompt, selected.snippet),
    case: row.case.id,
    project: row.case.project,
    prompt: row.case.prompt,
    snippet: selected.snippet,
  })));
}

/** Writes the rubric, then each pair without a judgment once, for a judge to answer. Returns how many pairs. */
export function writeUnjudged(file: string, rows: RecallEvalRow[], judgments: RecallJudgments): number {
  const seen = new Set<string>();
  const pairs = judgmentPairs(rows).filter(pair => !judgments.has(pair.key) && !seen.has(pair.key) && seen.add(pair.key));
  const lines = [{ rubric: RECALL_JUDGMENT_RUBRIC }, ...pairs].map(row => JSON.stringify(row));
  fs.writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
  return pairs.length;
}

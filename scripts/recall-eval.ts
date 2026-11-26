/**
 * Measure prompt-time recall against invented findings or a private snapshot.
 *
 *   mise x pnpm@12.9.1 -- pnpm exec tsx scripts/recall-eval.ts
 *   mise x pnpm@12.9.1 -- pnpm exec tsx scripts/recall-eval.ts --write-baseline
 *   mise x pnpm@12.9.1 -- pnpm exec tsx scripts/recall-eval.ts --check
 *   mise x pnpm@12.9.1 -- pnpm exec tsx scripts/recall-eval.ts --store <snapshot> --cases <jsonl> [--profile <name>] [--embeddings] [--judgments <jsonl>]
 *   mise x pnpm@12.9.1 -- pnpm exec tsx scripts/recall-eval.ts [...] --list-unjudged <jsonl>
 *
 * Private runs print aggregates only. --out and --list-unjudged write outside the repo.
 * The public run reads the committed judgments; --judgments names another cache.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { loadCases, runRecallEval, runRecallStoreEval } from "../packages/cli/src/recall/eval/index.js";
import { loadJudgments, writeUnjudged } from "../packages/cli/src/recall/eval/judgments.js";
import { compareToBaseline, failsCheck, formatRecallScore, recallBaseline, type RecallBaseline } from "../packages/cli/src/recall/eval/score.js";

const REPO = fs.realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const BASELINE = path.join(REPO, "packages/cli/fixtures/recall-eval/baseline.json");

function outsideRepo(file: string): string {
  const absolute = path.resolve(file);
  let existing = absolute;
  const missing: string[] = [];
  while (!fs.existsSync(existing)) {
    missing.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error("Cannot resolve output path");
    existing = parent;
  }
  const resolved = path.join(fs.realpathSync(existing), ...missing);
  const relative = path.relative(REPO, resolved);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("Per-case --out and --list-unjudged must be outside the repository root (including symlinks)");
  }
  return resolved;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    "write-baseline": { type: "boolean" },
    check: { type: "boolean" },
    store: { type: "string" },
    cases: { type: "string" },
    out: { type: "string" },
    profile: { type: "string" },
    embeddings: { type: "boolean" },
    judgments: { type: "string" },
    "list-unjudged": { type: "string" },
  } });
  if (values["write-baseline"] && values.check) throw new Error("Choose --write-baseline or --check");
  if (values.store && !values.cases) throw new Error("--store requires --cases");
  if ((values.store || values.cases || values.judgments) && (values["write-baseline"] || values.check)) {
    throw new Error("Baseline commands use only the public fixture and its default cases");
  }
  const out = values.out ? outsideRepo(values.out) : undefined;
  const unjudgedOut = values["list-unjudged"] ? outsideRepo(values["list-unjudged"]) : undefined;
  if (values.check && !fs.existsSync(BASELINE)) throw new Error("No recall baseline; run --write-baseline after integrating the pipeline");

  try {
    const cases = values.cases ? loadCases(values.cases) : undefined;
    const judgments = values.judgments ? loadJudgments(values.judgments) : undefined;
    const { pipelineRunner } = await import("../packages/cli/src/recall/eval/runner.js");
    const report = values.store
      ? await runRecallStoreEval({ runner: pipelineRunner, cases: cases!, judgments, phrenPath: values.store, profile: values.profile, embeddings: values.embeddings })
      : await runRecallEval({ runner: pipelineRunner, cases, judgments });
    console.log(formatRecallScore(report.score));
    if (out) fs.writeFileSync(out, report.rows.map(row => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
    if (unjudgedOut) console.log(`Listed ${writeUnjudged(unjudgedOut, report.rows, report.judgments)} unjudged pairs.`);
    if (values["write-baseline"]) {
      fs.writeFileSync(BASELINE, JSON.stringify(recallBaseline(report.score), null, 2) + "\n");
      console.log("Wrote public recall baseline.");
    }
    if (values.check) {
      const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8")) as RecallBaseline;
      const deltas = compareToBaseline(report.score, baseline).filter(row => row.delta !== 0);
      for (const row of deltas) {
        const note = failsCheck(row) ? "" : "  (within the 2-point precision tolerance)";
        console.log(`${row.metric.padEnd(44)} ${String(row.baseline).padStart(10)} -> ${String(row.current).padStart(10)}  delta ${row.delta === null ? "missing metric" : row.delta.toFixed(4)}${note}`);
      }
      if (deltas.some(failsCheck)) process.exitCode = 1;
      else console.log(deltas.length ? "Recall baseline matches within tolerance." : "Recall baseline matches.");
    }
  } catch (error) {
    if (values.store) throw new Error("Recall eval failed; private case details withheld.");
    throw error;
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

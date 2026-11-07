/**
 * The dreaming eval: build the fixture in a temp directory, run `dream()` on it
 * in propose mode, read back what it proposed and score it.
 *
 * `model: "scripted"` (the default, used by tests) answers from the prompt with
 * `scriptedRunner`. `model: "real"` runs the project's helper (`claude -p`) with
 * the owner's own environment, for `phren dream eval --real`; it costs a real
 * model call.
 *
 * The run points PHREN_PATH and HOME at the fixture so collect reads its
 * transcripts and nothing else. Both are restored afterwards; do not run the
 * eval concurrently with other work in the same process.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { helperEnv, helperFor, runHelper } from "../../bridge/helper.js";
import { overBudget } from "../budget.js";
import { defaultDream, type DreamFn, type HelperRunner } from "./dream-adapter.js";
import { buildEvalFixture, type EvalFixture } from "./fixture.js";
import { extractChanges, readLatestDream, scoreChanges, type EvalScore } from "./score.js";
import { scriptedRunner } from "./scripted-model.js";

export { buildEvalFixture, EVAL_PROJECT, EVAL_NOW, FIDS } from "./fixture.js";
export { scoreChanges, formatScore, extractChanges, readLatestDream } from "./score.js";
export { scriptedRunner, scriptedChanges, scriptedReply } from "./scripted-model.js";
export type { EvalFixture } from "./fixture.js";
export type { EvalScore, EvalCheck } from "./score.js";

export interface DreamEvalOptions {
  model?: "scripted" | "real";
  /** B's `dream`; defaults to the integrated one. */
  dream?: DreamFn;
  /** Keep the fixture directory for inspection instead of removing it. */
  keep?: boolean;
  /** Use this empty directory instead of a fresh temp one (implies keep). */
  root?: string;
}

export interface DreamEvalReport {
  model: "scripted" | "real";
  score: EvalScore;
  /** Where the fixture was built; removed unless `keep` or `root` was given. */
  root: string;
  kept: boolean;
  /** Prompts the scripted model saw (empty for a real run). */
  prompts: string[];
  error?: string;
}

const ENV_KEYS = ["PHREN_PATH", "HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "COPILOT_HOME"] as const;

function swapEnv(fixture: EvalFixture): () => void {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.PHREN_PATH = fixture.store;
  process.env.HOME = fixture.home;
  process.env.USERPROFILE = fixture.home;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  delete process.env.COPILOT_HOME;
  return () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}

/** The real helper, with the owner's environment (their Claude login) rather than the fixture's HOME. */
function realRunner(fixture: EvalFixture, ownerEnv: NodeJS.ProcessEnv): HelperRunner {
  const choice = helperFor(fixture.store, fixture.project, ownerEnv);
  return (requested, options) => runHelper({ ...requested, home: choice.home }, { ...options, env: helperEnv(choice.home, ownerEnv) });
}

export async function runDreamEval(opts: DreamEvalOptions = {}): Promise<DreamEvalReport> {
  const model = opts.model ?? "scripted";
  const dream = opts.dream ?? defaultDream;
  const root = opts.root ?? fs.mkdtempSync(path.join(os.tmpdir(), "phren-dream-eval-"));
  const kept = Boolean(opts.keep || opts.root);
  const fixture = buildEvalFixture(root);
  const before = overBudget(fixture.store, fixture.project, fixture.budgetKB, { skipLookupLog: true });
  const prompts: string[] = [];
  const ownerEnv = { ...process.env };
  const runner = model === "scripted" ? scriptedRunner(fixture, prompts) : realRunner(fixture, ownerEnv);
  const restore = swapEnv(fixture);
  let result: unknown;
  let error: string | undefined;
  try {
    result = await dream(fixture.project, { mode: "propose", force: true, now: fixture.now, runner });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    restore();
  }
  let changes = extractChanges(result);
  if (!changes.length) changes = extractChanges(readLatestDream(fixture.store, fixture.project));
  const score = scoreChanges(changes, fixture, before);
  if (!kept) fs.rmSync(root, { recursive: true, force: true });
  return { model, score, root, kept, prompts, ...(error ? { error } : {}) };
}

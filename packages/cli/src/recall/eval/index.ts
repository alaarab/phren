import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntimeProfile } from "../../runtime-profile.js";
import { buildIndex, type SqlJsDatabase } from "../../shared/index.js";
import type { RecallResult } from "../types.js";
import { recallEvalCaseSchema, type RecallEvalCase } from "./cases.js";
import { buildRankingFixture, buildRecallFixture } from "./fixture.js";
import { loadJudgments, type RecallJudgments } from "./judgments.js";
import { scoreRecall, type RecallEvalRow, type RecallScore } from "./score.js";

export type { RecallEvalCase } from "./cases.js";
export type { RecallEvalRow, RecallScore } from "./score.js";

export type RecallRunner = (c: RecallEvalCase, ctx: { phrenPath: string; db: SqlJsDatabase }) => Promise<RecallResult>;

export function loadCases(file: string): RecallEvalCase[] {
  const ids = new Set<string>();
  return fs.readFileSync(file, "utf8").split(/\r?\n/).flatMap((line, i) => {
    if (!line.trim()) return [];
    try {
      const c = recallEvalCaseSchema.parse(JSON.parse(line));
      if (ids.has(c.id)) throw new Error(`Duplicate case id: ${c.id}`);
      ids.add(c.id);
      return [c];
    } catch (error) {
      throw new Error(`${file}:${i + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

const CASES_FILE = fileURLToPath(new URL("../../../fixtures/recall-eval/cases.jsonl", import.meta.url));
const JUDGMENTS_FILE = fileURLToPath(new URL("../../../fixtures/recall-eval/judgments.jsonl", import.meta.url));
const SCRATCH = fileURLToPath(new URL("../../../../../.scratch/", import.meta.url));
const ENV_KEYS = [
  "PHREN_PATH", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "PHREN_PROFILE",
  "PHREN_MIN_QUERY_RELEVANCE", "PHREN_CONTEXT_TOKEN_BUDGET", "PHREN_CONTEXT_SNIPPET_LINES",
  "PHREN_CONTEXT_SNIPPET_CHARS", "PHREN_MAX_INJECT_TOKENS", "PHREN_MEMORY_TTL_DAYS",
  "PHREN_FEDERATION_PATHS", "PHREN_OLLAMA_URL", "PHREN_EMBEDDING_API_URL", "PHREN_LOW_VALUE_PATTERNS", "PHREN_CROSS_PROJECT_DECAY_DAYS", "PHREN_TASK_PRIORITY",
];
let running = false;
const FIXTURE_PROFILE = "recall";

function swapEnv(phrenPath: string, root: string, profile: string, embeddings: boolean): () => void {
  const keys = new Set([...ENV_KEYS, ...Object.keys(process.env).filter(key => /^PHREN_(FEATURE_|.*EMBED|OLLAMA)/.test(key))]);
  const saved = new Map([...keys].map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.PHREN_PATH = phrenPath;
  // The hook indexes with this computer's profile; without one the reserved `global` folder is never searched.
  if (profile) process.env.PHREN_PROFILE = profile;
  // The vector tier uses whatever embedding backend answers (Ollama on localhost by default), which
  // varies by computer; off unless asked, so a baseline means the same thing everywhere.
  if (!embeddings) process.env.PHREN_OLLAMA_URL = process.env.PHREN_EMBEDDING_API_URL = "off";
  // Keep implicit home-store reads and the indexer's temporary cache inside this run.
  process.env.HOME = process.env.USERPROFILE = path.join(root, "home");
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = path.join(root, "tmp");
  fs.mkdirSync(process.env.HOME, { recursive: true });
  fs.mkdirSync(process.env.TMPDIR, { recursive: true });
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

export interface RecallEvalReport {
  score: RecallScore;
  rows: RecallEvalRow[];
  /** The judgments the score read, so unjudged pairs can be listed against the same cache. */
  judgments: RecallJudgments;
}

async function runCases(runner: RecallRunner, cases: RecallEvalCase[], phrenPath: string, retiredTexts: string[], judgments: RecallJudgments, root: string, profile: string, embeddings = false): Promise<RecallEvalReport> {
  const restore = swapEnv(phrenPath, root, profile, embeddings);
  let db: SqlJsDatabase | undefined;
  try {
    db = await buildIndex(phrenPath, profile || undefined, { force: true });
    const rows: RecallEvalRow[] = [];
    for (const c of cases) rows.push({ case: c, result: await runner(c, { phrenPath, db }) });
    return { score: scoreRecall(rows, { retiredTexts, judgments }), rows, judgments };
  } finally {
    try { db?.close(); } finally { restore(); }
  }
}

export async function runRecallEval(options: { runner: RecallRunner; cases?: RecallEvalCase[]; judgments?: RecallJudgments; root?: string; keep?: boolean }): Promise<RecallEvalReport> {
  if (running) throw new Error("Recall eval changes process environment; run evaluations sequentially");
  fs.mkdirSync(SCRATCH, { recursive: true });
  const root = options.root ? path.resolve(options.root) : fs.mkdtempSync(path.join(SCRATCH, "recall-eval-"));
  // Refuse a nonempty caller directory before taking ownership of cleanup.
  if (fs.existsSync(root) && fs.readdirSync(root).length) throw new Error("Recall fixture root must be empty");
  running = true;
  try {
    const cases = options.cases ?? loadCases(CASES_FILE);
    const fixture = buildRecallFixture(path.join(root, "main"));
    const ranking = cases.filter((c) => c.fixture === "ranking");
    const rankingFixture = ranking.length ? buildRankingFixture(path.join(root, "ranking")) : null;
    const judgments = options.judgments ?? loadJudgments(JUDGMENTS_FILE);
    const main = await runCases(options.runner, cases.filter((c) => c.fixture !== "ranking"), fixture.phrenPath, fixture.retiredTexts, judgments, path.join(root, "main"), FIXTURE_PROFILE);
    const rank = rankingFixture
      ? await runCases(options.runner, ranking, rankingFixture.phrenPath, rankingFixture.retiredTexts, judgments, path.join(root, "ranking"), FIXTURE_PROFILE)
      : null;
    // One score over both stores, in the caller's case order. Keyed by the case object, so duplicate
    // ids passed directly in options.cases still produce one row per input position.
    const byCase = new Map<RecallEvalCase, RecallEvalRow>();
    for (const row of [...main.rows, ...(rank?.rows ?? [])]) byCase.set(row.case, row);
    const rows = cases.flatMap((c) => byCase.get(c) ?? []);
    const retiredTexts = [...fixture.retiredTexts, ...(rankingFixture?.retiredTexts ?? [])];
    return { score: scoreRecall(rows, { retiredTexts, judgments }), rows, judgments };
  } finally {
    running = false;
    if (!options.keep) fs.rmSync(root, { recursive: true, force: true });
  }
}

export async function runRecallStoreEval(options: { runner: RecallRunner; cases: RecallEvalCase[]; judgments?: RecallJudgments; phrenPath: string; profile?: string; embeddings?: boolean }): Promise<RecallEvalReport> {
  if (running) throw new Error("Recall eval changes process environment; run evaluations sequentially");
  if (options.cases.some((c) => c.fixture)) throw new Error("Ranking cases run only against the public fixture");
  const phrenPath = fs.realpathSync(options.phrenPath);
  if (!fs.statSync(phrenPath).isDirectory()) throw new Error("Store must be a directory");
  // Resolved before the environment swap, the way the hook resolves it on this computer.
  const profile = options.profile ?? resolveRuntimeProfile(phrenPath);
  fs.mkdirSync(SCRATCH, { recursive: true });
  const root = fs.mkdtempSync(path.join(SCRATCH, "recall-private-"));
  running = true;
  try {
    return await runCases(options.runner, options.cases, phrenPath, [], options.judgments ?? new Map(), root, profile, options.embeddings);
  } finally {
    running = false;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

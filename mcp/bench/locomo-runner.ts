#!/usr/bin/env npx tsx
/**
 * LoCoMo/LongMemEval Benchmark Runner for Cortex
 *
 * Usage:
 *   npx tsx mcp/bench/locomo-runner.ts [--sessions N] [--input path.json] [--output path.json]
 *
 * Downloads LoCoMo dataset from: https://github.com/snap-stanford/locomo
 * Run toy dataset (3 sessions) without --input for CI testing.
 */
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { addFindingToFile } from "../src/shared-content.js";
import { buildIndex, queryDocRows } from "../src/shared-index.js";
import { buildRobustFtsQuery } from "../src/utils.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface BenchmarkQuestion {
  query: string;
  expectedKeyword: string;
}

interface BenchmarkSession {
  id: string;
  findings: string[];
  questions: BenchmarkQuestion[];
}

interface QuestionResult {
  query: string;
  expectedKeyword: string;
  found_at_1: boolean;
  found_at_3: boolean;
  found_at_5: boolean;
  rank: number | null; // 1-based rank where keyword was found, or null
}

interface SessionResult {
  sessionId: string;
  questions: number;
  recall_at_1: number;
  recall_at_3: number;
  recall_at_5: number;
  mrr: number;
}

interface BenchmarkResults {
  runDate: string;
  totalSessions: number;
  totalQuestions: number;
  recall_at_1: number;
  recall_at_3: number;
  recall_at_5: number;
  mrr: number;
  sessions: SessionResult[];
}

// ── Toy Dataset ──────────────────────────────────────────────────────────────

const TOY_DATASET: BenchmarkSession[] = [
  {
    id: "toy-1",
    findings: [
      "Redis requires explicit connection.close() to avoid resource leaks",
      "PostgreSQL connection pooling defaults to 10 connections",
      "Docker containers restart policy should be set to unless-stopped for production",
    ],
    questions: [
      { query: "Redis connection cleanup", expectedKeyword: "connection.close" },
      { query: "postgres pool size default", expectedKeyword: "10 connections" },
      { query: "docker restart production", expectedKeyword: "unless-stopped" },
    ],
  },
  {
    id: "toy-2",
    findings: [
      "TypeScript strict mode catches null reference errors at compile time",
      "ESLint flat config requires eslint.config.js not .eslintrc",
      "Vitest runs 3x faster than Jest for TypeScript projects",
    ],
    questions: [
      { query: "typescript null safety", expectedKeyword: "strict mode" },
      { query: "eslint configuration file format", expectedKeyword: "eslint.config.js" },
      { query: "fast test runner typescript", expectedKeyword: "Vitest" },
    ],
  },
  {
    id: "toy-3",
    findings: [
      "npm workspaces require the root package.json to list workspace paths",
      "GitHub Actions cache key should include package-lock.json hash",
      "Node.js 20 LTS includes built-in test runner and fetch API",
    ],
    questions: [
      { query: "monorepo workspace setup npm", expectedKeyword: "workspace" },
      { query: "CI caching strategy github", expectedKeyword: "package-lock.json" },
      { query: "node 20 built-in features", expectedKeyword: "fetch" },
    ],
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTempCortex(prefix: string): { cortexPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // Grant admin access for governance checks
  const govDir = path.join(dir, ".governance");
  fs.mkdirSync(govDir, { recursive: true });
  fs.writeFileSync(
    path.join(govDir, "access-control.json"),
    JSON.stringify({
      admins: ["bench-runner"],
      maintainers: [],
      contributors: [],
      viewers: [],
    }, null, 2) + "\n"
  );
  process.env.CORTEX_ACTOR = "bench-runner";
  return {
    cortexPath: dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // temp dir cleanup can fail on Windows/WSL
      }
    },
  };
}

function parseArgs(argv: string[]): { sessions: number; input: string | null; output: string } {
  let sessions = 3;
  let input: string | null = null;
  let output = path.resolve("docs/benchmark-results.json");

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--sessions" && argv[i + 1]) {
      sessions = parseInt(argv[i + 1], 10);
      i++;
    } else if (argv[i] === "--input" && argv[i + 1]) {
      input = path.resolve(argv[i + 1]);
      i++;
    } else if (argv[i] === "--output" && argv[i + 1]) {
      output = path.resolve(argv[i + 1]);
      i++;
    }
  }
  return { sessions, input, output };
}

function checkKeywordInResults(results: Array<{ content: string }>, keyword: string): { at1: boolean; at3: boolean; at5: boolean; rank: number | null } {
  let rank: number | null = null;
  for (let i = 0; i < Math.min(results.length, 5); i++) {
    if (results[i].content.toLowerCase().includes(keyword.toLowerCase())) {
      rank = i + 1;
      break;
    }
  }
  return {
    at1: rank !== null && rank <= 1,
    at3: rank !== null && rank <= 3,
    at5: rank !== null && rank <= 5,
    rank,
  };
}

// ── Core Benchmark ───────────────────────────────────────────────────────────

async function runSession(session: BenchmarkSession): Promise<SessionResult> {
  const { cortexPath, cleanup } = makeTempCortex(`cortex-bench-${session.id}-`);
  const project = "bench";

  try {
    // Create project directory
    const projectDir = path.join(cortexPath, project);
    fs.mkdirSync(projectDir, { recursive: true });

    // Ingest findings
    for (const finding of session.findings) {
      addFindingToFile(cortexPath, project, finding);
    }

    // Build FTS index
    const db = await buildIndex(cortexPath);

    // Run queries
    const questionResults: QuestionResult[] = [];

    for (const q of session.questions) {
      const ftsQuery = buildRobustFtsQuery(q.query);
      if (!ftsQuery) {
        questionResults.push({
          query: q.query,
          expectedKeyword: q.expectedKeyword,
          found_at_1: false,
          found_at_3: false,
          found_at_5: false,
          rank: null,
        });
        continue;
      }

      const rows = queryDocRows(
        db,
        "SELECT project, filename, type, content, path FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT 5",
        [ftsQuery]
      );

      if (!rows || rows.length === 0) {
        questionResults.push({
          query: q.query,
          expectedKeyword: q.expectedKeyword,
          found_at_1: false,
          found_at_3: false,
          found_at_5: false,
          rank: null,
        });
        continue;
      }

      const hit = checkKeywordInResults(rows, q.expectedKeyword);
      questionResults.push({
        query: q.query,
        expectedKeyword: q.expectedKeyword,
        found_at_1: hit.at1,
        found_at_3: hit.at3,
        found_at_5: hit.at5,
        rank: hit.rank,
      });
    }

    db.close();

    // Calculate metrics
    const total = questionResults.length;
    const recall1 = questionResults.filter(r => r.found_at_1).length / total;
    const recall3 = questionResults.filter(r => r.found_at_3).length / total;
    const recall5 = questionResults.filter(r => r.found_at_5).length / total;
    const mrr = questionResults.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / total;

    return {
      sessionId: session.id,
      questions: total,
      recall_at_1: Math.round(recall1 * 1000) / 1000,
      recall_at_3: Math.round(recall3 * 1000) / 1000,
      recall_at_5: Math.round(recall5 * 1000) / 1000,
      mrr: Math.round(mrr * 1000) / 1000,
    };
  } finally {
    cleanup();
  }
}

async function runBenchmark(sessions: BenchmarkSession[]): Promise<BenchmarkResults> {
  const sessionResults: SessionResult[] = [];

  for (const session of sessions) {
    process.stdout.write(`  Running session ${session.id}...`);
    const result = await runSession(session);
    console.log(` recall@1=${result.recall_at_1} recall@3=${result.recall_at_3} recall@5=${result.recall_at_5} MRR=${result.mrr}`);
    sessionResults.push(result);
  }

  const totalQuestions = sessionResults.reduce((s, r) => s + r.questions, 0);
  const avgRecall1 = sessionResults.reduce((s, r) => s + r.recall_at_1, 0) / sessionResults.length;
  const avgRecall3 = sessionResults.reduce((s, r) => s + r.recall_at_3, 0) / sessionResults.length;
  const avgRecall5 = sessionResults.reduce((s, r) => s + r.recall_at_5, 0) / sessionResults.length;
  const avgMrr = sessionResults.reduce((s, r) => s + r.mrr, 0) / sessionResults.length;

  return {
    runDate: new Date().toISOString(),
    totalSessions: sessionResults.length,
    totalQuestions,
    recall_at_1: Math.round(avgRecall1 * 1000) / 1000,
    recall_at_3: Math.round(avgRecall3 * 1000) / 1000,
    recall_at_5: Math.round(avgRecall5 * 1000) / 1000,
    mrr: Math.round(avgMrr * 1000) / 1000,
    sessions: sessionResults,
  };
}

function printSummary(results: BenchmarkResults): void {
  console.log("\n## LoCoMo Benchmark Results\n");
  console.log(`Run date: ${results.runDate}`);
  console.log(`Sessions: ${results.totalSessions}  |  Questions: ${results.totalQuestions}\n`);

  console.log("| Session | Questions | recall@1 | recall@3 | recall@5 | MRR   |");
  console.log("|---------|-----------|----------|----------|----------|-------|");

  for (const s of results.sessions) {
    console.log(`| ${s.sessionId.padEnd(7)} | ${String(s.questions).padEnd(9)} | ${s.recall_at_1.toFixed(3).padEnd(8)} | ${s.recall_at_3.toFixed(3).padEnd(8)} | ${s.recall_at_5.toFixed(3).padEnd(8)} | ${s.mrr.toFixed(3)} |`);
  }

  console.log("|---------|-----------|----------|----------|----------|-------|");
  console.log(`| **AVG** |           | ${results.recall_at_1.toFixed(3).padEnd(8)} | ${results.recall_at_3.toFixed(3).padEnd(8)} | ${results.recall_at_5.toFixed(3).padEnd(8)} | ${results.mrr.toFixed(3)} |`);
  console.log();
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { sessions: maxSessions, input, output } = parseArgs(process.argv);

  let dataset: BenchmarkSession[];

  if (input) {
    const raw = fs.readFileSync(input, "utf8");
    const parsed = JSON.parse(raw) as BenchmarkSession[];
    dataset = parsed.slice(0, maxSessions);
    console.log(`Loaded ${dataset.length} sessions from ${input}`);
  } else {
    dataset = TOY_DATASET.slice(0, maxSessions);
    console.log(`Running toy dataset (${dataset.length} sessions)`);
  }

  const results = await runBenchmark(dataset);
  printSummary(results);

  // Write results
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(results, null, 2) + "\n");
  console.log(`Results written to ${output}`);
}

main().catch(err => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});

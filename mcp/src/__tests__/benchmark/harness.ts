/**
 * Benchmark harness for cortex retrieval quality.
 *
 * Tests 5 query types (temporal, factual, procedural, relational, contradictory)
 * with 20 test cases. Scores top-3 results for expected keyword presence.
 *
 * Usage:
 *   npx tsx mcp/src/__tests__/benchmark/harness.ts [cortex-path]
 */
import { buildIndex, queryRows } from "../../shared-index.js";
import { findCortexPath } from "../../shared.js";
import { buildRobustFtsQuery } from "../../utils.js";

export interface BenchmarkCase {
  id: number;
  type: "temporal" | "factual" | "procedural" | "relational" | "contradictory";
  query: string;
  expectedKeywords: string[];
}

export const BENCHMARK_CASES: BenchmarkCase[] = [
  // Temporal queries (1-4)
  { id: 1, type: "temporal", query: "recent changes to authentication", expectedKeywords: ["auth", "login", "session", "token"] },
  { id: 2, type: "temporal", query: "latest database migration", expectedKeywords: ["migration", "database", "schema", "alter"] },
  { id: 3, type: "temporal", query: "what was fixed this week", expectedKeywords: ["fix", "bug", "patch", "resolve"] },
  { id: 4, type: "temporal", query: "performance improvements over time", expectedKeywords: ["performance", "speed", "optimize", "cache"] },

  // Factual queries (5-8)
  { id: 5, type: "factual", query: "which framework does the frontend use", expectedKeywords: ["react", "vue", "angular", "frontend", "framework"] },
  { id: 6, type: "factual", query: "database connection configuration", expectedKeywords: ["database", "connection", "config", "postgres", "mysql", "mongo"] },
  { id: 7, type: "factual", query: "environment variables required", expectedKeywords: ["env", "variable", "config", "secret", "key"] },
  { id: 8, type: "factual", query: "project build command", expectedKeywords: ["build", "npm", "script", "compile", "webpack", "vite"] },

  // Procedural queries (9-12)
  { id: 9, type: "procedural", query: "how to deploy to production", expectedKeywords: ["deploy", "production", "release", "publish"] },
  { id: 10, type: "procedural", query: "steps to add a new API endpoint", expectedKeywords: ["api", "endpoint", "route", "handler", "controller"] },
  { id: 11, type: "procedural", query: "how to run tests", expectedKeywords: ["test", "jest", "vitest", "npm", "run"] },
  { id: 12, type: "procedural", query: "setting up development environment", expectedKeywords: ["setup", "install", "dev", "environment", "local"] },

  // Relational queries (13-16)
  { id: 13, type: "relational", query: "dependencies between projects", expectedKeywords: ["depend", "import", "require", "shared", "module"] },
  { id: 14, type: "relational", query: "how frontend connects to backend API", expectedKeywords: ["api", "fetch", "request", "endpoint", "client"] },
  { id: 15, type: "relational", query: "shared libraries across projects", expectedKeywords: ["shared", "common", "library", "package", "util"] },
  { id: 16, type: "relational", query: "which components use the auth system", expectedKeywords: ["auth", "component", "middleware", "guard", "permission"] },

  // Contradictory queries (17-20)
  { id: 17, type: "contradictory", query: "REST vs GraphQL decision", expectedKeywords: ["rest", "graphql", "api", "decision", "tradeoff"] },
  { id: 18, type: "contradictory", query: "testing framework migration", expectedKeywords: ["test", "migrate", "jest", "vitest", "framework"] },
  { id: 19, type: "contradictory", query: "cache duration settings", expectedKeywords: ["cache", "ttl", "duration", "expire", "timeout"] },
  { id: 20, type: "contradictory", query: "code style conventions changes", expectedKeywords: ["style", "convention", "lint", "format", "prettier", "eslint"] },
];

export interface BenchmarkResult {
  caseId: number;
  type: string;
  query: string;
  score: number;
  topResults: string[];
}

function scoreResult(content: string, expectedKeywords: string[]): number {
  const lower = content.toLowerCase();
  const matched = expectedKeywords.filter(kw => lower.includes(kw.toLowerCase()));
  if (matched.length >= 2) return 2; // exact match
  if (matched.length === 1) return 1; // partial match
  return 0; // no match
}

export async function runBenchmark(cortexPath?: string): Promise<BenchmarkResult[]> {
  const resolvedPath = cortexPath || findCortexPath();
  if (!resolvedPath) {
    console.error("Could not find cortex path. Pass it as an argument or set CORTEX_PATH.");
    return [];
  }

  const db = await buildIndex(resolvedPath);
  const results: BenchmarkResult[] = [];

  for (const tc of BENCHMARK_CASES) {
    const safeQuery = buildRobustFtsQuery(tc.query);
    if (!safeQuery) {
      results.push({ caseId: tc.id, type: tc.type, query: tc.query, score: 0, topResults: [] });
      continue;
    }

    const rows = queryRows(
      db,
      "SELECT project, filename, type, content, path FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT 3",
      [safeQuery]
    );

    if (!rows || rows.length === 0) {
      results.push({ caseId: tc.id, type: tc.type, query: tc.query, score: 0, topResults: [] });
      continue;
    }

    const topResults = rows.map((r: any[]) => `${r[0]}/${r[1]}`);
    const combinedContent = rows.map((r: any[]) => String(r[3])).join("\n");
    const score = scoreResult(combinedContent, tc.expectedKeywords);

    results.push({ caseId: tc.id, type: tc.type, query: tc.query, score, topResults });
  }

  return results;
}

function printResultsTable(results: BenchmarkResult[]): void {
  console.log("\n## Benchmark Results\n");
  console.log("| # | Type | Query | Score | Top Results |");
  console.log("|---|------|-------|-------|-------------|");

  let totalScore = 0;
  const maxScore = results.length * 2;

  for (const r of results) {
    totalScore += r.score;
    const scoreLabel = r.score === 2 ? "exact" : r.score === 1 ? "partial" : "miss";
    console.log(`| ${r.caseId} | ${r.type} | ${r.query} | ${r.score} (${scoreLabel}) | ${r.topResults.join(", ") || "none"} |`);
  }

  console.log(`\n**Total: ${totalScore}/${maxScore} (${Math.round((totalScore / maxScore) * 100)}%)**\n`);
}

// Main runner
if (process.argv[1]?.includes("harness")) {
  const cortexPath = process.argv[2];
  runBenchmark(cortexPath).then(results => {
    if (results.length > 0) {
      printResultsTable(results);
    }
  });
}

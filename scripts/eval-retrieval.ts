#!/usr/bin/env tsx
/**
 * cortex retrieval evaluation script
 *
 * Evaluates FTS5 + cosine fallback retrieval quality.
 *
 * Usage:
 *   npx tsx scripts/eval-retrieval.ts
 *   npx tsx scripts/eval-retrieval.ts --cortex-path ~/.cortex --project myproject
 *
 * Results are printed as a table and saved to .runtime/eval-{date}.json
 */

import * as path from "path";
import * as fs from "fs";
import * as os from "os";

// Parse args
const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const cortexPathArg = getArg("--cortex-path", path.join(os.homedir(), ".cortex"));
const projectArg = getArg("--project", "");

// Must import from built output
const srcDir = path.join(__dirname, "../mcp/src");
// Try dist first, then src with tsx
async function main() {
  // Dynamic import to avoid top-level issues
  const { buildIndex } = await import("../mcp/src/shared-index.js");
  const { runtimeFile } = await import("../mcp/src/shared.js");

  const cortexPath = cortexPathArg;

  if (!fs.existsSync(cortexPath)) {
    console.error(`cortex directory not found: ${cortexPath}`);
    console.error("Set --cortex-path to your cortex directory");
    process.exit(1);
  }

  console.log(`\ncortex retrieval evaluation`);
  console.log(`cortex path: ${cortexPath}`);
  console.log(`project filter: ${projectArg || "(all)"}`);
  console.log(`building index...\n`);

  const t0 = Date.now();
  const db = await buildIndex(cortexPath, undefined);
  console.log(`index ready in ${Date.now() - t0}ms\n`);

  const TEST_QUERIES = [
    "authentication login session token",
    "database query performance index",
    "error handling exception retry",
    "deployment docker kubernetes",
    "caching redis memory ttl",
    "api rate limit timeout",
    "security xss injection sanitize",
    "testing mock stub coverage",
    "typescript type error null undefined",
    "git merge conflict branch rebase",
  ];

  const results: Array<{
    query: string;
    count: number;
    topResult: string;
    latencyMs: number;
  }> = [];

  const COL_QUERY = 36;
  const COL_COUNT = 7;
  const COL_PREVIEW = 50;
  const COL_MS = 8;

  const header =
    "Query".padEnd(COL_QUERY) +
    "Results".padEnd(COL_COUNT) +
    "Top Result Preview".padEnd(COL_PREVIEW) +
    "ms".padEnd(COL_MS);
  console.log(header);
  console.log("-".repeat(header.length));

  for (const query of TEST_QUERIES) {
    const qStart = Date.now();

    // Build FTS5 query
    const terms = query.split(" ").filter(Boolean);
    const ftsQuery = terms.map(t => `"${t.replace(/"/g, "")}"`).join(" OR ");

    let rows: unknown[][] = [];
    try {
      const projectFilter = projectArg ? ` AND project = '${projectArg.replace(/'/g, "''")}'` : "";
      const sql = `SELECT project, filename, type, content, path FROM docs WHERE docs MATCH ?${projectFilter} ORDER BY rank LIMIT 10`;
      const res = db.exec(sql, [ftsQuery]);
      if (res?.length && res[0]?.values?.length) {
        rows = res[0].values;
      }
    } catch {
      // FTS5 error — query might have special chars
    }

    const latencyMs = Date.now() - qStart;
    const count = rows.length;

    let topPreview = "(no results)";
    if (rows.length > 0) {
      const content = String(rows[0][3] ?? "");
      const firstLine = content.split("\n").find(l => l.trim().startsWith("- ")) ?? content.slice(0, 80);
      topPreview = firstLine.replace(/^-\s+/, "").slice(0, COL_PREVIEW - 3);
      if (topPreview.length === COL_PREVIEW - 3) topPreview += "...";
    }

    results.push({ query, count, topResult: topPreview, latencyMs });

    const row =
      query.slice(0, COL_QUERY - 1).padEnd(COL_QUERY) +
      String(count).padEnd(COL_COUNT) +
      topPreview.padEnd(COL_PREVIEW) +
      String(latencyMs).padEnd(COL_MS);
    console.log(row);
  }

  console.log("-".repeat(header.length));

  const totalResults = results.reduce((s, r) => s + r.count, 0);
  const avgResults = (totalResults / results.length).toFixed(1);
  const avgLatency = (results.reduce((s, r) => s + r.latencyMs, 0) / results.length).toFixed(1);
  const p95Latency = results.map(r => r.latencyMs).sort((a, b) => a - b)[Math.floor(results.length * 0.95)];
  const zeroResults = results.filter(r => r.count === 0).length;

  console.log(`\nSummary:`);
  console.log(`  Queries run:        ${results.length}`);
  console.log(`  Avg results/query:  ${avgResults}`);
  console.log(`  Zero-result queries: ${zeroResults}`);
  console.log(`  Avg latency:        ${avgLatency}ms`);
  console.log(`  P95 latency:        ${p95Latency}ms`);

  // Save results
  const date = new Date().toISOString().slice(0, 10);
  const outPath = runtimeFile(cortexPath, `eval-${date}.json`);
  const output = {
    date,
    cortexPath,
    project: projectArg || null,
    conditions: {
      machine: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      projectFilter: projectArg || null,
      embeddingsEnabled: Boolean(process.env.CORTEX_EMBEDDING_API_URL || process.env.OLLAMA_HOST || process.env.OLLAMA_BASE_URL),
      cacheState: "cold index build at script start; warm within this single run",
      indexMode: "FTS5 query against built index",
    },
    summary: { totalQueries: results.length, avgResults: parseFloat(avgResults), avgLatencyMs: parseFloat(avgLatency), p95LatencyMs: p95Latency, zeroResultQueries: zeroResults },
    queries: results,
  };
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nResults saved to: ${outPath}`);
}

main().catch(e => {
  console.error("Error:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});

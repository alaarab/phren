#!/usr/bin/env tsx

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { performance } from "perf_hooks";

import { buildIndex, type DocRow } from "../mcp/src/shared-index.js";
import { searchDocuments, searchDocumentsAsync, rankResults, selectSnippets } from "../mcp/src/cli-hooks-retrieval.js";
import { buildRobustFtsQuery, extractKeywords } from "../mcp/src/utils.js";
import { getEmbeddingCache } from "../mcp/src/shared-embedding-cache.js";
import { embedText, getEmbeddingModel, cosineSimilarity } from "../mcp/src/shared-ollama.js";
import { getPersistentVectorIndex } from "../mcp/src/shared-vector-index.js";

const DEFAULT_QUERIES = [
  "duplicate uppercase project directories",
  "live refresh task review ui while agents write",
  "semantic search setup during init with ollama",
  "background sync push conflicts",
  "cursor install detection false positive",
  "shareable filters in project table url",
  "tectonic shell escape latex incompatibility",
  "unauthenticated report download by filename",
  "alerts to external webhook instead of discord",
  "timesheet approval status updates service object",
  "project naming lowercase enforcement",
  "semantic search warm cold coverage in doctor status",
  "manual consolidation instead of forced cap",
  "sync state across status shell and review ui",
  "background hook push in detached worker",
  "skill deletion bug in cortex project",
];

const DEFAULT_TOKEN_BUDGET = 550;
const DEFAULT_LINE_BUDGET = 6;
const DEFAULT_CHAR_BUDGET = 520;
const VECTOR_MICROBENCH_ITERATIONS = 200;

function parseArgs(argv: string[]): { cortexPath: string; project?: string; outputPath?: string; queries: string[] } {
  const args = argv.slice(2);
  const getArg = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const cortexPath = getArg("--cortex-path") || path.join(os.homedir(), ".cortex");
  const project = getArg("--project");
  const outputPath = getArg("--output");
  const queryFile = getArg("--queries");
  let queries = DEFAULT_QUERIES;
  if (queryFile) {
    const raw = fs.readFileSync(queryFile, "utf8");
    queries = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  }
  return { cortexPath, project, outputPath, queries };
}

function summarize(values: number[]): { avg: number; p50: number; p95: number; min: number; max: number } {
  if (values.length === 0) return { avg: 0, p50: 0, p95: 0, min: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (pct: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * pct))] ?? 0;
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    avg: Number(avg.toFixed(2)),
    p50: Number(pick(0.5).toFixed(2)),
    p95: Number(pick(0.95).toFixed(2)),
    min: Number(sorted[0].toFixed(2)),
    max: Number(sorted[sorted.length - 1].toFixed(2)),
  };
}

function describeTopDoc(rows: DocRow[] | null): string | null {
  const top = rows?.[0];
  return top ? `${top.project}/${top.filename}` : null;
}

async function runMode(
  mode: "lexical" | "hybrid_gated",
  cortexPath: string,
  db: Awaited<ReturnType<typeof buildIndex>>,
  query: string,
  project?: string,
): Promise<{
  mode: string;
  query: string;
  searchMs: number;
  totalMs: number;
  resultCount: number;
  selectedCount: number;
  usedTokens: number;
  topDoc: string | null;
}> {
  const safeQuery = buildRobustFtsQuery(query);
  const keywords = extractKeywords(query);
  const searchStart = performance.now();
  const rows = safeQuery
    ? mode === "lexical"
      ? searchDocuments(db, safeQuery, query, keywords, project ?? null, !project)
      : await searchDocumentsAsync(db, safeQuery, query, keywords, project ?? null, !project, cortexPath)
    : null;
  const searchMs = performance.now() - searchStart;

  const ranked = rankResults(
    rows ?? [],
    "general",
    null,
    project ?? null,
    cortexPath,
    db,
    undefined,
    query,
  );
  const { selected, usedTokens } = selectSnippets(
    ranked,
    keywords || query,
    DEFAULT_TOKEN_BUDGET,
    DEFAULT_LINE_BUDGET,
    DEFAULT_CHAR_BUDGET,
  );
  const totalMs = performance.now() - searchStart;
  return {
    mode,
    query,
    searchMs: Number(searchMs.toFixed(2)),
    totalMs: Number(totalMs.toFixed(2)),
    resultCount: ranked.length,
    selectedCount: selected.length,
    usedTokens,
    topDoc: describeTopDoc(ranked),
  };
}

function summarizeModeRuns(
  runs: Array<{
    query: string;
    totalMs: number;
    searchMs: number;
    usedTokens: number;
    resultCount: number;
    selectedCount: number;
    topDoc: string | null;
  }>
) {
  const hitRuns = runs.filter((run) => run.resultCount > 0);
  const missQueries = runs.filter((run) => run.resultCount === 0).map((run) => run.query);
  return {
    totalMs: summarize(runs.map((run) => run.totalMs)),
    searchMs: summarize(runs.map((run) => run.searchMs)),
    usedTokens: summarize(runs.map((run) => run.usedTokens)),
    hits: hitRuns.length,
    misses: missQueries.length,
    missQueries,
    topDocs: runs.map(({ query, topDoc }) => ({ query, topDoc })),
  };
}

async function runVectorMicrobench(
  cortexPath: string,
  queries: string[],
  project?: string,
): Promise<{
  model: string;
  eligibleDocs: number;
  avgCandidates: number;
  fullScanAvgMs: number;
  indexedAvgMs: number;
  results: Array<{
    query: string;
    candidates: number;
    fullScanMs: number;
    indexedMs: number;
  }>;
}> {
  const cache = getEmbeddingCache(cortexPath);
  await cache.load();
  const model = getEmbeddingModel();
  const allEntries = cache.getAllEntries().filter((entry) => entry.model === model);
  const eligibleEntries = allEntries.filter((entry) => {
    if (!project) return true;
    const rel = entry.path.startsWith(cortexPath) ? entry.path.slice(cortexPath.length + 1) : entry.path;
    const entryProject = rel.split("/")[0] ?? "";
    return entryProject === project || entryProject === "global";
  });
  const eligibleByPath = new Map(eligibleEntries.map((entry) => [entry.path, entry]));
  const eligiblePaths = new Set(eligibleEntries.map((entry) => entry.path));
  const vectorIndex = getPersistentVectorIndex(cortexPath);
  vectorIndex.ensure(cache.getAllEntries());

  const results: Array<{ query: string; candidates: number; fullScanMs: number; indexedMs: number }> = [];

  for (const query of queries) {
    const queryVec = await embedText(query);
    if (!queryVec || queryVec.length === 0) continue;

    const candidatePaths = vectorIndex.query(model, queryVec, 8, eligiblePaths);
    const candidates = candidatePaths.map((candidatePath) => eligibleByPath.get(candidatePath)).filter(Boolean) as typeof eligibleEntries;

    const fullStart = performance.now();
    for (let i = 0; i < VECTOR_MICROBENCH_ITERATIONS; i++) {
      for (const entry of eligibleEntries) {
        cosineSimilarity(queryVec, entry.vec);
      }
    }
    const fullScanMs = (performance.now() - fullStart) / VECTOR_MICROBENCH_ITERATIONS;

    const indexedStart = performance.now();
    for (let i = 0; i < VECTOR_MICROBENCH_ITERATIONS; i++) {
      const iterationPaths = vectorIndex.query(model, queryVec, 8, eligiblePaths);
      for (const candidatePath of iterationPaths) {
        const entry = eligibleByPath.get(candidatePath);
        if (entry) cosineSimilarity(queryVec, entry.vec);
      }
    }
    const indexedMs = (performance.now() - indexedStart) / VECTOR_MICROBENCH_ITERATIONS;

    results.push({
      query,
      candidates: candidates.length,
      fullScanMs: Number(fullScanMs.toFixed(4)),
      indexedMs: Number(indexedMs.toFixed(4)),
    });
  }

  const avgCandidates = results.length > 0
    ? Number((results.reduce((sum, row) => sum + row.candidates, 0) / results.length).toFixed(1))
    : 0;
  const fullScanAvgMs = results.length > 0
    ? Number((results.reduce((sum, row) => sum + row.fullScanMs, 0) / results.length).toFixed(4))
    : 0;
  const indexedAvgMs = results.length > 0
    ? Number((results.reduce((sum, row) => sum + row.indexedMs, 0) / results.length).toFixed(4))
    : 0;

  return {
    model,
    eligibleDocs: eligibleEntries.length,
    avgCandidates,
    fullScanAvgMs,
    indexedAvgMs,
    results,
  };
}

async function main() {
  const { cortexPath, project, outputPath, queries } = parseArgs(process.argv);
  if (!fs.existsSync(cortexPath)) {
    console.error(`cortex directory not found: ${cortexPath}`);
    process.exit(1);
  }

  const db = await buildIndex(cortexPath, process.env.CORTEX_PROFILE || undefined);
  try {
    const countRows = db.exec("SELECT COUNT(*) FROM docs");
    const corpusDocs = Number(countRows?.[0]?.values?.[0]?.[0] ?? 0);
    const runs = [];
    for (const query of queries) {
      runs.push(await runMode("lexical", cortexPath, db, query, project));
      runs.push(await runMode("hybrid_gated", cortexPath, db, query, project));
    }

    const lexicalRuns = runs.filter((run) => run.mode === "lexical");
    const hybridRuns = runs.filter((run) => run.mode === "hybrid_gated");
    const vectorIndex = await runVectorMicrobench(cortexPath, queries, project);
    const semanticOnlyHits = queries.filter((query) => {
      const lexical = lexicalRuns.find((run) => run.query === query);
      const hybrid = hybridRuns.find((run) => run.query === query);
      return (lexical?.resultCount ?? 0) === 0 && (hybrid?.resultCount ?? 0) > 0;
    });
    const lexicalOnlyHits = queries.filter((query) => {
      const lexical = lexicalRuns.find((run) => run.query === query);
      const hybrid = hybridRuns.find((run) => run.query === query);
      return (lexical?.resultCount ?? 0) > 0 && (hybrid?.resultCount ?? 0) === 0;
    });

    const output = {
      runDate: new Date().toISOString(),
      conditions: {
        machine: os.hostname(),
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        cortexPath,
        project: project ?? null,
        corpusDocs,
        queryCount: queries.length,
        tokenBudget: DEFAULT_TOKEN_BUDGET,
        lineBudget: DEFAULT_LINE_BUDGET,
        charBudget: DEFAULT_CHAR_BUDGET,
        vectorMicrobenchIterations: VECTOR_MICROBENCH_ITERATIONS,
      },
      lexical: summarizeModeRuns(lexicalRuns),
      hybridGated: summarizeModeRuns(hybridRuns),
      comparison: {
        semanticOnlyHits,
        lexicalOnlyHits,
        hitDelta: semanticOnlyHits.length - lexicalOnlyHits.length,
        topDocChanges: queries
          .map((query) => {
            const lexical = lexicalRuns.find((run) => run.query === query);
            const hybrid = hybridRuns.find((run) => run.query === query);
            if (!lexical || !hybrid || lexical.topDoc === hybrid.topDoc) return null;
            return { query, lexicalTopDoc: lexical.topDoc, hybridTopDoc: hybrid.topDoc };
          })
          .filter(Boolean),
      },
      vectorIndex: {
        ...vectorIndex,
        candidateFractionPct: vectorIndex.eligibleDocs > 0
          ? Number(((vectorIndex.avgCandidates / vectorIndex.eligibleDocs) * 100).toFixed(1))
          : 0,
      },
      runs,
    };

    const finalOutputPath = outputPath
      ? path.resolve(outputPath)
      : path.join(os.tmpdir(), "cortex-retrieval-bench.json");
    fs.writeFileSync(finalOutputPath, JSON.stringify(output, null, 2));

    console.log(`queries: ${queries.length}`);
    console.log(`lexical total ms avg/p50/p95: ${output.lexical.totalMs.avg}/${output.lexical.totalMs.p50}/${output.lexical.totalMs.p95}`);
    console.log(`hybrid total ms avg/p50/p95: ${output.hybridGated.totalMs.avg}/${output.hybridGated.totalMs.p50}/${output.hybridGated.totalMs.p95}`);
    console.log(`lexical used tokens avg: ${output.lexical.usedTokens.avg}`);
    console.log(`hybrid used tokens avg: ${output.hybridGated.usedTokens.avg}`);
    console.log(`lexical hits/misses: ${output.lexical.hits}/${output.lexical.misses}`);
    console.log(`hybrid hits/misses: ${output.hybridGated.hits}/${output.hybridGated.misses}`);
    console.log(`semantic-only hits: ${output.comparison.semanticOnlyHits.length}`);
    console.log(`vector candidates avg: ${vectorIndex.avgCandidates}/${vectorIndex.eligibleDocs} eligible docs`);
    console.log(`vector full-scan avg ms: ${vectorIndex.fullScanAvgMs}`);
    console.log(`vector indexed avg ms: ${vectorIndex.indexedAvgMs}`);
    console.log(`saved: ${finalOutputPath}`);
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});

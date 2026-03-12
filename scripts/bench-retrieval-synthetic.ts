#!/usr/bin/env tsx

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { performance } from "perf_hooks";

import { buildIndex, type DocRow } from "../mcp/src/shared-index.js";
import { searchDocuments, searchDocumentsAsync, rankResults, selectSnippets } from "../mcp/src/cli-hooks-retrieval.js";
import { buildRobustFtsQuery, extractKeywords } from "../mcp/src/utils.js";

const DEFAULT_SIZES = [1000, 10000];
const DEFAULT_QUERY_TARGETS = 12;
const DEFAULT_TOKEN_BUDGET = 550;
const DEFAULT_LINE_BUDGET = 6;
const DEFAULT_CHAR_BUDGET = 520;
const PROJECT_NAME = "synthetic-bench";

const SERVICES = [
  "payments-api",
  "auth-gateway",
  "billing-worker",
  "web-ui",
  "sync-daemon",
  "project-indexer",
  "queue-processor",
  "deploy-orchestrator",
  "timeline-service",
  "entity-graph",
];

const COMPONENTS = [
  "file-lock",
  "vector-cache",
  "fts-rebuild",
  "queue-flush",
  "hook-session",
  "review-filter",
  "background-push",
  "project-router",
  "citation-check",
  "trust-decay",
];

const ISSUES = [
  "stale-lock-recovery",
  "incremental-index-rebuild",
  "task-token-budget",
  "semantic-candidate-pruning",
  "citation-validity-check",
  "review-queue-triage",
  "eventual-consistency-merge",
  "cross-project-entity-link",
  "session-identity-binding",
  "background-sync-retry",
];

const ACTIONS = [
  "retry backoff",
  "bounded pagination",
  "conflict marker cleanup",
  "trust score suppression",
  "incremental cache refresh",
  "semantic gate close",
  "stable memory id expansion",
  "write queue serialization",
  "lexical rescue query",
  "reference tier extraction",
];

type Args = {
  sizes: number[];
  outputPath?: string;
  keepTemp: boolean;
  queriesPerSize: number;
  rootDir?: string;
};

type QuerySpec = {
  query: string;
  expectedTopDoc: string;
};

type ModeRun = {
  mode: string;
  query: string;
  searchMs: number;
  totalMs: number;
  resultCount: number;
  selectedCount: number;
  usedTokens: number;
  topDoc: string | null;
  exactTopHit: boolean;
};

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  const getArg = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const parseSizes = (raw?: string): number[] => {
    const values = (raw || "").split(",").map((part) => Number(part.trim())).filter((n) => Number.isFinite(n) && n > 0);
    return values.length > 0 ? values : DEFAULT_SIZES;
  };

  return {
    sizes: parseSizes(getArg("--sizes")),
    outputPath: getArg("--output"),
    keepTemp: args.includes("--keep-temp"),
    queriesPerSize: Number(getArg("--queries-per-size") || DEFAULT_QUERY_TARGETS),
    rootDir: getArg("--root-dir"),
  };
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

function docLabel(row: DocRow | undefined): string | null {
  return row ? `${row.project}/${row.filename}` : null;
}

function pad(num: number): string {
  return String(num).padStart(6, "0");
}

function shardFor(index: number): string {
  return `shard-${String(Math.floor(index / 1000)).padStart(3, "0")}`;
}

function memoryPath(cortexPath: string, index: number): string {
  const shard = shardFor(index);
  return path.join(cortexPath, PROJECT_NAME, "reference", shard, `memory-${pad(index)}.md`);
}

function memoryFilename(index: number): string {
  return `memory-${pad(index)}.md`;
}

function buildMemoryContent(index: number): string {
  const service = SERVICES[index % SERVICES.length];
  const component = COMPONENTS[(index * 3) % COMPONENTS.length];
  const issue = ISSUES[(index * 7) % ISSUES.length];
  const action = ACTIONS[(index * 11) % ACTIONS.length];
  const exactNeedle = `needle-${pad(index)}-${service}-${issue}`;
  const altNeedle = `trace-${pad(index)}-${component}`;
  return [
    `# Synthetic Memory ${pad(index)}`,
    "",
    `service: ${service}`,
    `component: ${component}`,
    `issue: ${issue}`,
    `canonical_id: sim-${pad(index)}`,
    `trace_token: ${altNeedle}`,
    "",
    `Finding: ${service} hit ${issue} in ${component}.`,
    `Resolution: ${action} plus lexical rescue query handling kept the queue stable.`,
    `Search anchors: ${exactNeedle}, ${service} ${component}, ${issue}, ${action}.`,
    `Notes: indexed synthetic memory ${pad(index)} for large-corpus retrieval scaling.`,
    "",
  ].join("\n");
}

function createSyntheticCortex(rootDir: string, size: number): { cortexPath: string; queries: QuerySpec[] } {
  const cortexPath = path.join(rootDir, `cortex-sim-${size}`);
  fs.mkdirSync(path.join(cortexPath, PROJECT_NAME, "reference"), { recursive: true });
  fs.writeFileSync(path.join(cortexPath, PROJECT_NAME, "CLAUDE.md"), `# ${PROJECT_NAME}\n\nSynthetic benchmark project.\n`);
  fs.writeFileSync(path.join(cortexPath, PROJECT_NAME, "summary.md"), `Synthetic corpus with ${size} generated memory files.\n`);
  fs.writeFileSync(path.join(cortexPath, PROJECT_NAME, "FINDINGS.md"), "# Findings\n\n");
  fs.writeFileSync(path.join(cortexPath, PROJECT_NAME, "tasks.md"), "# Task\n\n## Active\n\n");

  for (let index = 0; index < size; index++) {
    const fullPath = memoryPath(cortexPath, index);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, buildMemoryContent(index));
  }

  return { cortexPath, queries: [] };
}

function buildQuerySet(size: number, desiredCount: number): QuerySpec[] {
  const count = Math.max(4, desiredCount);
  const seen = new Set<number>();
  const picks: number[] = [];
  for (let i = 0; i < count; i++) {
    const index = Math.min(size - 1, Math.floor((i * size) / count));
    if (seen.has(index)) continue;
    seen.add(index);
    picks.push(index);
  }

  return picks.flatMap((index) => {
    const service = SERVICES[index % SERVICES.length];
    const component = COMPONENTS[(index * 3) % COMPONENTS.length];
    const issue = ISSUES[(index * 7) % ISSUES.length];
    const expectedTopDoc = `${PROJECT_NAME}/${memoryFilename(index)}`;
    return [
      {
        query: `needle-${pad(index)}-${service}-${issue}`,
        expectedTopDoc,
      },
      {
        query: `sim-${pad(index)} ${service} ${component} ${issue}`,
        expectedTopDoc,
      },
    ];
  }).slice(0, count);
}

async function runMode(
  mode: "lexical" | "hybrid_gated",
  cortexPath: string,
  db: Awaited<ReturnType<typeof buildIndex>>,
  querySpec: QuerySpec,
): Promise<ModeRun> {
  const safeQuery = buildRobustFtsQuery(querySpec.query);
  const keywords = extractKeywords(querySpec.query);
  const searchStart = performance.now();
  const rows = safeQuery
    ? mode === "lexical"
      ? searchDocuments(db, safeQuery, querySpec.query, keywords, PROJECT_NAME, false)
      : await searchDocumentsAsync(db, safeQuery, querySpec.query, keywords, PROJECT_NAME, false, cortexPath)
    : null;
  const searchMs = performance.now() - searchStart;

  const ranked = rankResults(rows ?? [], "general", null, PROJECT_NAME, cortexPath, db, undefined, querySpec.query);
  const { selected, usedTokens } = selectSnippets(
    ranked,
    keywords || querySpec.query,
    DEFAULT_TOKEN_BUDGET,
    DEFAULT_LINE_BUDGET,
    DEFAULT_CHAR_BUDGET,
  );
  const totalMs = performance.now() - searchStart;
  const topDoc = docLabel(ranked[0]);
  return {
    mode,
    query: querySpec.query,
    searchMs: Number(searchMs.toFixed(2)),
    totalMs: Number(totalMs.toFixed(2)),
    resultCount: ranked.length,
    selectedCount: selected.length,
    usedTokens,
    topDoc,
    exactTopHit: topDoc === querySpec.expectedTopDoc,
  };
}

function summarizeRuns(runs: ModeRun[]) {
  return {
    totalMs: summarize(runs.map((run) => run.totalMs)),
    searchMs: summarize(runs.map((run) => run.searchMs)),
    usedTokens: summarize(runs.map((run) => run.usedTokens)),
    hits: runs.filter((run) => run.resultCount > 0).length,
    exactTopHits: runs.filter((run) => run.exactTopHit).length,
    misses: runs.filter((run) => run.resultCount === 0).map((run) => run.query),
  };
}

async function benchmarkSize(rootDir: string, size: number, queriesPerSize: number, keepTemp: boolean) {
  const { cortexPath } = createSyntheticCortex(rootDir, size);
  const queries = buildQuerySet(size, queriesPerSize);

  const coldStart = performance.now();
  const coldDb = await buildIndex(cortexPath);
  const coldBuildMs = Number((performance.now() - coldStart).toFixed(2));
  coldDb.close();

  const warmStart = performance.now();
  const db = await buildIndex(cortexPath);
  const warmBuildMs = Number((performance.now() - warmStart).toFixed(2));

  try {
    const corpusDocs = Number(db.exec("SELECT COUNT(*) FROM docs")?.[0]?.values?.[0]?.[0] ?? 0);
    const runs: ModeRun[] = [];
    for (const querySpec of queries) {
      runs.push(await runMode("lexical", cortexPath, db, querySpec));
      runs.push(await runMode("hybrid_gated", cortexPath, db, querySpec));
    }
    const lexicalRuns = runs.filter((run) => run.mode === "lexical");
    const hybridRuns = runs.filter((run) => run.mode === "hybrid_gated");
    return {
      size,
      cortexPath: keepTemp ? cortexPath : null,
      corpusDocs,
      generatedFiles: size,
      queries: queries.map((query) => query.query),
      coldBuildMs,
      warmBuildMs,
      lexical: summarizeRuns(lexicalRuns),
      hybridGated: summarizeRuns(hybridRuns),
      comparison: {
        exactTopHitDelta: hybridRuns.filter((run) => run.exactTopHit).length - lexicalRuns.filter((run) => run.exactTopHit).length,
      },
      runs,
    };
  } finally {
    db.close();
    if (!keepTemp) fs.rmSync(cortexPath, { recursive: true, force: true });
  }
}

async function main() {
  const { sizes, outputPath, keepTemp, queriesPerSize, rootDir } = parseArgs(process.argv);
  const runRoot = rootDir
    ? path.resolve(rootDir)
    : fs.mkdtempSync(path.join(os.tmpdir(), "cortex-synthetic-bench-"));
  fs.mkdirSync(runRoot, { recursive: true });

  const sizeRuns = [];
  for (const size of sizes) {
    console.log(`building synthetic corpus: ${size} files`);
    sizeRuns.push(await benchmarkSize(runRoot, size, queriesPerSize, keepTemp));
  }

  const output = {
    runDate: new Date().toISOString(),
    generator: "synthetic-markdown-memory-files/v1",
    conditions: {
      machine: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      sizes,
      queriesPerSize,
      keepTemp,
      rootDir: keepTemp ? runRoot : null,
      tokenBudget: DEFAULT_TOKEN_BUDGET,
      lineBudget: DEFAULT_LINE_BUDGET,
      charBudget: DEFAULT_CHAR_BUDGET,
      hybridFeature: process.env.CORTEX_FEATURE_HYBRID_SEARCH || null,
      embeddingApiConfigured: Boolean(process.env.CORTEX_EMBEDDING_API_URL || process.env.OLLAMA_HOST || process.env.OLLAMA_URL),
    },
    runs: sizeRuns,
  };

  const finalOutputPath = outputPath
    ? path.resolve(outputPath)
    : path.join(process.cwd(), "docs", "benchmark-synthetic-results.json");
  fs.writeFileSync(finalOutputPath, JSON.stringify(output, null, 2));

  for (const run of sizeRuns) {
    console.log(
      [
        `size=${run.size}`,
        `coldBuildMs=${run.coldBuildMs}`,
        `warmBuildMs=${run.warmBuildMs}`,
        `lexicalAvg=${run.lexical.totalMs.avg}`,
        `hybridAvg=${run.hybridGated.totalMs.avg}`,
        `lexicalExactTop=${run.lexical.exactTopHits}/${run.queries.length}`,
        `hybridExactTop=${run.hybridGated.exactTopHits}/${run.queries.length}`,
      ].join(" "),
    );
  }
  console.log(`saved: ${finalOutputPath}`);

  if (!keepTemp && !rootDir) {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});

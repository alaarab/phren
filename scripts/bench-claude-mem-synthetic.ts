#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { performance } from "perf_hooks";
import { pathToFileURL } from "url";

const DEFAULT_SIZES = [1000];
const DEFAULT_QUERY_TARGETS = 8;

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
  claudeMemRoot: string;
  uvxPath: string;
  runRoot: string;
  streamBackfill: boolean;
  streamChunkSize: number;
  progressEvery: number;
  skipSeed: boolean;
};

type QuerySpec = {
  query: string;
  expectedTitle: string;
};

type RunResult = {
  query: string;
  searchMs: number;
  totalResults: number;
  topTitle: string | null;
  exactTopHit: boolean;
};

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  const getArg = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const parseSizes = (raw?: string): number[] => {
    const values = (raw || "")
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    return values.length > 0 ? values : DEFAULT_SIZES;
  };

  const claudeMemRoot = getArg("--claude-mem-root") || process.env.CLAUDE_MEM_ROOT;
  const uvxPath = getArg("--uvx-path") || process.env.UVX_PATH;
  if (!claudeMemRoot) {
    throw new Error("Missing --claude-mem-root (or CLAUDE_MEM_ROOT)");
  }
  if (!uvxPath) {
    throw new Error("Missing --uvx-path (or UVX_PATH)");
  }

  return {
    sizes: parseSizes(getArg("--sizes")),
    outputPath: getArg("--output"),
    keepTemp: args.includes("--keep-temp"),
    queriesPerSize: Number(getArg("--queries-per-size") || DEFAULT_QUERY_TARGETS),
    claudeMemRoot: path.resolve(claudeMemRoot),
    uvxPath: path.resolve(uvxPath),
    runRoot: path.resolve(getArg("--root-dir") || fs.mkdtempSync(path.join(os.tmpdir(), "claude-mem-bench-"))),
    streamBackfill: args.includes("--stream-backfill"),
    streamChunkSize: Number(getArg("--stream-chunk-size") || 1000),
    progressEvery: Number(getArg("--progress-every") || 10000),
    skipSeed: args.includes("--skip-seed"),
  };
}

function pad(num: number): string {
  return String(num).padStart(6, "0");
}

function projectName(size: number): string {
  return `synthetic-bench-${size}`;
}

function summarize(values: number[]) {
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

function buildObservation(index: number) {
  const service = SERVICES[index % SERVICES.length];
  const component = COMPONENTS[(index * 3) % COMPONENTS.length];
  const issue = ISSUES[(index * 7) % ISSUES.length];
  const action = ACTIONS[(index * 11) % ACTIONS.length];
  const exactNeedle = `needle-${pad(index)}-${service}-${issue}`;
  const title = `Synthetic Memory ${pad(index)}`;
  return {
    title,
    obs: {
      type: "discovery",
      title,
      subtitle: null,
      facts: [] as string[],
      narrative: [
        `${service} hit ${issue} in ${component}.`,
        `Resolution used ${action}.`,
        `Search anchors: ${exactNeedle}, sim-${pad(index)}, ${service} ${component} ${issue}.`,
        `Synthetic benchmark document ${pad(index)}.`,
      ].join(" "),
      concepts: [service, component, issue],
      files_read: [`${service}/${component}.ts`],
      files_modified: [] as string[],
    },
  };
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
    const expectedTitle = `Synthetic Memory ${pad(index)}`;
    return [
      {
        query: `needle-${pad(index)}-${service}-${issue}`,
        expectedTitle,
      },
      {
        query: `sim-${pad(index)} ${service} ${component} ${issue}`,
        expectedTitle,
      },
    ];
  }).slice(0, count);
}

function installUvxWrapper(binDir: string, realUvxPath: string) {
  fs.mkdirSync(binDir, { recursive: true });
  const wrapperPath = path.join(binDir, "uvx");
  const wrapper = [
    "#!/usr/bin/env bash",
    "export PYTHONHTTPSVERIFY=0",
    "export CURL_CA_BUNDLE=\"\"",
    "export REQUESTS_CA_BUNDLE=\"\"",
    "export SSL_CERT_FILE=\"\"",
    "export HF_HUB_DISABLE_SSL_VERIFY=1",
    "export HF_HUB_DISABLE_XET=1",
    `exec "${realUvxPath}" --allow-insecure-host pypi.org --allow-insecure-host files.pythonhosted.org "$@"`,
    "",
  ].join("\n");
  fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
}

async function loadClaudeMemModules(claudeMemRoot: string) {
  const importFromRepo = async (relativePath: string) =>
    import(pathToFileURL(path.join(claudeMemRoot, relativePath)).href);

  const [{ SessionStore }, { SessionSearch }, { SearchManager }, { FormattingService }, { TimelineService }, { ChromaSync }] =
    await Promise.all([
      importFromRepo("src/services/sqlite/SessionStore.ts"),
      importFromRepo("src/services/sqlite/SessionSearch.ts"),
      importFromRepo("src/services/worker/legacy/SearchManager.ts").catch(() => importFromRepo("src/services/worker/SearchManager.ts")),
      importFromRepo("src/services/worker/FormattingService.ts"),
      importFromRepo("src/services/worker/TimelineService.ts"),
      importFromRepo("src/services/sync/ChromaSync.ts"),
    ]);

  return { SessionStore, SessionSearch, SearchManager, FormattingService, TimelineService, ChromaSync };
}

async function seedProject(
  SessionStoreCtor: any,
  dbPath: string,
  project: string,
  size: number,
): Promise<void> {
  const store = new SessionStoreCtor(dbPath);
  const now = Date.now();
  for (let index = 0; index < size; index++) {
    const contentSessionId = `content-${project}-${pad(index)}`;
    const memorySessionId = `memory-${project}-${pad(index)}`;
    const sessionDbId = store.createSDKSession(contentSessionId, project, `Synthetic benchmark prompt ${pad(index)}`);
    store.updateMemorySessionId(sessionDbId, memorySessionId);
    const { obs } = buildObservation(index);
    store.storeObservation(
      memorySessionId,
      project,
      obs,
      1,
      0,
      now - (index % 1000),
    );
  }
  store.db.close();
}

function getProjectObservationCount(dbPath: string, project: string): number {
  const db = new Database(dbPath);
  try {
    const row = db.prepare("SELECT COUNT(*) as count FROM observations WHERE project = ?").get(project) as { count?: number } | undefined;
    return Number(row?.count || 0);
  } finally {
    db.close();
  }
}

async function benchmarkProject(
  modules: Awaited<ReturnType<typeof loadClaudeMemModules>>,
  dbPath: string,
  project: string,
  queries: QuerySpec[],
  streamBackfill: boolean,
  streamChunkSize: number,
  progressEvery: number,
): Promise<{
  backfillMs: number;
  backfillMode: string;
  coldQueryMs: number;
  search: ReturnType<typeof summarize>;
  hits: number;
  exactTopHits: number;
  misses: string[];
  runs: RunResult[];
}> {
  const sessionStore = new modules.SessionStore(dbPath);
  const sessionSearch = new modules.SessionSearch(dbPath);
  const formatter = new modules.FormattingService();
  const timelineService = new modules.TimelineService();
  const chromaSync = new modules.ChromaSync(project);
  const searchManager = new modules.SearchManager(
    sessionSearch,
    sessionStore,
    chromaSync,
    formatter,
    timelineService,
  );

  const backfillStart = performance.now();
  const backfillMode = streamBackfill ? "streamed_sync" : "default_backfill";
  if (streamBackfill) {
    await streamedBackfill(sessionStore, chromaSync, project, streamChunkSize, progressEvery);
  } else {
    await chromaSync.ensureBackfilled(project);
  }
  const backfillMs = Number((performance.now() - backfillStart).toFixed(2));

  const coldProbeStart = performance.now();
  await searchManager.search({
    query: queries[0]?.query,
    type: "observations",
    project,
    limit: 10,
    format: "json",
  });
  const coldQueryMs = Number((performance.now() - coldProbeStart).toFixed(2));

  const runs: RunResult[] = [];
  for (const query of queries) {
    const start = performance.now();
    const result = await searchManager.search({
      query: query.query,
      type: "observations",
      project,
      limit: 10,
      format: "json",
    });
    const searchMs = Number((performance.now() - start).toFixed(2));
    const observations = Array.isArray(result?.observations) ? result.observations : [];
    const topTitle = observations[0]?.title ?? null;
    runs.push({
      query: query.query,
      searchMs,
      totalResults: observations.length,
      topTitle,
      exactTopHit: topTitle === query.expectedTitle,
    });
  }

  try {
    await chromaSync.close?.();
  } catch {}
  try {
    sessionStore.db.close();
  } catch {}

  return {
    backfillMs,
    backfillMode,
    coldQueryMs,
    search: summarize(runs.map((run) => run.searchMs)),
    hits: runs.filter((run) => run.totalResults > 0).length,
    exactTopHits: runs.filter((run) => run.exactTopHit).length,
    misses: runs.filter((run) => run.totalResults === 0).map((run) => run.query),
    runs,
  };
}

async function streamedBackfill(
  sessionStore: any,
  chromaSync: any,
  project: string,
  chunkSize: number,
  progressEvery: number,
): Promise<void> {
  await chromaSync.ensureCollectionExists?.();
  const existing = await chromaSync.getExistingChromaIds?.(project);
  const existingObsIds = new Set<number>(
    Array.from(existing?.observations ?? []).filter((id) => Number.isInteger(id) && id > 0) as number[],
  );
  let lastId = 0;
  let processed = 0;
  for (;;) {
    const rows = sessionStore.db.prepare(`
      SELECT id, memory_session_id, project, text, type, title, subtitle, facts, narrative, concepts,
             files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch
      FROM observations
      WHERE project = ? AND id > ?
      ORDER BY id ASC
      LIMIT ?
    `).all(project, lastId, chunkSize) as any[];
    if (rows.length === 0) break;

    const pendingRows = rows.filter((row) => !existingObsIds.has(row.id));
    if (pendingRows.length === 0) {
      lastId = rows[rows.length - 1]?.id ?? lastId;
      processed += rows.length;
      if (processed % progressEvery === 0) {
        console.log(`stream-backfill progress: project=${project} scanned=${processed} added=0`);
      }
      continue;
    }

    const docs = pendingRows.flatMap((row) => chromaSync.formatObservationDocs(row));
    await chromaSync.addDocuments(docs);
    lastId = rows[rows.length - 1]?.id ?? lastId;
    processed += rows.length;
    if (processed % progressEvery === 0) {
      console.log(`stream-backfill progress: project=${project} scanned=${processed} added=${pendingRows.length}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const homeDir = path.join(args.runRoot, "home");
  const dataDir = path.join(homeDir, ".claude-mem");
  const claudeConfigDir = path.join(homeDir, ".claude");
  const binDir = path.join(args.runRoot, "bin");
  installUvxWrapper(binDir, args.uvxPath);

  process.env.HOME = homeDir;
  process.env.CLAUDE_MEM_DATA_DIR = dataDir;
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  process.env.CLAUDE_MEM_PYTHON_VERSION = "3.12";
  process.env.PATH = `${binDir}:${process.env.PATH || ""}`;

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(claudeConfigDir, { recursive: true });

  const modules = await loadClaudeMemModules(args.claudeMemRoot);
  const dbPath = path.join(dataDir, "claude-mem.db");
  const runs = [];
  const finalOutputPath = args.outputPath
    ? path.resolve(args.outputPath)
    : path.join(process.cwd(), "docs", "benchmark-claude-mem-synthetic-results.json");

  const writeSnapshot = () => {
    const output = {
      runDate: new Date().toISOString(),
      generator: "claude-mem-synthetic-observations/v1",
      conditions: {
        platform: process.platform,
        arch: process.arch,
        bunVersion: Bun.version,
        claudeMemRoot: args.claudeMemRoot,
        uvxPath: args.uvxPath,
        dataDir,
        sizes: args.sizes,
        queriesPerSize: args.queriesPerSize,
        streamBackfill: args.streamBackfill,
        streamChunkSize: args.streamChunkSize,
        progressEvery: args.progressEvery,
        keepTemp: args.keepTemp,
        runRoot: args.keepTemp ? args.runRoot : null,
      },
      runs,
    };
    fs.writeFileSync(finalOutputPath, JSON.stringify(output, null, 2));
  };

  for (const size of args.sizes) {
    const project = projectName(size);
    const queries = buildQuerySet(size, args.queriesPerSize);
    let seedMs = 0;
    if (args.skipSeed) {
      const existing = getProjectObservationCount(dbPath, project);
      if (existing !== size) {
        throw new Error(`--skip-seed requested but project ${project} has ${existing} observations; expected ${size}`);
      }
      console.log(`skipping seed: size=${size} existing=${existing}`);
    } else {
      console.log(`seeding claude-mem synthetic corpus: size=${size}`);
      const seedStart = performance.now();
      await seedProject(modules.SessionStore, dbPath, project, size);
      seedMs = Number((performance.now() - seedStart).toFixed(2));
    }

    console.log(`benchmarking claude-mem search: size=${size}`);
    const result = await benchmarkProject(
      modules,
      dbPath,
      project,
      queries,
      args.streamBackfill,
      args.streamChunkSize,
      args.progressEvery,
    );
    runs.push({
      size,
      project,
      queries: queries.map((query) => query.query),
      seedMs,
      ...result,
    });

    console.log(
      [
        `size=${size}`,
        `seedMs=${seedMs}`,
        `backfillMs=${result.backfillMs}`,
        `backfillMode=${result.backfillMode}`,
        `coldQueryMs=${result.coldQueryMs}`,
        `avgQueryMs=${result.search.avg}`,
        `exactTopHits=${result.exactTopHits}/${queries.length}`,
      ].join(" "),
    );
    writeSnapshot();
  }
  writeSnapshot();
  console.log(`saved: ${finalOutputPath}`);

  if (!args.keepTemp) {
    fs.rmSync(args.runRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

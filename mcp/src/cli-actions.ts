import * as fs from "fs";
import { runtimeFile, getCortexPath } from "./shared.js";
import {
  recordFeedback,
  flushEntryScores,
  getWorkflowPolicy,
} from "./shared-governance.js";
import { upsertCanonical } from "./shared-content.js";
import { errorMessage } from "./utils.js";
import { addFinding as addFindingCore } from "./core-finding.js";
import { runDoctor } from "./link.js";
import { startReviewUi } from "./memory-ui.js";
import { startShell } from "./shell.js";
import { runCortexUpdate } from "./update.js";
import { readRuntimeHealth } from "./data-access.js";
import { runSearch, type SearchOptions } from "./cli-search.js";
import { resolveRuntimeProfile } from "./runtime-profile.js";

export async function handleSearch(opts: SearchOptions, profile: string) {
  const result = await runSearch(opts, getCortexPath(), profile);
  if (result.lines.length > 0) {
    console.log(result.lines.join("\n"));
  }
  if (result.exitCode !== 0) process.exit(result.exitCode);
}

export async function handleAddFinding(project: string, learning: string) {
  if (!project || !learning) {
    console.error('Usage: cortex add-finding <project> "<insight>"');
    process.exit(1);
  }

  try {
    const result = addFindingCore(getCortexPath(), project, learning);
    if (!result.ok) {
      console.error(result.message);
      process.exit(1);
    }
    console.log(result.message);
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

export async function handlePinCanonical(project: string, memory: string) {
  if (!project || !memory) {
    console.error('Usage: cortex pin <project> "<memory>"');
    process.exit(1);
  }
  const result = upsertCanonical(getCortexPath(), project, memory);
  console.log(result.ok ? result.data : result.error);
}

export async function handleDoctor(args: string[]) {
  const profile = resolveRuntimeProfile(getCortexPath());
  const fix = args.includes("--fix");
  const checkData = args.includes("--check-data");
  const agentsOnly = args.includes("--agents");
  const result = await runDoctor(getCortexPath(), fix, checkData);
  if (agentsOnly) {
    const agentChecks = result.checks.filter((check) =>
      check.name.includes("cursor") || check.name.includes("copilot") || check.name.includes("codex") || check.name.includes("windsurf")
    );
    console.log(`cortex doctor --agents: ${agentChecks.every((check) => check.ok) ? "all configured" : "some not configured"}`);
    for (const check of agentChecks) {
      console.log(`- ${check.ok ? "ok" : "not configured"} ${check.name}: ${check.detail}`);
    }
    if (agentChecks.length === 0) {
      console.log("No agent integrations detected. Run `cortex init` to configure.");
    }
    process.exit(agentChecks.every((check) => check.ok) ? 0 : 1);
  }

  console.log(`cortex doctor: ${result.ok ? "ok" : "issues found"}`);
  if (result.machine) console.log(`machine: ${result.machine}`);
  if (result.profile) console.log(`profile: ${result.profile}`);
  console.log(`tasks: ${getWorkflowPolicy(getCortexPath()).taskMode} mode`);
  for (const check of result.checks) {
    console.log(`- ${check.ok ? "ok" : "fail"} ${check.name}: ${check.detail}`);
  }

  try {
    const missFile = runtimeFile(getCortexPath(), "search-misses.jsonl");
    if (fs.existsSync(missFile)) {
      const lines = fs.readFileSync(missFile, "utf8").split("\n").filter(Boolean);
      if (lines.length > 0) {
        const tokenCounts = new Map<string, number>();
        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as { query: string };
            const tokens = entry.query.toLowerCase().split(/\s+/).filter((token) => token.length > 2);
            for (const token of tokens) {
              tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
            }
          } catch (err: unknown) {
            if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] doctor searchMissParse: ${errorMessage(err)}\n`);
          }
        }
        const topMisses = [...tokenCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);
        if (topMisses.length > 0) {
          console.log(`\nSearch miss patterns (${lines.length} zero-result queries):`);
          for (const [token, count] of topMisses) {
            console.log(`  ${token}: ${count} miss(es)`);
          }
        }
      }
    }
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] doctor searchMissAnalysis: ${errorMessage(err)}\n`);
  }

  try {
    const { checkOllamaAvailable, checkModelAvailable, getOllamaUrl, getEmbeddingModel } = await import("./shared-ollama.js");
    const { getEmbeddingCache, formatEmbeddingCoverage } = await import("./shared-embedding-cache.js");
    const { listIndexedDocumentPaths } = await import("./shared-index.js");
    const ollamaUrl = getOllamaUrl();
    if (!ollamaUrl) {
      console.log("- ok  semantic-search: disabled (optional; enable for fuzzy/paraphrase-heavy retrieval)");
    } else {
      const available = await checkOllamaAvailable();
      if (!available) {
        console.log(`- warn semantic-search: Ollama not running at ${ollamaUrl} (start Ollama or set CORTEX_OLLAMA_URL=off to disable)`);
      } else {
        const model = getEmbeddingModel();
        const modelReady = await checkModelAvailable();
        if (!modelReady) {
          console.log(`- warn semantic-search: model ${model} not pulled (run: ollama pull ${model})`);
        } else {
          const cortexPath = getCortexPath();
          const cache = getEmbeddingCache(cortexPath);
          await cache.load().catch(() => {});
          const allPaths = listIndexedDocumentPaths(cortexPath, profile || undefined);
          const coverage = cache.coverage(allPaths);
          console.log(`- ok  semantic-search: ${model} ready, ${formatEmbeddingCoverage(coverage)}`);
        }
      }
    }
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] doctor ollamaStatus: ${errorMessage(err)}\n`);
  }

  process.exit(result.ok ? 0 : 1);
}

export async function handleStatus() {
  const cortexPath = getCortexPath();
  const profile = resolveRuntimeProfile(cortexPath);
  const runtime = readRuntimeHealth(cortexPath);
  console.log("cortex status");
  console.log(`last auto-save: ${runtime.lastAutoSave?.status || "n/a"}${runtime.lastAutoSave?.at ? ` @ ${runtime.lastAutoSave.at}` : ""}`);
  console.log(`last pull: ${runtime.lastSync?.lastPullStatus || "n/a"}${runtime.lastSync?.lastPullAt ? ` @ ${runtime.lastSync.lastPullAt}` : ""}`);
  console.log(`last push: ${runtime.lastSync?.lastPushStatus || "n/a"}${runtime.lastSync?.lastPushAt ? ` @ ${runtime.lastSync.lastPushAt}` : ""}`);
  console.log(`unsynced commits: ${runtime.lastSync?.unsyncedCommits ?? 0}`);
  if (runtime.lastSync?.lastPushDetail) console.log(`push detail: ${runtime.lastSync.lastPushDetail}`);
  try {
    const { getOllamaUrl, checkOllamaAvailable, checkModelAvailable, getEmbeddingModel } = await import("./shared-ollama.js");
    const { getEmbeddingCache, formatEmbeddingCoverage } = await import("./shared-embedding-cache.js");
    const { listIndexedDocumentPaths } = await import("./shared-index.js");
    const ollamaUrl = getOllamaUrl();
    if (!ollamaUrl) {
      console.log("semantic-search: disabled (optional)");
      return;
    }
    const available = await checkOllamaAvailable();
    if (!available) {
      console.log(`semantic-search: offline (${ollamaUrl})`);
      return;
    }
    const model = getEmbeddingModel();
    const modelReady = await checkModelAvailable();
    if (!modelReady) {
      console.log(`semantic-search: model missing (${model})`);
      return;
    }
    const cache = getEmbeddingCache(cortexPath);
    await cache.load().catch(() => {});
    const coverage = cache.coverage(listIndexedDocumentPaths(cortexPath, profile || undefined));
    console.log(`semantic-search: ${model} ready, ${formatEmbeddingCoverage(coverage)}`);
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] handleStatus semanticSearch: ${errorMessage(err)}\n`);
  }
}

export async function handleQualityFeedback(args: string[]) {
  const key = args.find((arg) => arg.startsWith("--key="))?.slice("--key=".length);
  const feedback = args.find((arg) => arg.startsWith("--type="))?.slice("--type=".length) as "helpful" | "reprompt" | "regression" | undefined;
  if (!key || !feedback || !["helpful", "reprompt", "regression"].includes(feedback)) {
    console.error("Usage: cortex quality-feedback --key=<entry-key> --type=helpful|reprompt|regression");
    process.exit(1);
  }
  recordFeedback(getCortexPath(), key, feedback);
  flushEntryScores(getCortexPath());
  console.log(`Recorded feedback: ${feedback} for ${key}`);
}

export async function handleMemoryUi(args: string[]) {
  const portArg = args.find((arg) => arg.startsWith("--port="));
  const port = portArg ? Number.parseInt(portArg.slice("--port=".length), 10) : 3499;
  const safePort = Number.isNaN(port) ? 3499 : port;
  await startReviewUi(getCortexPath(), safePort, resolveRuntimeProfile(getCortexPath()));
}

export async function handleShell(args: string[], profile: string) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: cortex shell");
    console.log("Interactive shell with views for Projects, Backlog, Findings, Review Queue, Skills, Hooks, Machines/Profiles, and Health.");
    return;
  }
  await startShell(getCortexPath(), profile);
}

export async function handleUpdate(args: string[]) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: cortex update [--refresh-starter]");
    console.log("Updates cortex to the latest version (local git clone when available, otherwise npm global package).");
    console.log("Pass --refresh-starter to refresh global starter assets in the same flow.");
    return;
  }
  const result = await runCortexUpdate({ refreshStarter: args.includes("--refresh-starter") });
  console.log(result.message);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

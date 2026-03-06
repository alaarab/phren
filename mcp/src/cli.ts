import {
  ensureCortexPath,
  buildIndex,
  extractSnippet,
  queryRows,
  detectProject,
  addLearningToFile,
  checkConsolidationNeeded,
  debugLog,
  filterTrustedLearningsDetailed,
  appendMemoryQueue,
  appendAuditLog,
  upsertCanonicalMemory,
  getProjectDirs,
  getMemoryPolicy,
  getMemoryWorkflowPolicy,
  updateMemoryPolicy,
  updateMemoryWorkflowPolicy,
  getAccessControl,
  updateAccessControl,
  recordMemoryInjection,
  recordMemoryFeedback,
  getMemoryQualityMultiplier,
  memoryScoreKey,
  pruneDeadMemories,
  consolidateProjectLearnings,
  enforceCanonicalLocks,
  migrateLegacyFindings,
  migrateGovernanceFiles,
  updateRuntimeHealth,
  getIndexPolicy,
  updateIndexPolicy,
  GOVERNANCE_SCHEMA_VERSION,
  EXEC_TIMEOUT_MS,
  EXEC_TIMEOUT_QUICK_MS,
} from "./shared.js";
import { buildRobustFtsQuery, extractKeywords, isValidProjectName, STOP_WORDS } from "./utils.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync, spawn } from "child_process";
import { fileURLToPath } from "url";
import { runDoctor } from "./link.js";
import { commandExists } from "./hooks.js";
import { getHooksEnabledPreference } from "./init.js";
import { startMemoryUi } from "./memory-ui.js";
import { startShell } from "./shell.js";
import { runCortexUpdate } from "./update.js";
import { readBacklogs, backlogMarkdown, listMachines as listMachinesStore, listProfiles as listProfilesStore } from "./data-access.js";

const cortexPath = ensureCortexPath();
const profile = process.env.CORTEX_PROFILE || "";

const SEARCH_TYPE_ALIASES: Record<string, string> = {
  skills: "skill",
};
const SEARCH_TYPES = new Set([
  "claude",
  "summary",
  "learnings",
  "knowledge",
  "backlog",
  "changelog",
  "canonical",
  "memory-queue",
  "skill",
  "other",
]);

interface SearchOptions {
  query: string;
  limit: number;
  project?: string;
  type?: string;
}

function printSearchUsage() {
  console.error("Usage:");
  console.error("  cortex search <query> [--project <name>] [--type <type>] [--limit <n>] [--all]");
  console.error("  cortex search --project <name> [--type <type>] [--limit <n>] [--all]");
  console.error("  type: claude|summary|learnings|knowledge|backlog|changelog|canonical|memory-queue|skill|other");
}

function parseSearchArgs(args: string[]): SearchOptions | null {
  const queryParts: string[] = [];
  let project: string | undefined;
  let type: string | undefined;
  let limit = 10;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      printSearchUsage();
      return null;
    }

    if (arg === "--all") {
      limit = 100;
      continue;
    }

    const [flag, inlineValue] = arg.startsWith("--") ? arg.split("=", 2) : [arg, undefined];
    const readValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        console.error(`Missing value for ${flag}`);
        printSearchUsage();
        process.exit(1);
      }
      i++;
      return next;
    };

    if (flag === "--project") {
      project = readValue();
      continue;
    }
    if (flag === "--type") {
      type = readValue();
      continue;
    }
    if (flag === "--limit") {
      const parsed = Number.parseInt(readValue(), 10);
      if (Number.isNaN(parsed) || parsed < 1 || parsed > 200) {
        console.error("Invalid --limit value. Use an integer between 1 and 200.");
        process.exit(1);
      }
      limit = parsed;
      continue;
    }

    if (arg.startsWith("-")) {
      console.error(`Unknown search flag: ${arg}`);
      printSearchUsage();
      process.exit(1);
    }

    queryParts.push(arg);
  }

  if (project && !isValidProjectName(project)) {
    console.error(`Invalid project name: "${project}"`);
    process.exit(1);
  }

  let normalizedType: string | undefined;
  if (type) {
    normalizedType = SEARCH_TYPE_ALIASES[type.toLowerCase()] || type.toLowerCase();
    if (!SEARCH_TYPES.has(normalizedType)) {
      console.error(`Invalid --type value: "${type}"`);
      printSearchUsage();
      process.exit(1);
    }
  }

  const query = queryParts.join(" ").trim();
  if (!query && !project) {
    console.error("Provide a query, or pass --project to browse a project's indexed docs.");
    printSearchUsage();
    process.exit(1);
  }

  return {
    query,
    limit,
    project,
    type: normalizedType,
  };
}

export async function runCliCommand(command: string, args: string[]) {
  switch (command) {
    case "search":
      {
        const opts = parseSearchArgs(args);
        if (!opts) return;
        return handleSearch(opts);
      }
    case "hook-prompt":
      return handleHookPrompt();
    case "hook-session-start":
      return handleHookSessionStart();
    case "hook-stop":
      return handleHookStop();
    case "hook-context":
      return handleHookContext();
    case "add-learning":
      return handleAddLearning(args[0], args.slice(1).join(" "));
    case "extract-memories":
      return handleExtractMemories(args[0]);
    case "govern-memories":
      return handleGovernMemories(args[0]);
    case "pin-memory":
      return handlePinMemory(args[0], args.slice(1).join(" "));
    case "doctor":
      return handleDoctor(args);
    case "quality-feedback":
      return handleQualityFeedback(args);
    case "prune-memories":
      return handlePruneMemories(args);
    case "consolidate-memories":
      return handleConsolidateMemories(args);
    case "migrate-findings":
      return handleMigrateFindings(args);
    case "index-policy":
      return handleIndexPolicy(args);
    case "memory-policy":
      return handleMemoryPolicy(args);
    case "memory-workflow":
      return handleMemoryWorkflow(args);
    case "memory-access":
      return handleMemoryAccess(args);
    case "memory-ui":
      return handleMemoryUi(args);
    case "shell":
      return handleShell(args);
    case "update":
      return handleUpdate(args);
    case "config":
      return handleConfig(args);
    case "maintain":
      return handleMaintain(args);
    case "skill-list":
      return handleSkillList();
    case "backlog":
      return handleBacklogView();
    case "background-maintenance":
      return handleBackgroundMaintenance(args[0]);
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

interface GitContext {
  branch: string;
  changedFiles: Set<string>;
}

function runGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: EXEC_TIMEOUT_MS }).trim();
  } catch {
    return null;
  }
}

function isFeatureEnabled(envName: string, defaultValue: boolean = true): boolean {
  const raw = process.env[envName];
  if (!raw) return defaultValue;
  return !["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw || "", 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function shouldRetryGh(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err ?? "");
  return /(rate limit|secondary rate limit|timed out|ecconn|network|502|503|504|bad gateway|service unavailable)/i.test(msg);
}

async function runGhJson<T>(cwd: string, args: string[]): Promise<T | null> {
  if (!commandExists("gh")) return null;
  const retries = clampInt(process.env.CORTEX_GH_RETRIES, 2, 0, 5);
  const timeoutMs = clampInt(process.env.CORTEX_GH_TIMEOUT_MS, 10000, 1000, 60000);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const out = execFileSync("gh", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      }).trim();
      if (!out) return null;
      return JSON.parse(out) as T;
    } catch (err) {
      if (attempt >= retries || !shouldRetryGh(err)) return null;
      const backoffMs = 750 * (attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  return null;
}

function getGitContext(cwd?: string): GitContext | null {
  if (!cwd) return null;
  const branch = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch) return null;
  const changedFiles = new Set<string>();
  for (const changed of [
    runGit(cwd, ["diff", "--name-only"]),
    runGit(cwd, ["diff", "--name-only", "--cached"]),
  ]) {
    if (!changed) continue;
    for (const line of changed.split("\n").map((s) => s.trim()).filter(Boolean)) {
      changedFiles.add(line);
      const basename = path.basename(line);
      if (basename) changedFiles.add(basename);
    }
  }
  return { branch, changedFiles };
}

function branchTokens(branch: string): string[] {
  return branch
    .split(/[\/._-]/g)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 2 && !["main", "master", "feature", "fix", "bugfix", "hotfix"].includes(s));
}

function detectTaskIntent(prompt: string): "debug" | "review" | "build" | "docs" | "general" {
  const p = prompt.toLowerCase();
  if (/(bug|error|fix|broken|regression|fail|stack trace)/.test(p)) return "debug";
  if (/(review|audit|pr|pull request|nit|refactor)/.test(p)) return "review";
  if (/(build|deploy|release|ci|workflow|pipeline|test)/.test(p)) return "build";
  if (/(doc|readme|explain|guide|instruction)/.test(p)) return "docs";
  return "general";
}

function intentBoost(intent: string, docType: string): number {
  if (intent === "debug" && (docType === "learnings" || docType === "knowledge")) return 3;
  if (intent === "review" && (docType === "canonical" || docType === "changelog")) return 3;
  if (intent === "build" && (docType === "backlog" || docType === "knowledge")) return 2;
  if (intent === "docs" && (docType === "summary" || docType === "claude")) return 2;
  if (docType === "canonical") return 2;
  return 0;
}

function fileRelevanceBoost(filePath: string, changedFiles: Set<string>): number {
  if (changedFiles.size === 0) return 0;
  const normalized = filePath.replace(/\\/g, "/");
  for (const cf of changedFiles) {
    const n = cf.replace(/\\/g, "/");
    if (normalized.endsWith(n) || normalized.includes(`/${n}`)) return 3;
  }
  return 0;
}

function branchMatchBoost(content: string, branch: string | undefined): number {
  if (!branch) return 0;
  const text = content.toLowerCase();
  const tokens = branchTokens(branch);
  let score = 0;
  for (const t of tokens) {
    if (text.includes(t)) score += 1;
  }
  return Math.min(3, score);
}

function lowValuePenalty(content: string, docType: string): number {
  if (docType !== "learnings") return 0;
  const bullets = content.split("\n").filter((l) => l.startsWith("- "));
  if (bullets.length === 0) return 0;
  const low = bullets.filter((b) => /(fixed stuff|updated things|misc|temp|wip)/i.test(b) || b.length < 16).length;
  return low >= Math.ceil(bullets.length * 0.5) ? 2 : 0;
}

const RETRIEVAL_STOP_WORDS = STOP_WORDS;

function normalizeToken(token: string): string {
  let t = token.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (t.length > 4 && t.endsWith("ing")) t = t.slice(0, -3);
  else if (t.length > 3 && t.endsWith("ed")) t = t.slice(0, -2);
  else if (t.length > 3 && t.endsWith("es")) t = t.slice(0, -2);
  else if (t.length > 2 && t.endsWith("s")) t = t.slice(0, -1);
  return t;
}

function tokenizeForOverlap(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, " ")
    .split(/\s+/)
    .map(normalizeToken)
    .filter((t) => t.length > 1 && !RETRIEVAL_STOP_WORDS.has(t));
  return [...new Set(tokens)].slice(0, 24);
}

function overlapScore(queryTokens: string[], content: string): number {
  if (!queryTokens.length) return 0;
  const contentTokens = new Set(tokenizeForOverlap(content));
  if (!contentTokens.size) return 0;
  let matched = 0;
  for (const t of queryTokens) {
    if (contentTokens.has(t)) matched += 1;
  }
  return matched / Math.max(1, Math.min(queryTokens.length, 10));
}

function mergeUniqueRows(primary: any[][] | null, secondary: any[][]): any[][] | null {
  if (!primary || !primary.length) return secondary.length ? secondary : null;
  const seen = new Set(primary.map((r) => String((r as string[])[4] || `${(r as string[])[0]}/${(r as string[])[1]}`)));
  for (const row of secondary) {
    const key = String((row as string[])[4] || `${(row as string[])[0]}/${(row as string[])[1]}`);
    if (seen.has(key)) continue;
    seen.add(key);
    primary.push(row);
  }
  return primary;
}

function semanticFallbackRows(db: any, prompt: string, project?: string | null): any[][] {
  const queryTokens = tokenizeForOverlap(prompt);
  if (!queryTokens.length) return [];
  const sampleLimit = project ? 180 : 260;
  const rows = project
    ? queryRows(
      db,
      "SELECT project, filename, type, content, path FROM docs WHERE project = ? LIMIT ?",
      [project, sampleLimit]
    ) || []
    : queryRows(
      db,
      "SELECT project, filename, type, content, path FROM docs LIMIT ?",
      [sampleLimit]
    ) || [];

  const scored = rows
    .map((row) => {
      const [proj, file, docType, content, filePath] = row as string[];
      const corpus = `${proj} ${file} ${docType} ${filePath}\n${content.slice(0, 5000)}`;
      const score = overlapScore(queryTokens, corpus);
      return { row, score };
    })
    .filter((x) => x.score >= 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((x) => x.row);

  return scored;
}

function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function compactSnippet(snippet: string, maxLines: number, maxChars: number): string {
  const lines = snippet
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .slice(0, Math.max(1, maxLines));
  let out = lines.join("\n");
  if (out.length > maxChars) out = out.slice(0, Math.max(24, maxChars - 1)).trimEnd() + "…";
  return out;
}

interface SessionMetric {
  prompts: number;
  keys: Record<string, number>;
  lastChangedCount: number;
  lastKeys: string[];
  lastSeen?: string;
}

function parseSessionMetrics(cortexPathLocal: string): Record<string, SessionMetric> {
  const file = path.join(cortexPathLocal, ".governance", "session-metrics.json");
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, SessionMetric>;
  } catch {
    return {};
  }
}

function writeSessionMetrics(cortexPathLocal: string, data: Record<string, SessionMetric>) {
  const file = path.join(cortexPathLocal, ".governance", "session-metrics.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

function qualityMarkers(cortexPathLocal: string): { done: string; lock: string } {
  const today = new Date().toISOString().slice(0, 10);
  return {
    done: path.join(cortexPathLocal, `.quality-${today}`),
    lock: path.join(cortexPathLocal, `.quality-${today}.lock`),
  };
}

function scheduleBackgroundMaintenance(cortexPathLocal: string, project?: string): boolean {
  if (!isFeatureEnabled("CORTEX_FEATURE_DAILY_MAINTENANCE", true)) return false;
  const markers = qualityMarkers(cortexPathLocal);
  if (fs.existsSync(markers.done)) return false;
  if (fs.existsSync(markers.lock)) {
    try {
      const ageMs = Date.now() - fs.statSync(markers.lock).mtimeMs;
      if (ageMs <= 2 * 60 * 60 * 1000) return false;
      fs.unlinkSync(markers.lock);
    } catch {
      return false;
    }
  }

  const distEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
  let spawnArgs: string[] | null = null;
  if (fs.existsSync(distEntry)) {
    spawnArgs = [distEntry, "background-maintenance"];
  } else {
    const sourceEntry = process.argv.find((a) => /[\\/]index\.(ts|js)$/.test(a) && fs.existsSync(a));
    const runner = process.argv[1];
    if (sourceEntry && runner) {
      spawnArgs = [runner, sourceEntry, "background-maintenance"];
    }
  }
  if (!spawnArgs) return false;

  try {
    fs.writeFileSync(
      markers.lock,
      JSON.stringify({
        startedAt: new Date().toISOString(),
        project: project || "all",
        pid: process.pid,
      }) + "\n"
    );
    if (project) spawnArgs.push(project);
    const child = spawn(process.execPath, spawnArgs, {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        CORTEX_PATH: cortexPathLocal,
        CORTEX_PROFILE: profile,
      },
    });
    child.unref();
    return true;
  } catch {
    try { fs.unlinkSync(markers.lock); } catch { /* best effort */ }
    return false;
  }
}

async function handleSearch(opts: SearchOptions) {
  const db = await buildIndex(cortexPath, profile);

  try {
    let sql = "SELECT project, filename, type, content, path FROM docs";
    const where: string[] = [];
    const params: Array<string | number> = [];

    if (opts.query) {
      const safeQuery = buildRobustFtsQuery(opts.query);
      if (!safeQuery) {
        console.error("Query empty after sanitization.");
        process.exit(1);
      }
      where.push("docs MATCH ?");
      params.push(safeQuery);
    }
    if (opts.project) {
      where.push("project = ?");
      params.push(opts.project);
    }
    if (opts.type) {
      where.push("type = ?");
      params.push(opts.type);
    }

    if (where.length > 0) {
      sql += ` WHERE ${where.join(" AND ")}`;
    }
    sql += opts.query ? " ORDER BY rank LIMIT ?" : " ORDER BY project, type, filename LIMIT ?";
    params.push(opts.limit);

    const rows = queryRows(db, sql, params);

    if (!rows) {
      const scope = [
        opts.query ? `query "${opts.query}"` : undefined,
        opts.project ? `project "${opts.project}"` : undefined,
        opts.type ? `type "${opts.type}"` : undefined,
      ].filter(Boolean).join(", ");
      console.log(scope ? `No results found for ${scope}.` : "No results found.");
      process.exit(0);
    }

    if (opts.project && !opts.query) {
      console.log(`Browsing ${rows.length} document(s) in project "${opts.project}"`);
      if (opts.type) console.log(`Type filter: ${opts.type}`);
      console.log();
    }

    for (const row of rows) {
      const [project, filename, docType, content] = row as string[];
      const snippet = extractSnippet(content, opts.query, 7);
      console.log(`[${project}/${filename}] (${docType})`);
      console.log(snippet);
      console.log();
    }
  } catch (err: any) {
    console.error(`Search error: ${err.message}`);
    process.exit(1);
  }
}

function runBestEffortGit(args: string[], cwd: string): { ok: boolean; output?: string; error?: string } {
  try {
    const output = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: EXEC_TIMEOUT_MS,
    }).trim();
    return { ok: true, output };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

async function handleHookSessionStart() {
  const startedAt = new Date().toISOString();
  if (!getHooksEnabledPreference(cortexPath)) {
    updateRuntimeHealth(cortexPath, { lastSessionStartAt: startedAt });
    appendAuditLog(cortexPath, "hook_session_start", "status=disabled");
    return;
  }

  const pull = runBestEffortGit(["pull", "--rebase", "--quiet"], cortexPath);
  const doctor = await runDoctor(cortexPath, false);
  const maintenanceScheduled = scheduleBackgroundMaintenance(cortexPath);

  updateRuntimeHealth(cortexPath, { lastSessionStartAt: startedAt });
  appendAuditLog(
    cortexPath,
    "hook_session_start",
    `pull=${pull.ok ? "ok" : "fail"} doctor=${doctor.ok ? "ok" : "issues"} maintenance=${maintenanceScheduled ? "scheduled" : "skipped"}`
  );
}

async function handleHookStop() {
  const now = new Date().toISOString();
  if (!getHooksEnabledPreference(cortexPath)) {
    updateRuntimeHealth(cortexPath, {
      lastStopAt: now,
      lastAutoSave: { at: now, status: "clean", detail: "hooks disabled by preference" },
    });
    appendAuditLog(cortexPath, "hook_stop", "status=disabled");
    return;
  }

  const status = runBestEffortGit(["status", "--porcelain"], cortexPath);
  if (!status.ok) {
    updateRuntimeHealth(cortexPath, {
      lastStopAt: now,
      lastAutoSave: { at: now, status: "error", detail: status.error || "git status failed" },
    });
    appendAuditLog(cortexPath, "hook_stop", `status=error detail=${JSON.stringify(status.error || "git status failed")}`);
    return;
  }

  if (!status.output) {
    updateRuntimeHealth(cortexPath, {
      lastStopAt: now,
      lastAutoSave: { at: now, status: "clean", detail: "no changes" },
    });
    appendAuditLog(cortexPath, "hook_stop", "status=clean");
    return;
  }

  const add = runBestEffortGit(["add", "-A"], cortexPath);
  const commit = add.ok ? runBestEffortGit(["commit", "-m", "auto-save cortex"], cortexPath) : { ok: false, error: add.error };
  if (!add.ok || !commit.ok) {
    updateRuntimeHealth(cortexPath, {
      lastStopAt: now,
      lastAutoSave: {
        at: now,
        status: "error",
        detail: add.error || commit.error || "git add/commit failed",
      },
    });
    appendAuditLog(cortexPath, "hook_stop", `status=error detail=${JSON.stringify(add.error || commit.error || "git add/commit failed")}`);
    return;
  }

  const remotes = runBestEffortGit(["remote"], cortexPath);
  if (!remotes.ok || !remotes.output) {
    updateRuntimeHealth(cortexPath, {
      lastStopAt: now,
      lastAutoSave: { at: now, status: "saved-local", detail: "commit created; no remote configured" },
    });
    appendAuditLog(cortexPath, "hook_stop", "status=saved-local");
    return;
  }

  const push = runBestEffortGit(["push"], cortexPath);
  if (push.ok) {
    updateRuntimeHealth(cortexPath, {
      lastStopAt: now,
      lastAutoSave: { at: now, status: "saved-pushed", detail: "commit pushed" },
    });
    appendAuditLog(cortexPath, "hook_stop", "status=saved-pushed");
    return;
  }

  updateRuntimeHealth(cortexPath, {
    lastStopAt: now,
    lastAutoSave: { at: now, status: "saved-local", detail: push.error || "push failed" },
  });
  appendAuditLog(cortexPath, "hook_stop", `status=saved-local detail=${JSON.stringify(push.error || "push failed")}`);
}

async function handleHookPrompt() {
  let input = "";
  try {
    input = fs.readFileSync(0, "utf-8");
  } catch {
    process.exit(0);
  }

  let prompt: string;
  let cwd: string | undefined;
  let sessionId: string | undefined;
  try {
    const data = JSON.parse(input);
    prompt = data.prompt || "";
    cwd = data.cwd;
    sessionId = data.session_id;
  } catch {
    process.exit(0);
  }

  if (!prompt.trim()) process.exit(0);

  if (!getHooksEnabledPreference(cortexPath)) {
    appendAuditLog(cortexPath, "hook_prompt", "status=disabled");
    process.exit(0);
  }

  updateRuntimeHealth(cortexPath, { lastPromptAt: new Date().toISOString() });

  const keywords = extractKeywords(prompt);
  if (!keywords) process.exit(0);

  debugLog(`hook-prompt keywords: "${keywords}"`);

  const db = await buildIndex(cortexPath, profile);
  const gitCtx = getGitContext(cwd);
  const intent = detectTaskIntent(prompt);

  // Detect project from cwd to boost relevant results
  const detectedProject = cwd ? detectProject(cortexPath, cwd, profile) : null;
  if (detectedProject) debugLog(`Detected project: ${detectedProject}`);

  const safeQuery = buildRobustFtsQuery(keywords);
  if (!safeQuery) process.exit(0);

  try {
    // If we know the project, search within it first, then fall back to global
    let rows: any[][] | null = null;

    if (detectedProject) {
      rows = queryRows(
        db,
        "SELECT project, filename, type, content, path FROM docs WHERE docs MATCH ? AND project = ? ORDER BY rank LIMIT 7",
        [safeQuery, detectedProject]
      );
    }

    // Fall back to global search if no project-specific results or we got too few.
    if (!rows || rows.length < 3) {
      const globalRows = queryRows(
        db,
        "SELECT project, filename, type, content, path FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT 10",
        [safeQuery]
      );
      rows = mergeUniqueRows(rows, globalRows || []);
    }

    // Fallback: overlap-based retrieval when FTS misses paraphrases.
    if (!rows || rows.length < 2) {
      const semanticRows = semanticFallbackRows(db, `${prompt}\n${keywords}`, detectedProject);
      rows = mergeUniqueRows(rows, semanticRows);
    }

    if (!rows || !rows.length) process.exit(0);

    const policy = getMemoryPolicy(cortexPath);
    const memoryTtlDays = Number.parseInt(
      process.env.CORTEX_MEMORY_TTL_DAYS || String(policy.ttlDays),
      10
    );
    rows = rows.map((row) => {
      const [project, filename, docType, content, filePath] = row as string[];
      if (docType !== "learnings") return row;
      const trust = filterTrustedLearningsDetailed(content, {
        ttlDays: Number.isNaN(memoryTtlDays) ? policy.ttlDays : memoryTtlDays,
        minConfidence: policy.minInjectConfidence,
        decay: policy.decay,
      });
      if (trust.issues.length > 0) {
        const stale = trust.issues.filter((i) => i.reason === "stale").map((i) => i.bullet);
        const conflicts = trust.issues.filter((i) => i.reason === "invalid_citation").map((i) => i.bullet);
        if (stale.length) appendMemoryQueue(cortexPath, project, "Stale", stale);
        if (conflicts.length) appendMemoryQueue(cortexPath, project, "Conflicts", conflicts);
        appendAuditLog(
          cortexPath,
          "trust_filter",
          `project=${project} stale=${stale.length} invalid_citation=${conflicts.length}`
        );
      }
      const trusted = trust.content;
      return [project, filename, docType, trusted, filePath];
    }).filter((row) => {
      const [, , docType, content] = row as string[];
      return docType !== "learnings" || Boolean((content as string).trim());
    });

    if (!rows.length) process.exit(0);

    // Keep retrieval branch/project-local whenever possible.
    if (detectedProject) {
      const localByType = new Set(
        rows
          .filter((r) => (r as string[])[0] === detectedProject)
          .map((r) => (r as string[])[2])
      );
      rows = rows.filter((r) => {
        const [project, , type] = r as string[];
        if (project === detectedProject) return true;
        return !localByType.has(type);
      });
    }

    // Bring canonical memories from detected project into ranking pool.
    if (detectedProject) {
      const canonicalRows = queryRows(
        db,
        "SELECT project, filename, type, content, path FROM docs WHERE project = ? AND type = 'canonical' LIMIT 1",
        [detectedProject]
      );
      if (canonicalRows) rows = [...canonicalRows, ...rows];
    }

    // Automatic extraction from PR/review/CI/issues once per session+project.
    if (isFeatureEnabled("CORTEX_FEATURE_AUTO_EXTRACT", true) && sessionId && detectedProject && cwd) {
      const marker = path.join(cortexPath, `.extracted-${sessionId}-${detectedProject}`);
      if (!fs.existsSync(marker)) {
        try {
          await handleExtractMemories(detectedProject, cwd, true);
          fs.writeFileSync(marker, "");
        } catch {
          // best effort
        }
      }
    }

    // Recency boost: for learnings rows, extract the most recent date header and sort newer first.
    // Non-learnings rows keep their FTS5 rank order at the front.
    function mostRecentDate(content: string): string {
      const matches = content.match(/^## (\d{4}-\d{2}-\d{2})/mg);
      if (!matches || matches.length === 0) return "0000-00-00";
      return matches.map(m => m.slice(3)).sort().reverse()[0];
    }

    rows = [...rows].sort((a, b) => {
      const [, , typeA, contentA, pathA] = a as string[];
      const [, , typeB, contentB, pathB] = b as string[];
      const isLearningsA = typeA === "learnings";
      const isLearningsB = typeB === "learnings";
      // Non-learnings rank above learnings when scores are equal
      if (isLearningsA !== isLearningsB) return isLearningsA ? 1 : -1;
      // Both learnings: sort by most recent date descending
      if (isLearningsA && isLearningsB) {
        const byDate = mostRecentDate(contentB).localeCompare(mostRecentDate(contentA));
        if (byDate !== 0) return byDate;
      }

      const intentDelta = intentBoost(intent, typeB) - intentBoost(intent, typeA);
      if (intentDelta !== 0) return intentDelta;

      const changedFiles = gitCtx?.changedFiles || new Set<string>();
      const fileDelta = fileRelevanceBoost(pathB, changedFiles) - fileRelevanceBoost(pathA, changedFiles);
      if (fileDelta !== 0) return fileDelta;

      const branchDelta = branchMatchBoost(contentB, gitCtx?.branch) - branchMatchBoost(contentA, gitCtx?.branch);
      if (branchDelta !== 0) return branchDelta;

      const keyA = memoryScoreKey((a as string[])[0], (a as string[])[1], contentA);
      const keyB = memoryScoreKey((b as string[])[0], (b as string[])[1], contentB);
      const qualityDelta = getMemoryQualityMultiplier(cortexPath, keyB) - getMemoryQualityMultiplier(cortexPath, keyA);
      if (qualityDelta !== 0) return qualityDelta;

      const penaltyDelta = lowValuePenalty(contentA, typeA) - lowValuePenalty(contentB, typeB);
      if (penaltyDelta !== 0) return penaltyDelta;

      return 0;
    });

    // Keep a wider candidate set before applying token-budget selection.
    rows = rows.slice(0, 8);

    // Skip backlog results unless the user's intent is task/build-related (#167).
    // Backlogs are large and rarely relevant to general prompts. Users can still
    // access them explicitly via get_backlog().
    if (intent !== "build") {
      rows = rows.filter((r) => (r as string[])[2] !== "backlog");
      if (!rows.length) process.exit(0);
    }

    // If we have changed files, drop unrelated rows except high-priority docs.
    if (gitCtx && gitCtx.changedFiles.size > 0) {
      rows = rows.filter((r) => {
        const [, , type, , file] = r as string[];
        if (["summary", "canonical", "claude"].includes(type)) return true;
        return fileRelevanceBoost(file, gitCtx.changedFiles) > 0 || branchMatchBoost((r as string[])[3], gitCtx.branch) > 0;
      });
      if (!rows.length) process.exit(0);
    }

    const tokenBudget = Number.parseInt(process.env.CORTEX_CONTEXT_TOKEN_BUDGET || "550", 10);
    const snippetLineBudget = Number.parseInt(process.env.CORTEX_CONTEXT_SNIPPET_LINES || "6", 10);
    const snippetCharBudget = Number.parseInt(process.env.CORTEX_CONTEXT_SNIPPET_CHARS || "520", 10);
    const safeTokenBudget = Number.isNaN(tokenBudget) ? 550 : Math.max(180, tokenBudget);
    const safeLineBudget = Number.isNaN(snippetLineBudget) ? 6 : Math.max(2, snippetLineBudget);
    const safeCharBudget = Number.isNaN(snippetCharBudget) ? 520 : Math.max(120, snippetCharBudget);

    const selected: Array<{ row: any[]; snippet: string; key: string }> = [];
    let usedTokens = 36; // status and wrapper overhead
    for (const row of rows) {
      const [project, filename, , content] = row as string[];
      let snippet = compactSnippet(extractSnippet(content, keywords, 8), safeLineBudget, safeCharBudget);
      if (!snippet.trim()) continue;
      let est = approximateTokens(snippet) + 14;
      if (selected.length > 0 && usedTokens + est > safeTokenBudget) continue;
      if (selected.length === 0 && usedTokens + est > safeTokenBudget) {
        snippet = compactSnippet(snippet, 3, Math.floor(safeCharBudget * 0.55));
        est = approximateTokens(snippet) + 14;
      }
      const key = memoryScoreKey(project, filename, snippet);
      selected.push({ row, snippet, key });
      usedTokens += est;
      if (selected.length >= 3) break;
    }
    if (!selected.length) process.exit(0);
    const projectLabel = detectedProject ? ` · ${detectedProject}` : "";
    const resultLabel = selected.length === 1 ? "1 result" : `${selected.length} results`;
    const statusLine = `◆ cortex${projectLabel} · ${resultLabel}`;

    const parts: string[] = [statusLine, "<cortex-context>"];
    for (const injected of selected) {
      const [project, filename, docType] = injected.row as string[];
      const { snippet, key } = injected;
      recordMemoryInjection(cortexPath, key, sessionId);
      parts.push(`[${project}/${filename}] (${docType})`);
      parts.push(snippet);
      parts.push("");
    }
    parts.push("</cortex-context>");
    const changedCount = gitCtx?.changedFiles.size ?? 0;
    if (gitCtx) {
      const fileHits = selected.filter((r) => fileRelevanceBoost((r.row as string[])[4], gitCtx.changedFiles) > 0).length;
      const branchHits = selected.filter((r) => branchMatchBoost((r.row as string[])[3], gitCtx.branch) > 0).length;
      parts.push(
        `◆ cortex · trace: intent=${intent}; reasons=file:${fileHits},branch:${branchHits}; branch=${gitCtx.branch}; changed_files=${changedCount}; tokens≈${usedTokens}/${safeTokenBudget}`
      );
    } else {
      parts.push(`◆ cortex · trace: intent=${intent}; reasons=intent-only; tokens≈${usedTokens}/${safeTokenBudget}`);
    }

    if (sessionId) {
      const metrics = parseSessionMetrics(cortexPath);
      if (!metrics[sessionId]) metrics[sessionId] = { prompts: 0, keys: {}, lastChangedCount: 0, lastKeys: [] };
      metrics[sessionId].prompts += 1;
      const injectedKeys: string[] = [];
      for (const injected of selected) {
        injectedKeys.push(injected.key);
        const key = injected.key;
        const seen = metrics[sessionId].keys[key] || 0;
        metrics[sessionId].keys[key] = seen + 1;
        if (seen >= 1) recordMemoryFeedback(cortexPath, key, "reprompt");
      }

      const prevChanged = metrics[sessionId].lastChangedCount || 0;
      const prevKeys = metrics[sessionId].lastKeys || [];
      if (changedCount > prevChanged) {
        for (const prevKey of prevKeys) {
          recordMemoryFeedback(cortexPath, prevKey, "helpful");
        }
      }
      metrics[sessionId].lastChangedCount = changedCount;
      metrics[sessionId].lastKeys = injectedKeys;
      metrics[sessionId].lastSeen = new Date().toISOString();

      // Prune sessions older than 30 days
      const thirtyDaysAgo = Date.now() - 30 * 86400000;
      for (const sid of Object.keys(metrics)) {
        const seen = metrics[sid].lastSeen;
        if (seen && new Date(seen).getTime() < thirtyDaysAgo) {
          delete metrics[sid];
        }
      }

      writeSessionMetrics(cortexPath, metrics);
    }

    // Periodic quality maintenance (once/day) runs in detached background mode.
    scheduleBackgroundMaintenance(cortexPath);

    // Check for consolidation needs once per session
    const noticeFile = sessionId ? path.join(cortexPath, `.noticed-${sessionId}`) : null;
    const alreadyNoticed = noticeFile ? fs.existsSync(noticeFile) : false;

    if (!alreadyNoticed) {
      // Clean up stale notice and extraction marker files (older than 24h)
      try {
        const cutoff = Date.now() - 86400000;
        for (const f of fs.readdirSync(cortexPath)) {
          if (!f.startsWith(".noticed-") && !f.startsWith(".extracted-")) continue;
          const fp = path.join(cortexPath, f);
          if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
        }
      } catch { /* best effort */ }

      const needed = checkConsolidationNeeded(cortexPath, profile);
      if (needed.length > 0) {
        const notices = needed.map(n => {
          const since = n.lastConsolidated ? ` since ${n.lastConsolidated}` : "";
          return `  ${n.project}: ${n.entriesSince} new learnings${since}`;
        });
        parts.push(`◈ cortex · consolidation ready`);
        parts.push(`<cortex-notice>`);
        parts.push(`Learnings ready for consolidation:`);
        parts.push(notices.join("\n"));
        parts.push(`Run /cortex-consolidate when ready.`);
        parts.push(`</cortex-notice>`);
      }

      if (noticeFile) {
        try { fs.writeFileSync(noticeFile, ""); } catch { /* best effort */ }
      }
    }

    console.log(parts.join("\n"));
  } catch (err: any) {
    process.stderr.write("cortex hook-prompt error: " + String(err?.message || err) + "\n");
    process.exit(0);
  }
}

async function handleHookContext() {
  if (!getHooksEnabledPreference(cortexPath)) {
    process.exit(0);
  }

  // SessionStart hook provides stdin JSON with cwd and source
  let cwd = process.cwd();
  try {
    const input = fs.readFileSync(0, "utf-8");
    const data = JSON.parse(input);
    if (data.cwd) cwd = data.cwd;
  } catch {
    // No stdin or invalid JSON, fall back to process.cwd()
  }

  const project = detectProject(cortexPath, cwd, profile);

  const db = await buildIndex(cortexPath, profile);
  const contextLabel = project ? `◆ cortex · ${project} · context` : `◆ cortex · context`;
  const parts: string[] = [contextLabel, "<cortex-context>"];

  if (project) {
    // Project-specific context
    const summaryRow = queryRows(db, "SELECT content FROM docs WHERE project = ? AND type = 'summary'", [project]);
    if (summaryRow) {
      parts.push(`# ${project}`);
      parts.push(summaryRow[0][0] as string);
      parts.push("");
    }

    const learningsRow = queryRows(
      db,
      "SELECT content FROM docs WHERE project = ? AND type = 'learnings'",
      [project]
    );
    if (learningsRow) {
      const content = learningsRow[0][0] as string;
      // Get the last 10 learnings
      const bullets = content.split("\n").filter(l => l.startsWith("- ")).slice(0, 10);
      if (bullets.length > 0) {
        parts.push("## Recent learnings");
        parts.push(bullets.join("\n"));
        parts.push("");
      }
    }

    const backlogRow = queryRows(
      db,
      "SELECT content FROM docs WHERE project = ? AND type = 'backlog'",
      [project]
    );
    if (backlogRow) {
      const content = backlogRow[0][0] as string;
      const activeItems = content.split("\n").filter(l => l.startsWith("- ")).slice(0, 5);
      if (activeItems.length > 0) {
        parts.push("## Active backlog");
        parts.push(activeItems.join("\n"));
        parts.push("");
      }
    }
  } else {
    // No project detected, show general overview
    const projectRows = queryRows(db, "SELECT DISTINCT project FROM docs ORDER BY project", []);
    if (projectRows) {
      parts.push("# Cortex projects");
      parts.push(projectRows.map(r => `- ${r[0]}`).join("\n"));
      parts.push("");
    }
  }

  parts.push("</cortex-context>");

  // Only output if we have actual content
  if (parts.length > 2) {
    console.log(parts.join("\n"));
  }
}

async function handleAddLearning(project: string, learning: string) {
  if (!project || !learning) {
    console.error('Usage: cortex add-learning <project> "<insight>"');
    process.exit(1);
  }

  const result = addLearningToFile(cortexPath, project, learning);
  console.log(result);
}

function inferProject(arg?: string): string | null {
  if (arg) return arg;
  return detectProject(cortexPath, process.cwd(), profile);
}

function parseGitLogRecords(cwd: string, days: number): Array<{ hash: string; subject: string; body: string }> {
  const fmt = "%H%x1f%s%x1f%b%x1e";
  const raw = runGit(cwd, ["log", `--since=${days} days ago`, "--first-parent", `--pretty=format:${fmt}`]) || "";
  const records: Array<{ hash: string; subject: string; body: string }> = [];
  for (const rec of raw.split("\x1e")) {
    const trimmed = rec.trim();
    if (!trimmed) continue;
    const [hash, subject, body] = trimmed.split("\x1f");
    if (!hash || !subject) continue;
    records.push({ hash, subject, body: body || "" });
  }
  return records;
}

interface GhPr {
  number: number;
  title: string;
  body?: string;
  mergeCommit?: { oid?: string };
  files?: Array<{ path?: string }>;
  comments?: Array<{ body?: string }>;
  reviews?: Array<{ body?: string; state?: string }>;
}

interface GhRun {
  databaseId?: number;
  displayTitle?: string;
  workflowName?: string;
  headSha?: string;
}

interface GhIssue {
  number: number;
  title: string;
  body?: string;
}

interface Candidate {
  text: string;
  score: number;
  commit?: string;
  file?: string;
}

function ghCachePath(repoRoot: string): string {
  const repoKey = path.basename(repoRoot).replace(/[^a-zA-Z0-9_-]/g, "_");
  const dateKey = new Date().toISOString().slice(0, 10);
  return path.join(os.tmpdir(), `cortex-gh-cache-${repoKey}-${dateKey}.json`);
}

const GH_CACHE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

async function mineGithubCandidates(repoRoot: string): Promise<Candidate[]> {
  const cacheFile = ghCachePath(repoRoot);
  try {
    const stat = fs.statSync(cacheFile);
    if (Date.now() - stat.mtimeMs < GH_CACHE_MAX_AGE_MS) {
      return JSON.parse(fs.readFileSync(cacheFile, "utf8")) as Candidate[];
    }
  } catch {}

  const candidates: Candidate[] = [];
  const prLimit = clampInt(process.env.CORTEX_GH_PR_LIMIT, 40, 5, 200);
  const runLimit = clampInt(process.env.CORTEX_GH_RUN_LIMIT, 25, 5, 200);
  const issueLimit = clampInt(process.env.CORTEX_GH_ISSUE_LIMIT, 25, 5, 200);

  const prs = await runGhJson<GhPr[]>(repoRoot, [
    "pr",
    "list",
    "--state",
    "merged",
    "--limit",
    String(prLimit),
    "--json",
    "number,title,body,mergeCommit,files,comments,reviews",
  ]) || [];
  for (const pr of prs) {
    const text = `PR #${pr.number}: ${pr.title}`;
    const body = (pr.body || "").toLowerCase();
    const commentBlob = [
      ...(pr.comments || []).map((c) => c.body || ""),
      ...(pr.reviews || []).map((r) => r.body || ""),
    ].join("\n").toLowerCase();
    let score = 0.65;
    if (/(fix|workaround|must|avoid|regression|incident|root cause|migration)/.test(body)) score += 0.2;
    if (/(review|comment|nit|requested changes)/.test(body + "\n" + commentBlob)) score += 0.1;
    if (/(must|should|avoid|required|don't|do not)/.test(commentBlob)) score += 0.08;
    candidates.push({
      text,
      score: Math.min(0.98, score),
      commit: pr.mergeCommit?.oid,
      file: pr.files?.find((f) => f.path)?.path,
    });
  }

  const runs = await runGhJson<GhRun[]>(repoRoot, [
    "run",
    "list",
    "--status",
    "failure",
    "--limit",
    String(runLimit),
    "--json",
    "databaseId,displayTitle,workflowName,headSha",
  ]) || [];
  for (const run of runs) {
    const title = run.displayTitle || run.workflowName || "CI failure";
    const text = `CI failure pattern: ${title}`;
    candidates.push({
      text,
      score: 0.62,
      commit: run.headSha,
    });
  }

  const issues = await runGhJson<GhIssue[]>(repoRoot, [
    "issue",
    "list",
    "--state",
    "all",
    "--limit",
    String(issueLimit),
    "--json",
    "number,title,body",
  ]) || [];
  for (const issue of issues) {
    const body = (issue.body || "").toLowerCase();
    if (!/(bug|regression|incident|outage|postmortem|fix)/.test(body) && !/(bug|regression|incident)/.test(issue.title.toLowerCase())) {
      continue;
    }
    const text = `Issue #${issue.number}: ${issue.title}`;
    candidates.push({ text, score: 0.58 });
  }

  try {
    fs.writeFileSync(cacheFile, JSON.stringify(candidates));
  } catch {}

  return candidates;
}

function scoreMemoryCandidate(subject: string, body: string): { score: number; text: string } | null {
  const s = `${subject}\n${body}`.toLowerCase();
  const mergedPr = /merge pull request #\d+/.test(s);
  const ci = /(ci|workflow|pipeline|flake|test fail|build fail)/.test(s);
  const review = /(review|requested changes|address comments|nit|follow-up)/.test(s);
  const learningSignal = /(fix|workaround|must|avoid|regression|root cause|postmortem|incident|retry|timeout)/.test(s);

  let score = 0.35;
  if (mergedPr) score += 0.2;
  if (ci) score += 0.2;
  if (review) score += 0.1;
  if (learningSignal) score += 0.25;
  if (subject.length > 20) score += 0.05;
  if (score < 0.5) return null;

  const cleaned = subject
    .replace(/^merge pull request #\d+\s*from\s+\S+\s*/i, "")
    .replace(/^fix:\s*/i, "")
    .trim();
  const text = cleaned ? cleaned[0].toUpperCase() + cleaned.slice(1) : subject;
  return { score: Math.min(score, 0.99), text };
}

async function handleExtractMemories(projectArg?: string, cwdArg?: string, silent: boolean = false) {
  const project = inferProject(projectArg);
  if (!project) {
    if (!silent) console.error("Usage: cortex extract-memories <project>");
    if (!silent) process.exit(1);
    return;
  }

  const repoRoot = runGit(cwdArg || process.cwd(), ["rev-parse", "--show-toplevel"]);
  if (!repoRoot) {
    if (!silent) console.error("extract-memories must run from inside a git repository.");
    if (!silent) process.exit(1);
    return;
  }

  const days = Number.parseInt(process.env.CORTEX_MEMORY_EXTRACT_WINDOW_DAYS || "30", 10);
  const threshold = Number.parseFloat(process.env.CORTEX_MEMORY_AUTO_ACCEPT || String(getMemoryPolicy(cortexPath).autoAcceptThreshold));
  const records = parseGitLogRecords(repoRoot, Number.isNaN(days) ? 30 : days);
  const ghCandidates = await mineGithubCandidates(repoRoot);

  let accepted = 0;
  let queued = 0;
  for (const rec of records) {
    const candidate = scoreMemoryCandidate(rec.subject, rec.body);
    if (!candidate) continue;
    const line = `${candidate.text} (source commit ${rec.hash.slice(0, 8)})`;
    if (candidate.score >= threshold) {
      addLearningToFile(cortexPath, project, line, {
        repo: repoRoot,
        commit: rec.hash,
      });
      accepted++;
    } else {
      queued += appendMemoryQueue(cortexPath, project, "Review", [`[confidence ${candidate.score.toFixed(2)}] ${line}`]);
    }
  }

  for (const c of ghCandidates) {
    const line = `${c.text}${c.commit ? ` (source commit ${c.commit.slice(0, 8)})` : ""}`;
    if (c.text.startsWith("CI failure pattern:")) {
      const key = memoryScoreKey(project, "LEARNINGS.md", line);
      recordMemoryFeedback(cortexPath, key, "regression");
    }
    if (c.score >= threshold) {
      addLearningToFile(cortexPath, project, line, {
        repo: repoRoot,
        commit: c.commit,
        file: c.file,
      });
      accepted++;
    } else {
      queued += appendMemoryQueue(cortexPath, project, "Review", [`[confidence ${c.score.toFixed(2)}] ${line}`]);
    }
  }

  appendAuditLog(cortexPath, "extract_memories", `project=${project} accepted=${accepted} queued=${queued} window_days=${days}`);
  if (!silent) console.log(`Extracted memory candidates for ${project}: accepted=${accepted}, queued=${queued}, window=${days}d`);
}

interface GovernanceSummary {
  projects: number;
  staleCount: number;
  conflictCount: number;
  reviewCount: number;
}

async function handleGovernMemories(projectArg?: string, silent: boolean = false): Promise<GovernanceSummary> {
  const policy = getMemoryPolicy(cortexPath);
  const ttlDays = Number.parseInt(process.env.CORTEX_MEMORY_TTL_DAYS || String(policy.ttlDays), 10);
  const projects = projectArg
    ? [projectArg]
    : getProjectDirs(cortexPath, profile).map((p) => path.basename(p)).filter((p) => p !== "global");

  let staleCount = 0;
  let conflictCount = 0;
  let reviewCount = 0;

  for (const project of projects) {
    const learningsPath = path.join(cortexPath, project, "LEARNINGS.md");
    if (!fs.existsSync(learningsPath)) continue;
    const content = fs.readFileSync(learningsPath, "utf8");
    const trust = filterTrustedLearningsDetailed(content, {
      ttlDays: Number.isNaN(ttlDays) ? policy.ttlDays : ttlDays,
      minConfidence: policy.minInjectConfidence,
      decay: policy.decay,
    });

    const stale = trust.issues.filter((i) => i.reason === "stale").map((i) => i.bullet);
    const conflicts = trust.issues.filter((i) => i.reason === "invalid_citation").map((i) => i.bullet);
    staleCount += appendMemoryQueue(cortexPath, project, "Stale", stale);
    conflictCount += appendMemoryQueue(cortexPath, project, "Conflicts", conflicts);

    const lowValue = content.split("\n")
      .filter((l) => l.startsWith("- "))
      .filter((l) => /(fixed stuff|updated things|misc|temp|wip|quick note)/i.test(l) || l.length < 16);
    reviewCount += appendMemoryQueue(cortexPath, project, "Review", lowValue);
  }

  appendAuditLog(
    cortexPath,
    "govern_memories",
    `projects=${projects.length} stale=${staleCount} conflicts=${conflictCount} review=${reviewCount}`
  );
  for (const project of projects) {
    consolidateProjectLearnings(cortexPath, project);
  }
  const lockSummary = enforceCanonicalLocks(cortexPath, projectArg);
  if (!silent) {
    console.log(`Governed memories: stale=${staleCount}, conflicts=${conflictCount}, review=${reviewCount}`);
    console.log(lockSummary);
  }
  return {
    projects: projects.length,
    staleCount,
    conflictCount,
    reviewCount,
  };
}

async function handlePinMemory(project: string, memory: string) {
  if (!project || !memory) {
    console.error('Usage: cortex pin-memory <project> "<memory>"');
    process.exit(1);
  }
  const result = upsertCanonicalMemory(cortexPath, project, memory);
  console.log(result);
}

async function handleDoctor(args: string[]) {
  const fix = args.includes("--fix");
  const result = await runDoctor(cortexPath, fix);
  console.log(`cortex doctor: ${result.ok ? "ok" : "issues found"}`);
  if (result.machine) console.log(`machine: ${result.machine}`);
  if (result.profile) console.log(`profile: ${result.profile}`);
  for (const check of result.checks) {
    console.log(`- ${check.ok ? "ok" : "fail"} ${check.name}: ${check.detail}`);
  }
  process.exit(result.ok ? 0 : 1);
}

async function handleQualityFeedback(args: string[]) {
  const key = args.find((a) => a.startsWith("--key="))?.slice("--key=".length);
  const feedback = args.find((a) => a.startsWith("--type="))?.slice("--type=".length) as "helpful" | "reprompt" | "regression" | undefined;
  if (!key || !feedback || !["helpful", "reprompt", "regression"].includes(feedback)) {
    console.error("Usage: cortex quality-feedback --key=<memory-key> --type=helpful|reprompt|regression");
    process.exit(1);
  }
  recordMemoryFeedback(cortexPath, key, feedback);
  console.log(`Recorded feedback: ${feedback} for ${key}`);
}

function parseProjectDryRunArgs(
  args: string[],
  command: string,
  usage: string
): { projectArg?: string; dryRun: boolean } {
  let projectArg: string | undefined;
  let dryRun = false;
  for (const arg of args) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg.startsWith("-")) {
      console.error(`Unknown ${command} flag: ${arg}`);
      console.error(usage);
      process.exit(1);
    }
    if (projectArg) {
      console.error(`Usage: ${usage}`);
      process.exit(1);
    }
    projectArg = arg;
  }
  return { projectArg, dryRun };
}

function targetProjects(projectArg?: string): string[] {
  return projectArg
    ? [projectArg]
    : getProjectDirs(cortexPath, profile).map((p) => path.basename(p)).filter((p) => p !== "global");
}

function captureLearningBackups(projects: string[]): Map<string, number> {
  const snapshots = new Map<string, number>();
  for (const project of projects) {
    const backup = path.join(cortexPath, project, "LEARNINGS.md.bak");
    if (!fs.existsSync(backup)) continue;
    snapshots.set(backup, fs.statSync(backup).mtimeMs);
  }
  return snapshots;
}

function summarizeBackupChanges(before: Map<string, number>, projects: string[]): string[] {
  const changed: string[] = [];
  for (const project of projects) {
    const backup = path.join(cortexPath, project, "LEARNINGS.md.bak");
    if (!fs.existsSync(backup)) continue;
    const current = fs.statSync(backup).mtimeMs;
    const previous = before.get(backup);
    if (previous === undefined || current !== previous) {
      changed.push(path.relative(cortexPath, backup));
    }
  }
  return changed.sort();
}

async function handlePruneMemories(args: string[] = []) {
  const usage = "cortex prune-memories [project] [--dry-run]";
  const { projectArg, dryRun } = parseProjectDryRunArgs(args, "prune-memories", usage);
  const projects = targetProjects(projectArg);
  const beforeBackups = dryRun ? new Map<string, number>() : captureLearningBackups(projects);
  const result = pruneDeadMemories(cortexPath, projectArg, dryRun);
  console.log(result);
  if (dryRun || /^permission denied/i.test(result)) return;
  const backups = summarizeBackupChanges(beforeBackups, projects);
  if (!backups.length) return;
  console.log(`Updated backups (${backups.length}): ${backups.join(", ")}`);
}

async function handleConsolidateMemories(args: string[] = []) {
  const usage = "cortex consolidate-memories [project] [--dry-run]";
  const { projectArg, dryRun } = parseProjectDryRunArgs(args, "consolidate-memories", usage);
  const projects = targetProjects(projectArg);
  const beforeBackups = dryRun ? new Map<string, number>() : captureLearningBackups(projects);
  const results = projects.map((p) => consolidateProjectLearnings(cortexPath, p, dryRun));
  console.log(results.join("\n"));
  if (dryRun) return;
  const backups = summarizeBackupChanges(beforeBackups, projects);
  if (!backups.length) return;
  console.log(`Updated backups (${backups.length}): ${backups.join(", ")}`);
}

async function handleMigrateFindings(args: string[]) {
  const project = args.find((arg) => !arg.startsWith("-"));
  if (!project) {
    console.error("Usage: cortex migrate-findings <project> [--pin] [--dry-run]");
    process.exit(1);
  }
  const pinCanonical = args.includes("--pin");
  const dryRun = args.includes("--dry-run");
  const result = migrateLegacyFindings(cortexPath, project, { pinCanonical, dryRun });
  console.log(result);
}

type MaintainMigrationKind = "governance" | "data" | "all";

interface ParsedMaintainMigrationArgs {
  kind: MaintainMigrationKind;
  project?: string;
  pinCanonical: boolean;
  dryRun: boolean;
}

function printMaintainMigrationUsage() {
  console.error("Usage:");
  console.error("  cortex maintain migrate governance [--dry-run]");
  console.error("  cortex maintain migrate data <project> [--pin] [--dry-run]");
  console.error("  cortex maintain migrate all <project> [--pin] [--dry-run]");
  console.error("  cortex maintain migrate <project> [--pin] [--dry-run]  # legacy data alias");
}

function parseMaintainMigrationArgs(args: string[]): ParsedMaintainMigrationArgs {
  let pinCanonical = false;
  let dryRun = false;
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === "--pin") {
      pinCanonical = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg.startsWith("-")) {
      console.error(`Unknown migrate flag: ${arg}`);
      printMaintainMigrationUsage();
      process.exit(1);
    }
    positional.push(arg);
  }

  if (!positional.length) {
    printMaintainMigrationUsage();
    process.exit(1);
  }

  const mode = positional[0].toLowerCase();
  if (mode === "governance") {
    if (pinCanonical) {
      console.error("--pin is only valid for data/all migrations.");
      process.exit(1);
    }
    if (positional.length !== 1) {
      printMaintainMigrationUsage();
      process.exit(1);
    }
    return { kind: "governance", pinCanonical, dryRun };
  }

  if (mode === "data" || mode === "all") {
    const project = positional[1];
    if (!project || positional.length !== 2) {
      printMaintainMigrationUsage();
      process.exit(1);
    }
    return { kind: mode, project, pinCanonical, dryRun };
  }

  if (positional.length !== 1) {
    printMaintainMigrationUsage();
    process.exit(1);
  }
  return { kind: "data", project: positional[0], pinCanonical, dryRun };
}

function describeGovernanceMigrationPlan(): Array<{ file: string; from: number; to: number }> {
  const govDir = path.join(cortexPath, ".governance");
  if (!fs.existsSync(govDir)) return [];
  const files = [
    "memory-policy.json",
    "access-control.json",
    "memory-workflow-policy.json",
    "index-policy.json",
  ];
  const pending: Array<{ file: string; from: number; to: number }> = [];
  for (const file of files) {
    const fullPath = path.join(govDir, file);
    if (!fs.existsSync(fullPath)) continue;
    try {
      const raw = fs.readFileSync(fullPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const fileVersion = typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 0;
      if (fileVersion < GOVERNANCE_SCHEMA_VERSION) {
        pending.push({ file, from: fileVersion, to: GOVERNANCE_SCHEMA_VERSION });
      }
    } catch {
      // Ignore malformed files here; shared migration API handles hard failures defensively.
    }
  }
  return pending;
}

function runGovernanceMigration(dryRun: boolean): string {
  if (dryRun) {
    const pending = describeGovernanceMigrationPlan();
    if (!pending.length) return "[dry-run] Governance files are already up to date.";
    const details = pending.map((entry) => `${entry.file} (${entry.from} -> ${entry.to})`).join(", ");
    return `[dry-run] Would migrate ${pending.length} governance file(s): ${details}`;
  }
  const migrated = migrateGovernanceFiles(cortexPath);
  if (!migrated.length) return "Governance files are already up to date.";
  return `Migrated ${migrated.length} governance file(s): ${migrated.join(", ")}`;
}

async function handleMaintainMigrate(args: string[]) {
  const parsed = parseMaintainMigrationArgs(args);
  const lines: string[] = [];

  if (parsed.kind === "governance" || parsed.kind === "all") {
    lines.push(`Governance migration: ${runGovernanceMigration(parsed.dryRun)}`);
  }
  if (parsed.kind === "data" || parsed.kind === "all") {
    const result = migrateLegacyFindings(cortexPath, parsed.project!, {
      pinCanonical: parsed.pinCanonical,
      dryRun: parsed.dryRun,
    });
    lines.push(`Data migration (${parsed.project}): ${result}`);
  }

  console.log(lines.join("\n"));
}

async function handleIndexPolicy(args: string[]) {
  if (!args.length || args[0] === "get") {
    console.log(JSON.stringify(getIndexPolicy(cortexPath), null, 2));
    return;
  }
  if (args[0] === "set") {
    const patch: {
      includeGlobs?: string[];
      excludeGlobs?: string[];
      includeHidden?: boolean;
    } = {};
    for (const arg of args.slice(1)) {
      if (!arg.startsWith("--")) continue;
      const [k, v] = arg.slice(2).split("=");
      if (!k || v === undefined) continue;
      if (k === "include") {
        patch.includeGlobs = v.split(",").map((s) => s.trim()).filter(Boolean);
      } else if (k === "exclude") {
        patch.excludeGlobs = v.split(",").map((s) => s.trim()).filter(Boolean);
      } else if (k === "includeHidden") {
        patch.includeHidden = /^(1|true|yes|on)$/i.test(v);
      }
    }
    const result = updateIndexPolicy(cortexPath, patch);
    if (typeof result === "string") {
      console.log(result);
      if (result.startsWith("Permission denied")) process.exit(1);
      return;
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.error("Usage: cortex index-policy [get|set --include=**/*.md,.claude/skills/**/*.md --exclude=**/node_modules/**,**/.git/** --includeHidden=false]");
  process.exit(1);
}

async function handleMemoryPolicy(args: string[]) {
  if (!args.length || args[0] === "get") {
    console.log(JSON.stringify(getMemoryPolicy(cortexPath), null, 2));
    return;
  }
  if (args[0] === "set") {
    const patch: any = {};
    for (const arg of args.slice(1)) {
      if (!arg.startsWith("--")) continue;
      const [k, v] = arg.slice(2).split("=");
      if (!k || v === undefined) continue;
      const num = Number(v);
      const value = Number.isNaN(num) ? v : num;
      if (k.startsWith("decay.")) {
        patch.decay = patch.decay || {};
        patch.decay[k.slice("decay.".length)] = value;
      } else {
        patch[k] = value;
      }
    }
    const result = updateMemoryPolicy(cortexPath, patch);
    if (typeof result === "string") {
      console.log(result);
      if (result.startsWith("Permission denied")) process.exit(1);
      return;
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.error("Usage: cortex memory-policy [get|set --ttlDays=120 --retentionDays=365 --autoAcceptThreshold=0.75 --minInjectConfidence=0.35 --decay.d30=1 --decay.d60=0.85 --decay.d90=0.65 --decay.d120=0.45]");
  process.exit(1);
}

async function handleMemoryWorkflow(args: string[]) {
  if (!args.length || args[0] === "get") {
    console.log(JSON.stringify(getMemoryWorkflowPolicy(cortexPath), null, 2));
    return;
  }
  if (args[0] === "set") {
    const patch: any = {};
    for (const arg of args.slice(1)) {
      if (!arg.startsWith("--")) continue;
      const [k, v] = arg.slice(2).split("=");
      if (!k || v === undefined) continue;
      if (k === "requireMaintainerApproval") {
        patch.requireMaintainerApproval = /^(1|true|yes|on)$/i.test(v);
      } else if (k === "riskySections") {
        patch.riskySections = v.split(",").map((s) => s.trim()).filter(Boolean);
      } else {
        const num = Number(v);
        patch[k] = Number.isNaN(num) ? v : num;
      }
    }
    const result = updateMemoryWorkflowPolicy(cortexPath, patch);
    if (typeof result === "string") {
      console.log(result);
      if (result.startsWith("Permission denied")) process.exit(1);
      return;
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.error("Usage: cortex memory-workflow [get|set --requireMaintainerApproval=true --lowConfidenceThreshold=0.7 --riskySections=Stale,Conflicts]");
  process.exit(1);
}

async function handleMemoryAccess(args: string[]) {
  if (!args.length || args[0] === "get") {
    console.log(JSON.stringify(getAccessControl(cortexPath), null, 2));
    return;
  }
  if (args[0] === "set") {
    const patch: any = {};
    for (const arg of args.slice(1)) {
      if (!arg.startsWith("--")) continue;
      const [k, v] = arg.slice(2).split("=");
      if (!k || v === undefined) continue;
      patch[k] = v.split(",").map((s) => s.trim()).filter(Boolean);
    }
    const result = updateAccessControl(cortexPath, patch);
    if (typeof result === "string") {
      console.log(result);
      if (result.startsWith("Permission denied")) process.exit(1);
      return;
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.error("Usage: cortex memory-access [get|set --admins=u1,u2 --maintainers=u3 --contributors=u4 --viewers=u5]");
  process.exit(1);
}

async function handleMemoryUi(args: string[]) {
  const portArg = args.find((a) => a.startsWith("--port="));
  const port = portArg ? Number.parseInt(portArg.slice("--port=".length), 10) : 3499;
  const safePort = Number.isNaN(port) ? 3499 : port;
  await startMemoryUi(cortexPath, safePort);
}

async function handleShell(args: string[]) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: cortex shell");
    console.log("Interactive shell with views for Projects, Backlog, Learnings, Memory Queue, Machines/Profiles, and Health.");
    return;
  }
  await startShell(cortexPath, profile);
}

async function handleUpdate(args: string[]) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: cortex update");
    console.log("Updates cortex to the latest version (local git clone when available, otherwise npm global package).");
    return;
  }
  const result = await runCortexUpdate();
  console.log(result);
}

async function handleBackgroundMaintenance(projectArg?: string) {
  const markers = qualityMarkers(cortexPath);
  const startedAt = new Date().toISOString();
  try {
    const governance = await handleGovernMemories(projectArg, true);
    const pruneResult = pruneDeadMemories(cortexPath, projectArg);
    fs.writeFileSync(markers.done, new Date().toISOString() + "\n");
    updateRuntimeHealth(cortexPath, {
      lastGovernance: {
        at: startedAt,
        status: "ok",
        detail: `projects=${governance.projects} stale=${governance.staleCount} conflicts=${governance.conflictCount} review=${governance.reviewCount}; ${pruneResult}`,
      },
    });
    appendAuditLog(
      cortexPath,
      "background_maintenance",
      `status=ok projects=${governance.projects} stale=${governance.staleCount} conflicts=${governance.conflictCount} review=${governance.reviewCount}`
    );
  } catch (err: any) {
    updateRuntimeHealth(cortexPath, {
      lastGovernance: {
        at: startedAt,
        status: "error",
        detail: err?.message || String(err),
      },
    });
    appendAuditLog(cortexPath, "background_maintenance_failed", `error=${err?.message || String(err)}`);
  } finally {
    try { fs.unlinkSync(markers.lock); } catch { /* best effort */ }
  }
}

function handleSkillList() {
  const sources: Array<{ name: string; source: string; path: string }> = [];

  // Global skills (shipped with cortex)
  const globalSkillsDir = path.join(cortexPath, "global", "skills");
  if (fs.existsSync(globalSkillsDir)) {
    for (const entry of fs.readdirSync(globalSkillsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        sources.push({
          name: entry.name.replace(/\.md$/, ""),
          source: "global",
          path: path.join(globalSkillsDir, entry.name),
        });
      }
    }
  }

  // Project-level skills (check each project for a skills/ dir)
  const projectDirs = getProjectDirs(cortexPath, profile);
  for (const dir of projectDirs) {
    const projectName = path.basename(dir);
    if (projectName === "global") continue;
    const projectSkillsDir = path.join(dir, "skills");
    if (!fs.existsSync(projectSkillsDir)) continue;
    for (const entry of fs.readdirSync(projectSkillsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        sources.push({
          name: entry.name.replace(/\.md$/, ""),
          source: projectName,
          path: path.join(projectSkillsDir, entry.name),
        });
      }
    }
  }

  if (!sources.length) {
    console.log("No skills found.");
    return;
  }

  // Simple table output
  const nameWidth = Math.max(4, ...sources.map((s) => s.name.length));
  const sourceWidth = Math.max(6, ...sources.map((s) => s.source.length));

  console.log(
    `${"Name".padEnd(nameWidth)}  ${"Source".padEnd(sourceWidth)}  Path`
  );
  console.log(
    `${"─".repeat(nameWidth)}  ${"─".repeat(sourceWidth)}  ${"─".repeat(30)}`
  );
  for (const skill of sources) {
    console.log(
      `${skill.name.padEnd(nameWidth)}  ${skill.source.padEnd(sourceWidth)}  ${skill.path}`
    );
  }
  console.log(`\n${sources.length} skill(s) found.`);
}

function handleBacklogView() {
  const docs = readBacklogs(cortexPath, profile);
  if (!docs.length) {
    console.log("No backlogs found.");
    return;
  }

  let totalActive = 0;
  let totalQueue = 0;

  for (const doc of docs) {
    const activeCount = doc.items.Active.length;
    const queueCount = doc.items.Queue.length;
    if (activeCount === 0 && queueCount === 0) continue;

    totalActive += activeCount;
    totalQueue += queueCount;

    console.log(`\n## ${doc.project}`);
    if (activeCount > 0) {
      console.log("  Active:");
      for (const item of doc.items.Active) {
        const tag = item.priority ? ` [${item.priority}]` : "";
        console.log(`    - ${item.line}${tag}`);
      }
    }
    if (queueCount > 0) {
      console.log("  Queue:");
      for (const item of doc.items.Queue) {
        const tag = item.priority ? ` [${item.priority}]` : "";
        console.log(`    - ${item.line}${tag}`);
      }
    }
  }

  if (totalActive === 0 && totalQueue === 0) {
    console.log("All backlogs are empty.");
    return;
  }

  console.log(`\n${totalActive} active, ${totalQueue} queued across ${docs.length} project(s).`);
}

async function handleConfig(args: string[]) {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "policy":
      return handleMemoryPolicy(rest);
    case "workflow":
      return handleMemoryWorkflow(rest);
    case "access":
      return handleMemoryAccess(rest);
    case "index":
      return handleIndexPolicy(rest);
    case "machines":
      return handleConfigMachines();
    case "profiles":
      return handleConfigProfiles();
    default:
      console.log(`cortex config - manage settings and policies

Subcommands:
  cortex config policy [get|set ...]     Memory retention, TTL, confidence, decay
  cortex config workflow [get|set ...]   Approval gates, risky-memory thresholds
  cortex config access [get|set ...]     Role-based permissions (admin/maintainer/contributor/viewer)
  cortex config index [get|set ...]      Indexer include/exclude globs
  cortex config machines                 Registered machines and profiles
  cortex config profiles                 All profiles and their projects`);
      if (sub) {
        console.error(`\nUnknown config subcommand: "${sub}"`);
        process.exit(1);
      }
  }
}

function handleConfigMachines() {
  const machines = listMachinesStore(cortexPath);
  if (typeof machines === "string") {
    console.log(machines);
    return;
  }
  const lines = Object.entries(machines).map(([machine, prof]) => `  ${machine}: ${prof}`);
  console.log(`Registered Machines\n${lines.join("\n")}`);
}

function handleConfigProfiles() {
  const profiles = listProfilesStore(cortexPath);
  if (typeof profiles === "string") {
    console.log(profiles);
    return;
  }
  for (const p of profiles) {
    console.log(`\n${p.name}`);
    for (const proj of p.projects) console.log(`  - ${proj}`);
    if (!p.projects.length) console.log("  (no projects)");
  }
}

async function handleMaintain(args: string[]) {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "govern":
      return handleGovernMemories(rest[0]);
    case "prune":
      return handlePruneMemories(rest);
    case "consolidate":
      return handleConsolidateMemories(rest);
    case "migrate":
      return handleMaintainMigrate(rest);
    case "extract":
      return handleExtractMemories(rest[0]);
    default:
      console.log(`cortex maintain - memory maintenance and governance

Subcommands:
  cortex maintain govern [project]       Queue stale/conflicting/low-value memories for review
  cortex maintain prune [project] [--dry-run]
                                         Delete expired entries by retention policy
  cortex maintain consolidate [project] [--dry-run]
                                         Deduplicate LEARNINGS.md bullets
  cortex maintain migrate governance [--dry-run]
                                         Upgrade governance policy file schemas
  cortex maintain migrate data <project> [--pin] [--dry-run]
  cortex maintain migrate all <project> [--pin] [--dry-run]
  cortex maintain migrate <project> [--pin] [--dry-run]  (legacy alias)
                                         Promote legacy findings into LEARNINGS/CANONICAL
  cortex maintain extract [project]      Mine git/GitHub signals into memory candidates`);
      if (sub) {
        console.error(`\nUnknown maintain subcommand: "${sub}"`);
        process.exit(1);
      }
  }
}

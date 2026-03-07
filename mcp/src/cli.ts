import {
  getProjectDirs,
  runtimeFile,
  EXEC_TIMEOUT_MS,
  ensureCortexPath,
} from "./shared.js";
import {
  recordFeedback,
  flushEntryScores,
} from "./shared-governance.js";
import {
  buildIndex,
  queryRows,
  extractSnippet,
  type DbRow,
} from "./shared-index.js";
import {
  addFindingToFile,
  upsertCanonical,
} from "./shared-content.js";
import { buildRobustFtsQuery, isValidProjectName, STOP_WORDS } from "./utils.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

import { runDoctor } from "./link.js";
import { startReviewUi } from "./memory-ui.js";
import { startShell } from "./shell.js";
import { runCortexUpdate } from "./update.js";
import { readBacklogs } from "./data-access.js";

// Re-export from split modules so existing test imports keep working
export {
  detectTaskIntent,
  parseHookInput,
  searchDocuments,
  applyTrustFilter,
  rankResults,
  selectSnippets,
  buildHookOutput,
  trackSessionMetrics,
  filterBacklogByPriority,
  parseCitations,
  validateCitation,
  annotateStale,
  getProjectGlobBoost,
  clearProjectGlobCache,
  clearCitationValidCache,
  extractToolFindings,
  type HookPromptInput,
  type SelectedSnippet,
} from "./cli-hooks.js";
export { scoreFindingCandidate } from "./cli-extract.js";

import {
  handleHookPrompt,
  handleHookSessionStart,
  handleHookStop,
  handleHookContext,
  handleHookTool,
  scheduleBackgroundMaintenance,
  resolveSubprocessArgs,
} from "./cli-hooks.js";
import { handleExtractMemories } from "./cli-extract.js";
import {
  handleGovernMemories,
  handlePruneMemories,
  handleConsolidateMemories,
  handleMigrateFindings,
  handleMaintain,
  handleBackgroundMaintenance,
} from "./cli-govern.js";
import {
  handleConfig,
  handleIndexPolicy,
  handleRetentionPolicy,
  handleWorkflowPolicy,
  handleAccessControl,
} from "./cli-config.js";

const cortexPath = ensureCortexPath();
const profile = process.env.CORTEX_PROFILE || "";

// ── Search types and parsing ─────────────────────────────────────────────────

const SEARCH_TYPE_ALIASES: Record<string, string> = {
  skills: "skill",
};
const SEARCH_TYPES = new Set([
  "claude",
  "summary",
  "findings",
  "reference",
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
  showHistory?: boolean;
  fromHistory?: number;
  searchAll?: boolean;
}

// ── Search history ───────────────────────────────────────────────────────────

const MAX_HISTORY = 20;

interface SearchHistoryEntry {
  query: string;
  project?: string;
  type?: string;
  ts: string;
}

function historyFile(): string {
  return runtimeFile(cortexPath, "search-history.jsonl");
}

function readSearchHistory(): SearchHistoryEntry[] {
  const file = historyFile();
  if (!fs.existsSync(file)) return [];
  try {
    return fs.readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line) as SearchHistoryEntry);
  } catch {
    return [];
  }
}

function recordSearchQuery(opts: SearchOptions) {
  if (!opts.query) return;
  const file = historyFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entry: SearchHistoryEntry = {
    query: opts.query,
    ...(opts.project && { project: opts.project }),
    ...(opts.type && { type: opts.type }),
    ts: new Date().toISOString(),
  };
  let entries = readSearchHistory();
  entries.push(entry);
  if (entries.length > MAX_HISTORY) entries = entries.slice(-MAX_HISTORY);
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
}

function printSearchHistory() {
  const entries = readSearchHistory();
  if (!entries.length) {
    console.log("No search history.");
    return;
  }
  console.log("Recent searches:\n");
  entries.forEach((e, i) => {
    const scope = [
      e.project ? `--project ${e.project}` : "",
      e.type ? `--type ${e.type}` : "",
    ].filter(Boolean).join(" ");
    const ts = e.ts.slice(0, 16).replace("T", " ");
    console.log(`  ${i + 1}. "${e.query}"${scope ? " " + scope : ""}  (${ts})`);
  });
}

function printSearchUsage() {
  console.error("Usage:");
  console.error("  cortex search <query> [--project <name>] [--type <type>] [--limit <n>] [--all]");
  console.error("  cortex search --project <name> [--type <type>] [--limit <n>] [--all]");
  console.error("  cortex search --history                    Show recent searches");
  console.error("  cortex search --from-history <n>           Re-run search #n from history");
  console.error("  type: claude|summary|findings|reference|backlog|changelog|canonical|memory-queue|skill|other");
}

function parseSearchArgs(args: string[]): SearchOptions | null {
  const queryParts: string[] = [];
  let project: string | undefined;
  let type: string | undefined;
  let limit = 10;
  let showHistory = false;
  let fromHistory: number | undefined;
  let searchAll = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      printSearchUsage();
      return null;
    }

    if (arg === "--history") {
      showHistory = true;
      continue;
    }

    if (arg === "--all") {
      limit = 100;
      searchAll = true;
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
    if (flag === "--from-history") {
      const parsed = Number.parseInt(readValue(), 10);
      if (Number.isNaN(parsed) || parsed < 1) {
        console.error("Invalid --from-history value. Use a positive integer.");
        process.exit(1);
      }
      fromHistory = parsed;
      continue;
    }

    if (arg.startsWith("-")) {
      console.error(`Unknown search flag: ${arg}`);
      printSearchUsage();
      process.exit(1);
    }

    queryParts.push(arg);
  }

  if (showHistory) {
    return { query: "", limit, showHistory: true };
  }

  if (fromHistory !== undefined) {
    const history = readSearchHistory();
    if (fromHistory > history.length || fromHistory < 1) {
      console.error(`No search at position ${fromHistory}. History has ${history.length} entries.`);
      process.exit(1);
    }
    const entry = history[fromHistory - 1];
    return {
      query: entry.query,
      limit,
      project: entry.project,
      type: entry.type,
    };
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
    searchAll,
  };
}

// ── CLI router ───────────────────────────────────────────────────────────────

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
    case "hook-tool":
      return handleHookTool();
    case "add-finding":
      return handleAddFinding(args[0], args.slice(1).join(" "));
    case "extract-memories":
      return handleExtractMemories(args[0]);
    case "govern-memories":
      return handleGovernMemories(args[0]);
    case "pin":
      return handlePinCanonical(args[0], args.slice(1).join(" "));
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
    case "policy":
      return handleRetentionPolicy(args);
    case "workflow":
      return handleWorkflowPolicy(args);
    case "access":
      return handleAccessControl(args);
    case "review-ui":
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
    case "debug-injection":
      return handleDebugInjection(args);
    case "inspect-index":
      return handleInspectIndex(args);
    case "detect-skills":
      return handleDetectSkills(args);
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

// ── Simple command handlers (kept in cli.ts) ─────────────────────────────────

async function handleSearch(opts: SearchOptions) {
  if (opts.showHistory) {
    printSearchHistory();
    return;
  }

  recordSearchQuery(opts);
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

    let rows = queryRows(db, sql, params);

    if (!rows && opts.query) {
      let fallbackSql = "SELECT project, filename, type, content, path FROM docs";
      const fallbackParams: Array<string | number> = [];
      const fbClauses: string[] = [];
      if (opts.project) { fbClauses.push("project = ?"); fallbackParams.push(opts.project); }
      if (opts.type) { fbClauses.push("type = ?"); fallbackParams.push(opts.type); }
      if (fbClauses.length) fallbackSql += " WHERE " + fbClauses.join(" AND ");

      const allRows = queryRows(db, fallbackSql, fallbackParams);
      if (allRows) {
        const terms = opts.query
          .toLowerCase()
          .replace(/[^\w\s-]/g, " ")
          .split(/\s+/)
          .filter(w => w.length > 1 && !STOP_WORDS.has(w));

        if (terms.length > 0) {
          const scored = allRows
            .map((row: DbRow) => {
              const content = (row[3] as string).toLowerCase();
              let score = 0;
              for (const term of terms) {
                if (content.includes(term)) score++;
              }
              return { row, score };
            })
            .filter(r => r.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, opts.limit);

          if (scored.length > 0) {
            rows = scored.map(s => s.row);
            console.log("(keyword fallback)");
          }
        }
      }
    }

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
  } catch (err: unknown) {
    console.error(`Search error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function handleAddFinding(project: string, learning: string) {
  if (!project || !learning) {
    console.error('Usage: cortex add-finding <project> "<insight>"');
    process.exit(1);
  }

  try {
    const result = addFindingToFile(cortexPath, project, learning);
    if (!result.ok) {
      console.error(result.error);
      process.exit(1);
    }
    console.log(result.data);
  } catch (e: unknown) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

async function handlePinCanonical(project: string, memory: string) {
  if (!project || !memory) {
    console.error('Usage: cortex pin <project> "<memory>"');
    process.exit(1);
  }
  const result = upsertCanonical(cortexPath, project, memory);
  console.log(result.ok ? result.data : result.error);
}

async function handleDoctor(args: string[]) {
  const fix = args.includes("--fix");
  const checkData = args.includes("--check-data");
  const agentsOnly = args.includes("--agents");
  const result = await runDoctor(cortexPath, fix, checkData);
  if (agentsOnly) {
    // Filter to only agent-related checks
    const agentChecks = result.checks.filter((c) =>
      c.name.includes("cursor") || c.name.includes("copilot") || c.name.includes("codex") || c.name.includes("windsurf")
    );
    console.log(`cortex doctor --agents: ${agentChecks.every((c) => c.ok) ? "all configured" : "some not configured"}`);
    for (const check of agentChecks) {
      console.log(`- ${check.ok ? "ok" : "not configured"} ${check.name}: ${check.detail}`);
    }
    if (agentChecks.length === 0) {
      console.log("No agent integrations detected. Run `cortex init` to configure.");
    }
    process.exit(agentChecks.every((c) => c.ok) ? 0 : 1);
  }
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
    console.error("Usage: cortex quality-feedback --key=<entry-key> --type=helpful|reprompt|regression");
    process.exit(1);
  }
  recordFeedback(cortexPath, key, feedback);
  flushEntryScores(cortexPath);
  console.log(`Recorded feedback: ${feedback} for ${key}`);
}

async function handleMemoryUi(args: string[]) {
  const portArg = args.find((a) => a.startsWith("--port="));
  const port = portArg ? Number.parseInt(portArg.slice("--port=".length), 10) : 3499;
  const safePort = Number.isNaN(port) ? 3499 : port;
  await startReviewUi(cortexPath, safePort);
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

function handleSkillList() {
  const sources: Array<{ name: string; source: string; format: "flat" | "folder"; path: string }> = [];

  function collectSkills(root: string, sourceLabel: string) {
    if (!fs.existsSync(root)) return;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const entryPath = path.join(root, entry.name);
      if (entry.isFile() && entry.name.endsWith(".md")) {
        sources.push({
          name: entry.name.replace(/\.md$/, ""),
          source: sourceLabel,
          format: "flat",
          path: entryPath,
        });
        continue;
      }
      if (entry.isDirectory()) {
        const skillFile = path.join(entryPath, "SKILL.md");
        if (!fs.existsSync(skillFile)) continue;
        sources.push({
          name: entry.name,
          source: sourceLabel,
          format: "folder",
          path: skillFile,
        });
      }
    }
  }

  const globalSkillsDir = path.join(cortexPath, "global", "skills");
  collectSkills(globalSkillsDir, "global");

  const projectDirs = getProjectDirs(cortexPath, profile);
  for (const dir of projectDirs) {
    const projectName = path.basename(dir);
    if (projectName === "global") continue;
    const projectSkillsDir = path.join(dir, "skills");
    collectSkills(projectSkillsDir, projectName);
  }

  if (!sources.length) {
    console.log("No skills found.");
    return;
  }

  const nameWidth = Math.max(4, ...sources.map((s) => s.name.length));
  const sourceWidth = Math.max(6, ...sources.map((s) => s.source.length));
  const formatWidth = Math.max(6, ...sources.map((s) => s.format.length));

  console.log(
    `${"Name".padEnd(nameWidth)}  ${"Source".padEnd(sourceWidth)}  ${"Format".padEnd(formatWidth)}  Path`
  );
  console.log(
    `${"─".repeat(nameWidth)}  ${"─".repeat(sourceWidth)}  ${"─".repeat(formatWidth)}  ${"─".repeat(30)}`
  );
  for (const skill of sources) {
    console.log(
      `${skill.name.padEnd(nameWidth)}  ${skill.source.padEnd(sourceWidth)}  ${skill.format.padEnd(formatWidth)}  ${skill.path}`
    );
  }
  console.log(`\n${sources.length} skill(s) found.`);
}

function handleDetectSkills(args: string[]) {
  const importFlag = args.includes("--import");
  const nativeSkillsDir = path.join(os.homedir(), ".claude", "skills");
  if (!fs.existsSync(nativeSkillsDir)) {
    console.log("No native skills directory found at ~/.claude/skills/");
    return;
  }

  const trackedSkills = new Set<string>();
  const globalSkillsDir = path.join(cortexPath, "global", "skills");
  if (fs.existsSync(globalSkillsDir)) {
    for (const entry of fs.readdirSync(globalSkillsDir)) {
      trackedSkills.add(entry.replace(/\.md$/, ""));
      if (fs.statSync(path.join(globalSkillsDir, entry)).isDirectory()) {
        trackedSkills.add(entry);
      }
    }
  }
  const projectDirs = getProjectDirs(cortexPath, profile);
  for (const dir of projectDirs) {
    const projectSkillsDir = path.join(dir, ".claude", "skills");
    if (!fs.existsSync(projectSkillsDir)) continue;
    for (const entry of fs.readdirSync(projectSkillsDir)) {
      trackedSkills.add(entry.replace(/\.md$/, ""));
    }
  }

  const untracked: Array<{ name: string; path: string }> = [];
  for (const entry of fs.readdirSync(nativeSkillsDir)) {
    const entryPath = path.join(nativeSkillsDir, entry);
    const stat = fs.statSync(entryPath);
    if (stat.isSymbolicLink()) continue;
    try {
      if (fs.lstatSync(entryPath).isSymbolicLink()) continue;
    } catch { /* skip */ }
    const name = entry.replace(/\.md$/, "");
    if (trackedSkills.has(name)) continue;
    if (stat.isFile() && entry.endsWith(".md")) {
      untracked.push({ name, path: entryPath });
    } else if (stat.isDirectory()) {
      const skillFile = path.join(entryPath, "SKILL.md");
      if (fs.existsSync(skillFile)) {
        untracked.push({ name, path: skillFile });
      }
    }
  }

  if (!untracked.length) {
    console.log("All skills in ~/.claude/skills/ are already tracked by cortex.");
    return;
  }

  console.log(`Found ${untracked.length} untracked skill(s) in ~/.claude/skills/:\n`);
  for (const skill of untracked) {
    console.log(`  ${skill.name}  (${skill.path})`);
  }

  if (!importFlag) {
    console.log(`\nRun with --import to copy these into cortex global skills.`);
    return;
  }

  fs.mkdirSync(globalSkillsDir, { recursive: true });
  let imported = 0;
  for (const skill of untracked) {
    const dest = path.join(globalSkillsDir, `${skill.name}.md`);
    if (fs.existsSync(dest)) {
      console.log(`  skip ${skill.name} (already exists in global/skills/)`);
      continue;
    }
    fs.copyFileSync(skill.path, dest);
    console.log(`  imported ${skill.name} -> global/skills/${skill.name}.md`);
    imported++;
  }
  console.log(`\nImported ${imported} skill(s). Run \`cortex link\` to activate.`);
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

async function handleDebugInjection(args: string[]) {
  let cwd = process.cwd();
  let sessionId = `debug-${Date.now()}`;
  const promptParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--cwd") {
      cwd = args[++i] || cwd;
      continue;
    }
    if (arg === "--session") {
      sessionId = args[++i] || sessionId;
      continue;
    }
    if (arg === "--prompt") {
      promptParts.push(args[++i] || "");
      continue;
    }
    promptParts.push(arg);
  }

  const prompt = promptParts.join(" ").trim();
  if (!prompt) {
    console.error('Usage: cortex debug-injection --prompt "your prompt here" [--cwd <path>] [--session <id>]');
    process.exit(1);
  }

  const subprocessArgs = resolveSubprocessArgs("hook-prompt");
  if (!subprocessArgs) {
    console.error("Could not resolve cortex entrypoint for debug-injection.");
    process.exit(1);
  }

  const payload = JSON.stringify({
    prompt,
    cwd,
    session_id: sessionId,
  });

  try {
    const out = execFileSync(process.execPath, subprocessArgs, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      input: payload,
      env: {
        ...process.env,
        CORTEX_PATH: cortexPath,
        CORTEX_PROFILE: profile,
      },
      timeout: EXEC_TIMEOUT_MS,
    }).trim();
    if (!out) {
      console.log("(no context injected)");
      return;
    }
    console.log(out);
  } catch (err: unknown) {
    const stderr = err instanceof Error && "stderr" in err ? String((err as NodeJS.ErrnoException & { stderr?: unknown }).stderr || "").trim() : "";
    if (stderr) console.error(stderr);
    console.error(`debug-injection failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function handleInspectIndex(args: string[]) {
  let project: string | undefined;
  let type: string | undefined;
  let limit = 20;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--project") {
      project = args[++i];
      continue;
    }
    if (arg === "--type") {
      type = args[++i];
      continue;
    }
    if (arg === "--limit") {
      const parsed = Number.parseInt(args[++i] || "", 10);
      if (!Number.isNaN(parsed) && parsed > 0) limit = Math.min(parsed, 200);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: cortex inspect-index [--project <name>] [--type <doc-type>] [--limit <n>]");
      return;
    }
  }

  const db = await buildIndex(cortexPath, profile);
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (project) {
    where.push("project = ?");
    params.push(project);
  }
  if (type) {
    where.push("type = ?");
    params.push(type);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalRows = queryRows(db, `SELECT count(*) FROM docs ${whereSql}`, params);
  const total = Number((totalRows?.[0]?.[0] as number | string | undefined) ?? 0);
  console.log(`FTS index docs: ${total}`);
  if (project) console.log(`Project filter: ${project}`);
  if (type) console.log(`Type filter: ${type}`);

  const sample = queryRows(
    db,
    `SELECT project, filename, type, path FROM docs ${whereSql} ORDER BY project, type, filename LIMIT ?`,
    [...params, limit]
  );
  if (!sample || sample.length === 0) {
    console.log("No rows for current filter.");
    return;
  }

  console.log("");
  for (const row of sample) {
    const [proj, filename, docType, filePath] = row as string[];
    console.log(`- ${proj}/${filename} (${docType})`);
    console.log(`  ${filePath}`);
  }
}

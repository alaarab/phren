import {
  debugLog,
  EXEC_TIMEOUT_MS,
  withFileLock,
  recordFeedback,
  getQualityMultiplier,
  errorMessage,
} from "./cli/hooks-context.js";
import {
  sessionMetricsFile,
} from "./shared.js";
import {
  autoMergeConflicts,
  mergeTask,
  mergeFindings,
} from "./shared/content.js";
import { runGit } from "./utils.js";
import { isTaskFileName } from "./data/tasks.js";
import type { SelectedSnippet } from "./shared/retrieval.js";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

// ── Git helpers ──────────────────────────────────────────────────────────────

export interface GitContext {
  branch: string;
  changedFiles: Set<string>;
}

export function getGitContext(cwd?: string): GitContext | null {
  if (!cwd) return null;
  const git = (args: string[]) => runGit(cwd, args, EXEC_TIMEOUT_MS, debugLog);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch) return null;
  const changedFiles = new Set<string>();
  for (const changed of [
    git(["diff", "--name-only"]),
    git(["diff", "--name-only", "--cached"]),
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

// ── Session metrics ──────────────────────────────────────────────────────────

export interface SessionMetric {
  prompts: number;
  keys: Record<string, number>;
  lastChangedCount: number;
  lastKeys: string[];
  lastSeen?: string;
}

export function parseSessionMetrics(phrenPathLocal: string): Record<string, SessionMetric> {
  const file = sessionMetricsFile(phrenPathLocal);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, SessionMetric>;
  } catch (err: unknown) {
    debugLog(`parseSessionMetrics: failed to read ${file}: ${errorMessage(err)}`);
    return {};
  }
}

export function writeSessionMetrics(phrenPathLocal: string, data: Record<string, SessionMetric>) {
  const file = sessionMetricsFile(phrenPathLocal);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

export function updateSessionMetrics(
  phrenPathLocal: string,
  updater: (data: Record<string, SessionMetric>) => void
): void {
  const file = sessionMetricsFile(phrenPathLocal);
  withFileLock(file, () => {
    const metrics = parseSessionMetrics(phrenPathLocal);
    updater(metrics);
    writeSessionMetrics(phrenPathLocal, metrics);
  });
}

export function trackSessionMetrics(
  phrenPathLocal: string,
  sessionId: string,
  selected: SelectedSnippet[]
): void {
  updateSessionMetrics(phrenPathLocal, (metrics) => {
    if (!metrics[sessionId]) metrics[sessionId] = { prompts: 0, keys: {}, lastChangedCount: 0, lastKeys: [] };
    metrics[sessionId].prompts += 1;
    const injectedKeys: string[] = [];
    for (const injected of selected) {
      injectedKeys.push(injected.key);
      const key = injected.key;
      const seen = metrics[sessionId].keys[key] || 0;
      metrics[sessionId].keys[key] = seen + 1;
      if (seen >= 1) recordFeedback(phrenPathLocal, key, "reprompt");
    }

    const relevantCount = selected.filter((s) => getQualityMultiplier(phrenPathLocal, s.key) > 0.5).length;
    const prevRelevant = metrics[sessionId].lastChangedCount || 0;
    const prevKeys = metrics[sessionId].lastKeys || [];
    if (relevantCount > prevRelevant) {
      for (const prevKey of prevKeys) {
        recordFeedback(phrenPathLocal, prevKey, "helpful");
      }
    }
    metrics[sessionId].lastChangedCount = relevantCount;
    metrics[sessionId].lastKeys = injectedKeys;
    metrics[sessionId].lastSeen = new Date().toISOString();

    const thirtyDaysAgo = Date.now() - 30 * 86400000;
    for (const sid of Object.keys(metrics)) {
      const seen = metrics[sid].lastSeen;
      if (seen && new Date(seen).getTime() < thirtyDaysAgo) {
        delete metrics[sid];
      }
    }
  });
}

// ── Git command helpers for hooks ────────────────────────────────────────────

export function isTransientGitError(message: string): boolean {
  return /(timed out|connection|network|could not resolve host|rpc failed|429|502|503|504|service unavailable)/i.test(message);
}

export function shouldRetryGitCommand(args: string[]): boolean {
  const cmd = args[0] || "";
  return cmd === "push" || cmd === "pull" || cmd === "fetch";
}

export async function runBestEffortGit(args: string[], cwd: string): Promise<{ ok: boolean; output?: string; error?: string }> {
  const retries = shouldRetryGitCommand(args) ? 2 : 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const output = execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: EXEC_TIMEOUT_MS,
      }).trim();
      return { ok: true, output };
    } catch (err: unknown) {
      const message = errorMessage(err);
      if (attempt < retries && isTransientGitError(message)) {
        const delayMs = 500 * (attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      return { ok: false, error: message };
    }
  }
  return { ok: false, error: "git command failed" };
}

/**
 * Files phren is allowed to auto-stage in a team store. Anything not in this
 * list (notably `.runtime/`, secrets, build output) is skipped on session-stop
 * and `push_changes`.
 */
export const TEAM_STORE_PATHSPECS = [
  "*/journal/*",
  "*/tasks.md",
  "*/truths.md",
  "*/FINDINGS.md",
  "*/FINDINGS.md.bak",
  "*/summary.md",
  "*/review.md",
  "*/CLAUDE.md",
  "*/topic-config.json",
  "*/phren.project.yaml",
  "*/reference/**",
  "*/skills/**",
  ".phren-team.yaml",
] as const;

/**
 * Stage each team pathspec individually so a single no-match (e.g. a store
 * with no `truths.md` anywhere) doesn't abort the entire `git add` and strand
 * every other change. Errors are swallowed by `runBestEffortGit` already.
 *
 * Returns the number of pathspecs that staged successfully — useful for
 * telemetry, not gating.
 */
export async function addTeamPathspecs(cwd: string): Promise<number> {
  let staged = 0;
  for (const spec of TEAM_STORE_PATHSPECS) {
    const result = await runBestEffortGit(["add", "--sparse", "--", spec], cwd);
    if (result.ok) staged++;
  }
  return staged;
}

export async function countUnsyncedCommits(cwd: string): Promise<number> {
  const upstream = await runBestEffortGit(["rev-parse", "--abbrev-ref", "@{upstream}"], cwd);
  if (!upstream.ok || !upstream.output) {
    // No upstream tracking branch — count all local commits as unsynced
    // so the warning at the call site fires instead of silently returning 0
    const allCommits = await runBestEffortGit(["rev-list", "--count", "HEAD"], cwd);
    if (!allCommits.ok || !allCommits.output) return 0;
    const parsed = Number.parseInt(allCommits.output.trim(), 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  const ahead = await runBestEffortGit(["rev-list", "--count", `${upstream.output.trim()}..HEAD`], cwd);
  if (!ahead.ok || !ahead.output) return 0;
  const parsed = Number.parseInt(ahead.output.trim(), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function isMergeableMarkdown(relPath: string): boolean {
  const filename = path.basename(relPath).toLowerCase();
  return filename === "findings.md" || isTaskFileName(filename);
}

export async function snapshotLocalMergeableFiles(cwd: string): Promise<Map<string, string>> {
  const upstream = await runBestEffortGit(["rev-parse", "--abbrev-ref", "@{upstream}"], cwd);
  if (!upstream.ok || !upstream.output) return new Map();
  const changed = await runBestEffortGit(["diff", "--name-only", `${upstream.output.trim()}..HEAD`], cwd);
  if (!changed.ok || !changed.output) return new Map();

  const snapshots = new Map<string, string>();
  for (const relPath of changed.output.split("\n").map((line) => line.trim()).filter(Boolean)) {
    if (!isMergeableMarkdown(relPath)) continue;
    const fullPath = path.join(cwd, relPath);
    if (!fs.existsSync(fullPath)) continue;
    snapshots.set(relPath, fs.readFileSync(fullPath, "utf8"));
  }
  return snapshots;
}

export async function reconcileMergeableFiles(cwd: string, snapshots: Map<string, string>): Promise<boolean> {
  let changedAny = false;

  for (const [relPath, localBeforePull] of snapshots.entries()) {
    const fullPath = path.join(cwd, relPath);
    if (!fs.existsSync(fullPath)) continue;
    const current = fs.readFileSync(fullPath, "utf8");
    const filename = path.basename(relPath).toLowerCase();
    const merged = filename === "findings.md"
      ? mergeFindings(current, localBeforePull)
      : mergeTask(current, localBeforePull);
    if (merged === current) continue;
    fs.writeFileSync(fullPath, merged);
    changedAny = true;
  }

  if (!changedAny) return false;

  const add = await runBestEffortGit(["add", "--", ...snapshots.keys()], cwd);
  if (!add.ok) return false;
  const commit = await runBestEffortGit(["commit", "-m", "auto-merge markdown recovery"], cwd);
  return commit.ok;
}

export async function recoverPushConflict(cwd: string): Promise<{ ok: boolean; detail: string; pullStatus: "ok" | "error"; pullDetail: string }> {
  const localSnapshots = await snapshotLocalMergeableFiles(cwd);
  const pull = await runBestEffortGit(["pull", "--rebase", "--quiet"], cwd);
  if (pull.ok) {
    const reconciled = await reconcileMergeableFiles(cwd, localSnapshots);
    const retryPush = await runBestEffortGit(["push"], cwd);
    return {
      ok: retryPush.ok,
      detail: retryPush.ok
        ? (reconciled ? "commit pushed after pull --rebase and markdown reconciliation" : "commit pushed after pull --rebase")
        : (retryPush.error || "push failed after pull --rebase"),
      pullStatus: "ok",
      pullDetail: pull.output || "pull --rebase ok",
    };
  }

  const conflicted = await runBestEffortGit(["diff", "--name-only", "--diff-filter=U"], cwd);
  const conflictedOutput = conflicted.output?.trim() || "";
  if (!conflicted.ok || !conflictedOutput) {
    await runBestEffortGit(["rebase", "--abort"], cwd);
    return {
      ok: false,
      detail: pull.error || "pull --rebase failed",
      pullStatus: "error",
      pullDetail: pull.error || "pull --rebase failed",
    };
  }

  if (!autoMergeConflicts(cwd)) {
    await runBestEffortGit(["rebase", "--abort"], cwd);
    return {
      ok: false,
      detail: `rebase conflicts require manual resolution: ${conflictedOutput}`,
      pullStatus: "error",
      pullDetail: `rebase conflicts require manual resolution: ${conflictedOutput}`,
    };
  }

  const continued = await runBestEffortGit(["-c", "core.editor=true", "rebase", "--continue"], cwd);
  if (!continued.ok) {
    await runBestEffortGit(["rebase", "--abort"], cwd);
    return {
      ok: false,
      detail: continued.error || "rebase --continue failed",
      pullStatus: "error",
      pullDetail: continued.error || "rebase --continue failed",
    };
  }

  const retryPush = await runBestEffortGit(["push"], cwd);
  return {
    ok: retryPush.ok,
    detail: retryPush.ok ? "commit pushed after auto-merge recovery" : (retryPush.error || "push failed after auto-merge recovery"),
    pullStatus: "ok",
    pullDetail: "pull --rebase recovered via auto-merge",
  };
}

export function resolveSubprocessArgs(command: string): string[] | null {
  // Prefer the entry script from process.argv[1] (the index.js that started this process)
  const entry = process.argv[1];
  if (entry && fs.existsSync(entry) && /index\.(ts|js)$/.test(entry)) return [entry, command];
  // Fallback: look for index.js next to this file
  const distEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
  if (fs.existsSync(distEntry)) return [distEntry, command];
  return null;
}

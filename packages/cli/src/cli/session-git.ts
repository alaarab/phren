/**
 * Git helpers for session hooks.
 * Extracted from hooks-session.ts for modularity.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  EXEC_TIMEOUT_MS,
  debugLog,
  errorMessage,
} from "./hooks-context.js";
import { runGit } from "../utils.js";
import { isTaskFileName } from "../data/tasks.js";
import {
  autoMergeConflicts,
  mergeTask,
  mergeFindings,
} from "../shared/content.js";

// ── Git context ─────────────────────────────────────────────────────────────

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

// ── Git command helpers ─────────────────────────────────────────────────────

function isTransientGitError(message: string): boolean {
  return /(timed out|connection|network|could not resolve host|rpc failed|429|502|503|504|service unavailable)/i.test(message);
}

function shouldRetryGitCommand(args: string[]): boolean {
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

export async function countUnsyncedCommits(cwd: string): Promise<number> {
  const upstream = await runBestEffortGit(["rev-parse", "--abbrev-ref", "@{upstream}"], cwd);
  if (!upstream.ok || !upstream.output) {
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

// ── Merge helpers ───────────────────────────────────────────────────────────

function isMergeableMarkdown(relPath: string): boolean {
  const filename = path.basename(relPath).toLowerCase();
  return filename === "findings.md" || isTaskFileName(filename);
}

async function snapshotLocalMergeableFiles(cwd: string): Promise<Map<string, string>> {
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

async function reconcileMergeableFiles(cwd: string, snapshots: Map<string, string>): Promise<boolean> {
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

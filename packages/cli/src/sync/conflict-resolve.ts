/**
 * Resolves the content conflicts a store merge can settle without a person:
 * tasks.md per task id against the merge base, generated blocks from the
 * incoming side, and the record-oriented files that already union-merge.
 * Everything else stays conflicted so the caller aborts and names it.
 */
import { execFileSync, spawnSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isTaskFileName } from "../filenames.js";
import { debugLog, EXEC_TIMEOUT_MS } from "../shared.js";
import { errorMessage } from "../utils.js";
import { nonInteractiveGitEnv } from "../utils-helpers.js";
import { mergeFindings, mergeTask } from "../content/validate.js";
import { KNOWS_END, KNOWS_START, NOW_END, NOW_START, upsertBlock } from "../content/summarize.js";
import { mergeTasksByBid } from "./task-merge.js";

export interface ConflictResolution { resolved: string[]; unresolved: string[] }

type Strategy = "tasks" | "findings" | "archive" | "topic" | "summary" | null;

export function conflictStrategy(relFile: string): Strategy {
  const file = relFile.replace(/\\/g, "/");
  const name = path.posix.basename(file).toLowerCase();
  if (isTaskFileName(name)) return "tasks";
  if (name === "findings.md") return "findings";
  if (/^\.config\/task-archive\/[^/]+\.md$/i.test(file)) return "archive";
  if (/(^|\/)reference\/topics\/[^/]+\.md$/i.test(file)) return "topic";
  if (name === "summary.md") return "summary";
  return null;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    env: nonInteractiveGitEnv(), cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: EXEC_TIMEOUT_MS,
  });
}

/** One index stage of a conflicted path (1 base, 2 local, 3 incoming), or null when that side has no file. */
function stage(cwd: string, n: 1 | 2 | 3, relFile: string): string | null {
  try { return git(cwd, ["show", `:${n}:${relFile}`]); } catch { return null; }
}

const BLOCK_RE = (start: string, end: string) =>
  new RegExp(`${start.replace("-->", "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*-->[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n*`);

function splitBlock(content: string, start: string, end: string): { rest: string; block: string | null } {
  const match = BLOCK_RE(start, end).exec(content);
  if (!match) return { rest: content, block: null };
  return { rest: content.slice(0, match.index) + content.slice(match.index + match[0].length), block: match[0].replace(/\n+$/, "") };
}

/** A line-level three-way merge through `git merge-file`; null when lines still conflict. */
function mergeText(base: string, ours: string, theirs: string): string | null {
  if (ours === theirs || ours === base) return theirs;
  if (theirs === base) return ours;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phren-merge-"));
  try {
    const [o, b, t] = ["ours", "base", "theirs"].map((name) => path.join(dir, name));
    fs.writeFileSync(o, ours); fs.writeFileSync(b, base); fs.writeFileSync(t, theirs);
    const result = spawnSync("git", ["merge-file", "-p", o, b, t], { encoding: "utf8", env: nonInteractiveGitEnv(), timeout: EXEC_TIMEOUT_MS });
    return result.status === 0 ? result.stdout : null;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/**
 * Generated blocks regenerate, so the incoming block wins; the rest of the
 * file must still merge line by line.
 */
function mergeWithGeneratedBlock(base: string, ours: string, theirs: string, start: string, end: string, where: "top" | "bottom"): string | null {
  const b = splitBlock(base, start, end);
  const o = splitBlock(ours, start, end);
  const t = splitBlock(theirs, start, end);
  const rest = mergeText(b.rest, o.rest, t.rest);
  if (rest === null) return null;
  const block = t.block ?? o.block;
  if (!block) return rest;
  return upsertBlock(rest, start, end, block, where);
}

function resolveContent(strategy: Exclude<Strategy, null>, base: string, ours: string, theirs: string): string | null {
  switch (strategy) {
    case "tasks": return mergeTasksByBid(base, ours, theirs);
    case "findings": return mergeFindings(ours, theirs);
    // Archived tasks only accumulate: keep both sides, the incoming version of any duplicate.
    case "archive": return mergeTask(theirs, ours);
    case "topic": return mergeWithGeneratedBlock(base, ours, theirs, NOW_START, NOW_END, "top");
    case "summary": return mergeWithGeneratedBlock(base, ours, theirs, KNOWS_START, KNOWS_END, "bottom");
  }
}

/** Resolves what it can in the store's in-progress merge and stages it. */
export function resolveStoreConflicts(cwd: string): ConflictResolution {
  let conflicted: string[];
  try {
    conflicted = git(cwd, ["diff", "--name-only", "--diff-filter=U"]).split("\n").map((line) => line.trim()).filter(Boolean);
  } catch (err: unknown) {
    debugLog(`resolveStoreConflicts: cannot list conflicts: ${errorMessage(err)}`);
    return { resolved: [], unresolved: [] };
  }
  const resolved: string[] = [];
  const unresolved: string[] = [];
  for (const relFile of conflicted) {
    const strategy = conflictStrategy(relFile);
    if (!strategy) { unresolved.push(relFile); continue; }
    try {
      const base = stage(cwd, 1, relFile) ?? "";
      const ours = stage(cwd, 2, relFile);
      const theirs = stage(cwd, 3, relFile);
      const fullPath = path.join(cwd, relFile);
      if (ours === null && theirs === null) { unresolved.push(relFile); continue; }
      // Removed on one side and edited on the other: keep the edited file.
      const merged = ours === null ? theirs : theirs === null ? ours : resolveContent(strategy, base, ours, theirs);
      if (merged === null) { unresolved.push(relFile); continue; }
      const tmp = `${fullPath}.tmp-${crypto.randomUUID()}`;
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(tmp, merged);
      fs.renameSync(tmp, fullPath);
      git(cwd, ["add", "--", relFile]);
      resolved.push(relFile);
    } catch (err: unknown) {
      debugLog(`resolveStoreConflicts: ${relFile}: ${errorMessage(err)}`);
      unresolved.push(relFile);
    }
  }
  return { resolved, unresolved };
}

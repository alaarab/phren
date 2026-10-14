/**
 * Resolves the content conflicts a store merge can settle without a person:
 * tasks.md per task id against the merge base, daily notes per note id
 * against the base, generated summaries from the incoming side, and the
 * append-only record files (findings, journal, review queue, topic archives)
 * as a union of both sides. Everything else stays conflicted so the caller
 * aborts and names it.
 *
 * Any file left unresolved aborts the whole merge, and every later auto-save
 * then commits locally and fails to push, so a store drifts further from its
 * remote each session. Every file phren itself writes during normal use needs
 * a strategy here.
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
import { cleanBlock, KNOWS_END, KNOWS_START, NOW_END, NOW_START, upsertBlock } from "../content/summarize.js";
import { dedupeTaskIds, mergeTasksByBid } from "./task-merge.js";
import { NOTE_HEADING_RE } from "../data/notes.js";

export interface ConflictResolution { resolved: string[]; unresolved: string[] }

type Strategy = "tasks" | "findings" | "archive" | "topic" | "summary" | "notes" | "union" | "theirs" | null;

export function conflictStrategy(relFile: string): Strategy {
  const file = relFile.replace(/\\/g, "/");
  const name = path.posix.basename(file).toLowerCase();
  if (isTaskFileName(name)) return "tasks";
  if (name === "findings.md") return "findings";
  if (/^\.config\/task-archive\/[^/]+\.md$/i.test(file)) return "archive";
  if (/(^|\/)reference\/topics\/[^/]+\.md$/i.test(file)) return "topic";
  if (name === "summary.md") return "summary";
  if (name === "review.md" || name === "truths.md") return "union";
  // Coordination state Phren rewrites itself (maintenance-writer.ts): the remote's copy holds.
  if (file === ".config/maintenance-writer.json") return "theirs";
  if (/(^|\/)notes\/[^/]+\.md$/i.test(file)) return "notes";
  if (/(^|\/)journal\/[^/]+\.md$/i.test(file)) return "union";
  return null;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    // The default 1 MiB buffer failed on a task archive that had outgrown it,
    // and an unreadable side left the whole merge unresolved.
    env: nonInteractiveGitEnv(), cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: EXEC_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024,
  });
}

/** One index stage of a conflicted path (1 base, 2 local, 3 incoming), or null when that side has no file. */
function stage(cwd: string, n: 1 | 2 | 3, relFile: string): string | null {
  try { return git(cwd, ["show", `:${n}:${relFile}`]); } catch { return null; }
}

function splitBlock(content: string, start: string, end: string): { rest: string; block: string | null } {
  // The whole span, first start to last end, rebuilt as one copy: an earlier
  // union merge may have left two start lines (and two bodies) behind.
  const clean = cleanBlock(content, start, end);
  return clean ?? { rest: content, block: null };
}

/** A line-level three-way merge through `git merge-file`; null when lines still conflict. */
function mergeText(base: string, ours: string, theirs: string): string | null {
  if (ours === theirs || ours === base) return theirs;
  if (theirs === base) return ours;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phren-merge-"));
  try {
    const [o, b, t] = ["ours", "base", "theirs"].map((name) => path.join(dir, name));
    fs.writeFileSync(o, ours); fs.writeFileSync(b, base); fs.writeFileSync(t, theirs);
    const result = spawnSync("git", ["merge-file", "-p", o, b, t], { encoding: "utf8", env: nonInteractiveGitEnv(), timeout: EXEC_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 });
    return result.status === 0 ? result.stdout : null;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/**
 * A line-level three-way merge that keeps both sides of a conflicting hunk,
 * local lines first (`git merge-file --union`). For append-only records two
 * machines adding entries at the same spot is not a real conflict.
 */
function unionText(base: string, ours: string, theirs: string): string | null {
  const clean = mergeText(base, ours, theirs);
  if (clean !== null) return clean;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phren-merge-"));
  try {
    const [o, b, t] = ["ours", "base", "theirs"].map((name) => path.join(dir, name));
    fs.writeFileSync(o, ours); fs.writeFileSync(b, base); fs.writeFileSync(t, theirs);
    const result = spawnSync("git", ["merge-file", "--union", "-p", o, b, t], { encoding: "utf8", env: nonInteractiveGitEnv(), timeout: EXEC_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 });
    return result.status === 0 ? result.stdout : null;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const DELETED_FILE = Symbol("deleted");

/** A daily notes file split into its header and one block per note id; null when an id repeats. */
function noteBlocks(content: string): { header: string; notes: Map<string, string> } | null {
  // The notes writer's own heading grammar: a note body may contain other `## ... nid:` lines.
  const lines = content.split("\n");
  const first = lines.findIndex((line) => NOTE_HEADING_RE.test(line));
  const notes = new Map<string, string>();
  if (first === -1) return { header: content.trimEnd(), notes };
  let id = "";
  let body: string[] = [];
  const flush = () => { if (id) notes.set(id, body.join("\n").trimEnd()); };
  for (const line of lines.slice(first)) {
    const m = NOTE_HEADING_RE.exec(line);
    if (!m) { body.push(line); continue; }
    flush();
    if (notes.has(m[2])) return null;
    id = m[2];
    body = [line];
  }
  flush();
  return { header: lines.slice(0, first).join("\n").trimEnd(), notes };
}

/**
 * Daily notes merged per note id against the base: a note one side edited or
 * removed takes that side's change, notes either side added are kept. A line
 * union could put an edited note's old body back under the same id. A note
 * both sides edited differently falls back to the line union. A side that
 * deleted the file counts as one with the base's header and no notes, and
 * DELETED_FILE comes back when no note survives that deletion.
 */
function mergeNotes(base: string, ours: string | null, theirs: string | null): string | typeof DELETED_FILE | null {
  const b = noteBlocks(base);
  if (!b) return null;
  const deleted = { header: b.header, notes: new Map<string, string>() };
  const [o, t] = [ours === null ? deleted : noteBlocks(ours), theirs === null ? deleted : noteBlocks(theirs)];
  if (!o || !t) return null;
  const header = mergeText(b.header, o.header, t.header);
  if (header === null) return null;
  const out: string[] = [];
  for (const id of new Set([...o.notes.keys(), ...t.notes.keys()])) {
    const [was, mine, incoming] = [b.notes.get(id), o.notes.get(id), t.notes.get(id)];
    let note: string | undefined;
    if (mine === incoming || incoming === was) note = mine;
    else if (mine === was) note = incoming;
    // Removed on one side, edited on the other: the edit is kept.
    else if (mine === undefined || incoming === undefined) note = mine ?? incoming;
    else return null;
    if (note !== undefined) out.push(note);
  }
  if (!out.length && (ours === null || theirs === null)) return DELETED_FILE;
  return [header, ...out].join("\n\n") + "\n";
}

/**
 * Generated blocks regenerate, so the incoming block wins; the rest of the
 * file merges with `merge`: a union of both sides by default (a topic
 * archive's bullets).
 */
function mergeWithGeneratedBlock(base: string, ours: string, theirs: string, start: string, end: string, where: "top" | "bottom", merge = unionText): string | null {
  const b = splitBlock(base, start, end);
  const o = splitBlock(ours, start, end);
  const t = splitBlock(theirs, start, end);
  const rest = merge(b.rest, o.rest, t.rest);
  if (rest === null) return null;
  const block = t.block ?? o.block;
  if (!block) return rest;
  return upsertBlock(rest, start, end, block, where);
}

const dedupe = (content: string | null): string | null => content === null ? null : dedupeTaskIds(content).content;

function orUnion(merge: () => string | null, base: string, ours: string, theirs: string, after: (content: string | null) => string | null = (c) => c): string | null {
  try {
    const merged = merge();
    if (merged !== null) return merged;
  } catch (err: unknown) { debugLog(`store merge fell back to a line union: ${errorMessage(err)}`); }
  return after(unionText(base, ours, theirs));
}

function resolveContent(strategy: Exclude<Strategy, null>, base: string, ours: string, theirs: string): string | null {
  switch (strategy) {
    // When a smarter merge refuses, a line union still keeps every record of
    // both sides (repeated task ids collapsed): a knowledge file never blocks a sync.
    case "tasks": return orUnion(() => mergeTasksByBid(base, ours, theirs), base, ours, theirs, dedupe);
    case "findings": return orUnion(() => mergeFindings(ours, theirs, base), base, ours, theirs);
    // Archived tasks only accumulate: keep both sides, the incoming version of any duplicate.
    case "archive": return dedupe(orUnion(() => mergeTask(theirs, ours), base, ours, theirs));
    case "topic": return mergeWithGeneratedBlock(base, ours, theirs, NOW_START, NOW_END, "top");
    // Summaries are regenerated from the store: when the hand-written part
    // doesn't merge cleanly, take the incoming file whole and let the next
    // summarize pass fold in anything only this machine had.
    case "summary": return mergeWithGeneratedBlock(base, ours, theirs, KNOWS_START, KNOWS_END, "bottom", mergeText) ?? theirs;
    case "notes": return mergeNotes(base, ours, theirs) ?? unionText(base, ours, theirs);
    case "union": return unionText(base, ours, theirs);
    case "theirs": return theirs;
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
      // Removed on one side and edited on the other: keep the edited file,
      // except daily notes, whose deletion can mean their last note was removed.
      const notesMerge = strategy === "notes" && (ours === null || theirs === null) ? mergeNotes(base, ours, theirs) : null;
      if (notesMerge === DELETED_FILE) {
        git(cwd, ["rm", "--quiet", "--force", "--ignore-unmatch", "--", relFile]);
        resolved.push(relFile);
        continue;
      }
      const merged = notesMerge ?? (ours === null ? theirs : theirs === null ? ours : resolveContent(strategy, base, ours, theirs));
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

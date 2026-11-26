// One line per prompt the hook saw, in `.runtime/recall-trace.jsonl`: what recall
// matched and injected, or why it injected nothing. Local runtime state, never synced.

import * as fs from "fs";
import * as path from "path";
import { runtimeDir } from "../phren-paths.js";
import { debugLog } from "../shared.js";
import { errorMessage } from "../utils.js";
import type { RecallDocRef, RecallFloorReason, RecallResult } from "./types.js";

const TRACE_FILE = "recall-trace.jsonl";
// About two weeks of prompts on a busy computer; trimmed to the newest lines past the byte cap.
const MAX_TRACE_LINES = 5000;
const ROTATE_BYTES = 4_000_000;
const MAX_FLOOR_ROWS = 12;
const MAX_PROMPT_CHARS = 160;

/** Why the hook stopped before recall ran: another agent's message, or a prompt with no keywords. */
export type RecallSkipReason = "machine-prompt" | "no-keywords";

export interface RecallTraceFloorRow {
  path: string;
  passed: boolean;
  reason: RecallFloorReason;
  distinct: number;
  rarity: number;
  overlap: number;
  matched: string[];
}

export interface RecallTraceEntry {
  at: string;
  session?: string;
  project: string | null;
  prompt: string;
  /** Set when the hook stopped before recall ran; the recall fields are then absent. */
  skipped?: RecallSkipReason;
  keywords?: string[];
  intent?: string;
  abstained?: string | null;
  candidates?: number;
  floor?: RecallTraceFloorRow[];
  /** Store-relative paths and score keys of what was injected, after the summary block and budget trim. */
  injected?: Array<{ path: string; key: string; type: string }>;
  tokens?: number;
  budget?: number;
  ms?: Record<string, number>;
}

export function recallTraceFile(phrenPath: string): string {
  return path.join(runtimeDir(phrenPath), TRACE_FILE);
}

function storeRelative(phrenPath: string, file: string): string {
  const rel = path.relative(phrenPath, file);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : file;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clampPrompt(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_PROMPT_CHARS ? flat : `${flat.slice(0, MAX_PROMPT_CHARS - 1)}…`;
}

/** The trace line for a prompt recall ran on. `injected` is what the hook finally printed. */
export function traceEntryFromResult(
  phrenPath: string,
  prompt: string,
  result: RecallResult,
  injected: Array<RecallDocRef & { key: string }>,
  extra: { session?: string; indexMs?: number } = {},
): RecallTraceEntry {
  return {
    at: new Date().toISOString(),
    ...(extra.session ? { session: extra.session } : {}),
    project: result.detectedProject,
    prompt: clampPrompt(prompt),
    keywords: result.keywords,
    intent: result.intent,
    abstained: result.abstained,
    candidates: result.candidates.length,
    floor: result.floor.slice(0, MAX_FLOOR_ROWS).map((row) => ({
      path: storeRelative(phrenPath, row.path),
      passed: row.passed,
      reason: row.reason,
      distinct: row.distinct,
      rarity: round(row.rarity),
      overlap: round(row.overlap),
      matched: row.matched,
    })),
    injected: injected.map((row) => ({ path: storeRelative(phrenPath, row.path), key: row.key, type: row.type })),
    tokens: result.usedTokens,
    budget: result.tokenBudget,
    ms: { ...(extra.indexMs !== undefined ? { index: extra.indexMs } : {}), search: result.stageMs.searchMs, trust: result.stageMs.trustMs, rank: result.stageMs.rankMs, select: result.stageMs.selectMs },
  };
}

/** The trace line for a prompt the hook stopped on before recall. */
export function skippedTraceEntry(prompt: string, skipped: RecallSkipReason, project: string | null, session?: string): RecallTraceEntry {
  return { at: new Date().toISOString(), ...(session ? { session } : {}), project, prompt: clampPrompt(prompt), skipped };
}

/** Append one entry. Best-effort: a trace failure never breaks the hook. */
export function recordRecallTrace(phrenPath: string, entry: RecallTraceEntry): void {
  const file = recallTraceFile(phrenPath);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch (err: unknown) {
    debugLog(`recordRecallTrace write failed: ${errorMessage(err)}`);
    return;
  }
  try {
    if (fs.statSync(file).size <= ROTATE_BYTES) return;
    const kept = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-MAX_TRACE_LINES);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${kept.join("\n")}\n`);
    fs.renameSync(tmp, file);
  } catch (err: unknown) {
    debugLog(`recordRecallTrace rotation failed: ${errorMessage(err)}`);
  }
}

/** Every parsed entry, oldest first; malformed lines are skipped. */
export function readRecallTrace(phrenPath: string): RecallTraceEntry[] {
  const file = recallTraceFile(phrenPath);
  if (!fs.existsSync(file)) return [];
  const out: RecallTraceEntry[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as RecallTraceEntry;
      if (parsed && typeof parsed.at === "string") out.push(parsed);
    } catch {
      // A torn line from a concurrent append: skip it.
    }
  }
  return out;
}

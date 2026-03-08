import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { appendAuditLog, debugLog, isRecord } from "./shared.js";
import { withFileLock } from "./governance-locks.js";
import { errorMessage } from "./utils.js";

export interface EntryScore {
  impressions: number;
  helpful: number;
  repromptPenalty: number;
  regressionPenalty: number;
  lastUsedAt: string;
}

interface VersionedEntriesFile<T> {
  schemaVersion?: number;
  entries: Record<string, T>;
}

interface ScoreJournalEntry {
  key: string;
  delta: { impressions?: number; helpful?: number; repromptPenalty?: number; regressionPenalty?: number };
  at: string;
}

const GOVERNANCE_SCHEMA_VERSION = 1;
const DEFAULT_MEMORY_SCORES_FILE: VersionedEntriesFile<EntryScore> = {
  schemaVersion: GOVERNANCE_SCHEMA_VERSION,
  entries: {},
};

function governanceFile(cortexPath: string, fileName: string): string {
  return path.join(cortexPath, ".governance", fileName);
}

function usageLogFile(cortexPath: string): string {
  return governanceFile(cortexPath, "memory-usage.log");
}

function scoresJournalFile(cortexPath: string): string {
  const dir = path.join(cortexPath, ".runtime");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "scores.jsonl");
}

function hasValidSchemaVersion(data: Record<string, unknown>): boolean {
  return !("schemaVersion" in data) || typeof data.schemaVersion === "number";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isEntryScore(value: unknown): value is EntryScore {
  if (!isRecord(value)) return false;
  return isFiniteNumber(value.impressions)
    && isFiniteNumber(value.helpful)
    && isFiniteNumber(value.repromptPenalty)
    && isFiniteNumber(value.regressionPenalty)
    && typeof value.lastUsedAt === "string";
}

function isVersionedEntries(data: Record<string, unknown>): boolean {
  return "entries" in data || "schemaVersion" in data;
}

function entriesObject(data: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(data.entries)) return data.entries;
  return data;
}

function validateScoresJson(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return true;
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    if (!isRecord(data)) return false;
    if (isVersionedEntries(data) && !hasValidSchemaVersion(data)) return false;
    if (isVersionedEntries(data) && !isRecord(data.entries)) return false;
    return Object.values(entriesObject(data)).every((entry) => isEntryScore(entry));
  } catch (err: unknown) {
    debugLog(`validateScoresJson failed for ${filePath}: ${errorMessage(err)}`);
    return false;
  }
}

function normalizeVersionedEntries<T>(data: Record<string, unknown>, guard: (value: unknown) => value is T): VersionedEntriesFile<T> {
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(entriesObject(data))) {
    if (guard(value)) out[key] = value;
  }
  return {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    entries: out,
  };
}

function readScoresFile(cortexPath: string): Record<string, EntryScore> {
  const file = governanceFile(cortexPath, "memory-scores.json");
  try {
    if (!fs.existsSync(file)) return { ...DEFAULT_MEMORY_SCORES_FILE.entries };
    if (!validateScoresJson(file)) {
      debugLog(`readScoresFile: ${file} failed validation, using defaults`);
      return { ...DEFAULT_MEMORY_SCORES_FILE.entries };
    }
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    return normalizeVersionedEntries(parsed, isEntryScore).entries;
  } catch (err: unknown) {
    debugLog(`readScoresFile failed for ${file}: ${errorMessage(err)}`);
    return { ...DEFAULT_MEMORY_SCORES_FILE.entries };
  }
}

function writeScoresFile(cortexPath: string, scores: Record<string, EntryScore>): void {
  const file = governanceFile(cortexPath, "memory-scores.json");
  withFileLock(file, () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmpPath = path.join(path.dirname(file), `.tmp-${crypto.randomUUID()}`);
    fs.writeFileSync(tmpPath, JSON.stringify({
      schemaVersion: GOVERNANCE_SCHEMA_VERSION,
      entries: scores,
    } satisfies VersionedEntriesFile<EntryScore>, null, 2) + "\n");
    fs.renameSync(tmpPath, file);
  });
}

let scoresCache: Record<string, EntryScore> | null = null;
let scoresCachePath: string | null = null;
let scoresDirty = false;

function appendScoreJournal(cortexPath: string, key: string, delta: ScoreJournalEntry["delta"]): void {
  const file = scoresJournalFile(cortexPath);
  const entry: ScoreJournalEntry = { key, delta, at: new Date().toISOString() };
  withFileLock(file, () => {
    fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  });
}

function readScoreJournal(cortexPath: string): ScoreJournalEntry[] {
  const file = scoresJournalFile(cortexPath);
  if (!fs.existsSync(file)) return [];
  try {
    return fs.readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line: string) => {
        try {
          return JSON.parse(line) as ScoreJournalEntry;
        } catch {
          return null;
        }
      })
      .filter((entry: ScoreJournalEntry | null): entry is ScoreJournalEntry => entry !== null);
  } catch (err: unknown) {
    debugLog(`readScoreJournal failed: ${errorMessage(err)}`);
    return [];
  }
}

function claimScoreJournal(cortexPath: string): ScoreJournalEntry[] {
  const file = scoresJournalFile(cortexPath);
  let claimedFile: string | null = null;
  withFileLock(file, () => {
    if (!fs.existsSync(file)) return;
    claimedFile = `${file}.${crypto.randomUUID()}.claim`;
    fs.renameSync(file, claimedFile);
    fs.writeFileSync(file, "");
  });
  if (!claimedFile) return [];
  try {
    return fs.readFileSync(claimedFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line: string) => {
        try {
          return JSON.parse(line) as ScoreJournalEntry;
        } catch {
          return null;
        }
      })
      .filter((entry: ScoreJournalEntry | null): entry is ScoreJournalEntry => entry !== null);
  } catch (err: unknown) {
    debugLog(`claimScoreJournal failed: ${errorMessage(err)}`);
    return [];
  } finally {
    try {
      fs.unlinkSync(claimedFile);
    } catch {
      // best effort
    }
  }
}

function aggregateJournalScores(entries: ScoreJournalEntry[]): Record<string, { impressions: number; helpful: number; repromptPenalty: number; regressionPenalty: number; lastUsedAt: string }> {
  const aggregated: Record<string, { impressions: number; helpful: number; repromptPenalty: number; regressionPenalty: number; lastUsedAt: string }> = {};
  for (const entry of entries) {
    if (!aggregated[entry.key]) {
      aggregated[entry.key] = { impressions: 0, helpful: 0, repromptPenalty: 0, regressionPenalty: 0, lastUsedAt: "" };
    }
    const current = aggregated[entry.key];
    if (entry.delta.impressions) current.impressions += entry.delta.impressions;
    if (entry.delta.helpful) current.helpful += entry.delta.helpful;
    if (entry.delta.repromptPenalty) current.repromptPenalty += entry.delta.repromptPenalty;
    if (entry.delta.regressionPenalty) current.regressionPenalty += entry.delta.regressionPenalty;
    // Q24: carry the max journal timestamp so lastUsedAt is persisted correctly during flush
    if (entry.at && entry.at > current.lastUsedAt) current.lastUsedAt = entry.at;
  }
  return aggregated;
}

function ensureScoreEntry(scores: Record<string, EntryScore>, key: string): EntryScore {
  if (!scores[key]) {
    scores[key] = {
      impressions: 0,
      helpful: 0,
      repromptPenalty: 0,
      regressionPenalty: 0,
      lastUsedAt: new Date(0).toISOString(),
    };
  }
  return scores[key];
}

function loadEntryScores(cortexPath: string): Record<string, EntryScore> {
  const file = governanceFile(cortexPath, "memory-scores.json");
  if (scoresCache && scoresCachePath === file) return scoresCache;
  scoresCache = readScoresFile(cortexPath);
  scoresCachePath = file;
  scoresDirty = false;
  return scoresCache;
}

function saveEntryScores(cortexPath: string, scores: Record<string, EntryScore>): void {
  scoresCache = scores;
  scoresCachePath = governanceFile(cortexPath, "memory-scores.json");
  scoresDirty = true;
}

export function flushEntryScores(cortexPath: string): void {
  // Invalidate journal cache since claimScoreJournal will clear the file
  journalCache = null;
  journalCachePath = null;
  const journalEntries = claimScoreJournal(cortexPath);
  if (journalEntries.length > 0) {
    const scores = loadEntryScores(cortexPath);
    const aggregated = aggregateJournalScores(journalEntries);
    for (const [key, deltas] of Object.entries(aggregated)) {
      const entry = ensureScoreEntry(scores, key);
      entry.impressions += deltas.impressions;
      entry.helpful += deltas.helpful;
      entry.repromptPenalty += deltas.repromptPenalty;
      entry.regressionPenalty += deltas.regressionPenalty;
      // Q24: persist the max journal timestamp into lastUsedAt so recency boost advances correctly
      if (deltas.lastUsedAt && deltas.lastUsedAt > entry.lastUsedAt) {
        entry.lastUsedAt = deltas.lastUsedAt;
      }
    }
    saveEntryScores(cortexPath, scores);
  }

  if (scoresDirty && scoresCache && scoresCachePath === governanceFile(cortexPath, "memory-scores.json")) {
    writeScoresFile(cortexPath, scoresCache);
    scoresDirty = false;
  }
}

export const flushMemoryScores = flushEntryScores;

export function entryScoreKey(project: string, filename: string, snippet: string): string {
  const short = snippet.replace(/\s+/g, " ").slice(0, 200);
  const digest = crypto.createHash("sha1").update(`${project}:${filename}:${short}`).digest("hex").slice(0, 12);
  return `${project}/${filename}:${digest}`;
}

export function recordInjection(cortexPath: string, key: string, sessionId?: string): void {
  appendScoreJournal(cortexPath, key, { impressions: 1 });
  const session = sessionId || "none";
  const logFile = usageLogFile(cortexPath);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, `${new Date().toISOString()}\tinject\t${session}\t${key}\n`);
  try {
    const stat = fs.statSync(logFile);
    if (stat.size > 1_000_000) {
      const content = fs.readFileSync(logFile, "utf8");
      const lines = content.split("\n");
      fs.writeFileSync(logFile, lines.slice(-500).join("\n"));
    }
  } catch (err: unknown) {
    debugLog(`Usage log rotation failed: ${errorMessage(err)}`);
  }
}

export const recordMemoryInjection = recordInjection;

export function recordFeedback(
  cortexPath: string,
  key: string,
  feedback: "helpful" | "reprompt" | "regression",
): void {
  const delta: ScoreJournalEntry["delta"] = {};
  if (feedback === "helpful") delta.helpful = 1;
  if (feedback === "reprompt") delta.repromptPenalty = 1;
  if (feedback === "regression") delta.regressionPenalty = 1;
  appendScoreJournal(cortexPath, key, delta);
  appendAuditLog(cortexPath, "memory_feedback", `key=${key} feedback=${feedback}`);
}

export const recordMemoryFeedback = recordFeedback;

// Module-level cache for the journal aggregation used by getQualityMultiplier.
// Invalidated whenever flushEntryScores runs (at which point the journal is cleared).
let journalCache: Map<string, { helpful: number; repromptPenalty: number; regressionPenalty: number; impressions: number; lastUsedAt: string }> | null = null;
let journalCachePath: string | null = null;

function getJournalCache(cortexPath: string): Map<string, { helpful: number; repromptPenalty: number; regressionPenalty: number; impressions: number; lastUsedAt: string }> {
  const file = scoresJournalFile(cortexPath);
  if (journalCache && journalCachePath === file) return journalCache;
  // Build the cache by reading the journal once and aggregating by key
  const entries = readScoreJournal(cortexPath);
  const cache = new Map<string, { helpful: number; repromptPenalty: number; regressionPenalty: number; impressions: number; lastUsedAt: string }>();
  for (const entry of entries) {
    const cur = cache.get(entry.key) ?? { helpful: 0, repromptPenalty: 0, regressionPenalty: 0, impressions: 0, lastUsedAt: "" };
    if (entry.delta.helpful) cur.helpful += entry.delta.helpful;
    if (entry.delta.repromptPenalty) cur.repromptPenalty += entry.delta.repromptPenalty;
    if (entry.delta.regressionPenalty) cur.regressionPenalty += entry.delta.regressionPenalty;
    if (entry.delta.impressions) cur.impressions += entry.delta.impressions;
    if (entry.at && entry.at > cur.lastUsedAt) cur.lastUsedAt = entry.at;
    cache.set(entry.key, cur);
  }
  journalCache = cache;
  journalCachePath = file;
  return cache;
}

export function getQualityMultiplier(cortexPath: string, key: string): number {
  const scores = loadEntryScores(cortexPath);
  const entry = scores[key];
  let helpful = entry ? entry.helpful : 0;
  let repromptPenalty = entry ? entry.repromptPenalty : 0;
  let regressionPenalty = entry ? entry.regressionPenalty : 0;
  let impressions = entry ? entry.impressions : 0;
  let lastUsedAt = entry ? entry.lastUsedAt : "";

  // Use the cached journal aggregation to avoid O(n×m) reads during ranking
  const journalAgg = getJournalCache(cortexPath).get(key);
  const hasJournalData = journalAgg !== undefined;
  if (journalAgg) {
    helpful += journalAgg.helpful;
    repromptPenalty += journalAgg.repromptPenalty;
    regressionPenalty += journalAgg.regressionPenalty;
    impressions += journalAgg.impressions;
    if (journalAgg.lastUsedAt && journalAgg.lastUsedAt > lastUsedAt) lastUsedAt = journalAgg.lastUsedAt;
  }

  if (!entry && !hasJournalData) return 1;

  let recencyBoost = 0;
  if (lastUsedAt) {
    const lastUsedMs = new Date(lastUsedAt).getTime();
    if (!Number.isNaN(lastUsedMs)) {
      const daysSinceUse = Math.max(0, (Date.now() - lastUsedMs) / 86_400_000);
      if (daysSinceUse <= 7) {
        recencyBoost = 0.15;
      } else if (daysSinceUse <= 30) {
        recencyBoost = 0;
      } else {
        recencyBoost = -0.1 * Math.min(3, (daysSinceUse - 30) / 30);
      }
    }
  }

  const frequencyBoost = impressions > 0 ? Math.min(0.2, Math.log2(impressions + 1) * 0.05) : 0;
  const penalties = repromptPenalty + regressionPenalty * 2;
  const feedbackScore = helpful * 0.15 - penalties * 0.2;
  const raw = 1 + feedbackScore + recencyBoost + frequencyBoost;
  return Math.max(0.2, Math.min(1.5, raw));
}

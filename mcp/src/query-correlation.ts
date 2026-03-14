// query-correlation.ts — Lightweight query-to-finding correlation tracker.
// Tracks which queries led to which documents being selected (and later rated "helpful"),
// then uses that data to pre-warm results for recurring query patterns.
//
// Gated behind PHREN_FEATURE_QUERY_CORRELATION env var (disabled by default).
// Storage: JSONL append to .runtime/query-correlations.jsonl, last-500 window.

import * as fs from "fs";
import { runtimeFile, debugLog } from "./shared.js";
import { isFeatureEnabled, errorMessage } from "./utils.js";
import type { SelectedSnippet } from "./shared-retrieval.js";

export interface CorrelationEntry {
  timestamp: string;
  keywords: string;
  project: string;
  filename: string;
  sessionId?: string;
  helpful?: boolean;
}

const CORRELATION_FILENAME = "query-correlations.jsonl";
const RECENT_WINDOW = 500;
const MIN_TOKEN_OVERLAP = 2;
const MIN_TOKEN_LENGTH = 3;

/**
 * Check if query correlation feature is enabled via env var.
 */
export function isQueryCorrelationEnabled(): boolean {
  return isFeatureEnabled("PHREN_FEATURE_QUERY_CORRELATION", false);
}

/**
 * Log query-to-finding correlations after snippet selection.
 * Called from handleHookPrompt after selectSnippets.
 */
export function logCorrelations(
  phrenPath: string,
  keywords: string,
  selected: SelectedSnippet[],
  sessionId?: string,
): void {
  if (!isQueryCorrelationEnabled()) return;
  if (!selected.length || !keywords.trim()) return;

  try {
    const correlationFile = runtimeFile(phrenPath, CORRELATION_FILENAME);
    const lines: string[] = [];
    for (const sel of selected) {
      const entry: CorrelationEntry = {
        timestamp: new Date().toISOString(),
        keywords: keywords.slice(0, 200),
        project: sel.doc.project,
        filename: sel.doc.filename,
        sessionId,
      };
      lines.push(JSON.stringify(entry));
    }
    fs.appendFileSync(correlationFile, lines.join("\n") + "\n");
  } catch (err: unknown) {
    debugLog(`query-correlation log failed: ${errorMessage(err)}`);
  }
}

/**
 * Mark correlations from a session as "helpful" when positive feedback is received.
 * This retroactively stamps entries so that future correlation lookups weight them higher.
 */
export function markCorrelationsHelpful(
  phrenPath: string,
  sessionId: string,
  docKey: string,
): void {
  if (!isQueryCorrelationEnabled()) return;

  try {
    const correlationFile = runtimeFile(phrenPath, CORRELATION_FILENAME);
    if (!fs.existsSync(correlationFile)) return;

    const raw = fs.readFileSync(correlationFile, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    let modified = false;

    const updated = lines.map((line) => {
      try {
        const entry: CorrelationEntry = JSON.parse(line);
        if (
          entry.sessionId === sessionId &&
          `${entry.project}/${entry.filename}` === docKey &&
          !entry.helpful
        ) {
          entry.helpful = true;
          modified = true;
          return JSON.stringify(entry);
        }
      } catch {
        // keep original line
      }
      return line;
    });

    if (modified) {
      fs.writeFileSync(correlationFile, updated.join("\n") + "\n");
    }
  } catch (err: unknown) {
    debugLog(`query-correlation mark-helpful failed: ${errorMessage(err)}`);
  }
}

/**
 * Tokenize a keyword string for overlap comparison.
 */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= MIN_TOKEN_LENGTH),
  );
}

/**
 * Find documents that historically correlate with the given query keywords.
 * Returns doc keys (project/filename) sorted by correlation strength.
 *
 * Only looks at the last RECENT_WINDOW entries for performance.
 * Entries marked "helpful" get a 2x weight boost.
 */
export function getCorrelatedDocs(
  phrenPath: string,
  keywords: string,
  limit = 3,
): string[] {
  if (!isQueryCorrelationEnabled()) return [];

  try {
    const correlationFile = runtimeFile(phrenPath, CORRELATION_FILENAME);
    if (!fs.existsSync(correlationFile)) return [];

    const raw = fs.readFileSync(correlationFile, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    // Only look at last RECENT_WINDOW entries to keep it fast
    const recent = lines.slice(-RECENT_WINDOW);

    const queryTokens = tokenize(keywords);
    if (queryTokens.size === 0) return [];

    const docScores = new Map<string, number>();

    for (const line of recent) {
      try {
        const entry: CorrelationEntry = JSON.parse(line);
        const entryTokens = tokenize(entry.keywords);

        // Calculate overlap between current query and past query
        let overlap = 0;
        for (const t of queryTokens) {
          if (entryTokens.has(t)) overlap++;
        }

        if (overlap >= MIN_TOKEN_OVERLAP) {
          const key = `${entry.project}/${entry.filename}`;
          // Helpful entries get a 2x weight boost
          const weight = entry.helpful ? overlap * 2 : overlap;
          docScores.set(key, (docScores.get(key) ?? 0) + weight);
        }
      } catch {
        // skip malformed lines
      }
    }

    return [...docScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([key]) => key);
  } catch (err: unknown) {
    debugLog(`query-correlation lookup failed: ${errorMessage(err)}`);
    return [];
  }
}

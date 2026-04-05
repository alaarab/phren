/**
 * Session metrics tracking.
 * Extracted from hooks-session.ts for modularity.
 */
import * as fs from "fs";
import * as path from "path";
import {
  debugLog,
  errorMessage,
  withFileLock,
  getQualityMultiplier,
  recordFeedback,
} from "./hooks-context.js";
import { sessionMetricsFile } from "../shared.js";
import type { SelectedSnippet } from "../shared/retrieval.js";

interface SessionMetric {
  prompts: number;
  keys: Record<string, number>;
  lastChangedCount: number;
  lastKeys: string[];
  lastSeen?: string;
}

function parseSessionMetrics(phrenPathLocal: string): Record<string, SessionMetric> {
  const file = sessionMetricsFile(phrenPathLocal);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, SessionMetric>;
  } catch (err: unknown) {
    debugLog(`parseSessionMetrics: failed to read ${file}: ${errorMessage(err)}`);
    return {};
  }
}

function writeSessionMetrics(phrenPathLocal: string, data: Record<string, SessionMetric>) {
  const file = sessionMetricsFile(phrenPathLocal);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

function updateSessionMetrics(
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

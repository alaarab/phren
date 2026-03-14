// Backward-compatible wrapper around finding-impact.
import {
  type FindingImpactEntry as ImpactEntry,
  findingIdFromLine,
  extractFindingIdsFromSnippet,
  logImpact,
  getHighImpactFindings,
  markImpactEntriesCompletedForSession,
} from "./finding-impact.js";

export type { ImpactEntry };

interface PendingImpactEntry {
  findingId: string;
  project: string;
  sessionId: string;
  taskCompleted: boolean;
}

export function impactEntryKey(project: string, findingId: string): string {
  return `${project}\u0000${findingId}`;
}

export {
  findingIdFromLine,
  extractFindingIdsFromSnippet,
  markImpactEntriesCompletedForSession,
};

export function appendImpactEntries(phrenPath: string, entries: PendingImpactEntry[]): void {
  const pending = entries.filter((entry) => !entry.taskCompleted);
  if (pending.length === 0) return;
  logImpact(phrenPath, pending.map((entry) => ({
    findingId: entry.findingId,
    project: entry.project,
    sessionId: entry.sessionId,
  })));
}

export function getHighImpactFindingKeys(phrenPath: string, minSuccessCount = 3): Set<string> {
  const findingIds = getHighImpactFindings(phrenPath, minSuccessCount);
  // Legacy API encoded project+findingId; new API tracks finding ID globally.
  // Return IDs as-is to preserve compatibility where only membership checks are used.
  return findingIds;
}

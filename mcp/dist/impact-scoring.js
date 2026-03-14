// Backward-compatible wrapper around finding-impact.
import { findingIdFromLine, extractFindingIdsFromSnippet, logImpact, getHighImpactFindings, markImpactEntriesCompletedForSession, } from "./finding-impact.js";
export function impactEntryKey(project, findingId) {
    return `${project}\u0000${findingId}`;
}
export { findingIdFromLine, extractFindingIdsFromSnippet, markImpactEntriesCompletedForSession, };
export function appendImpactEntries(phrenPath, entries) {
    const pending = entries.filter((entry) => !entry.taskCompleted);
    if (pending.length === 0)
        return;
    logImpact(phrenPath, pending.map((entry) => ({
        findingId: entry.findingId,
        project: entry.project,
        sessionId: entry.sessionId,
    })));
}
export function getHighImpactFindingKeys(phrenPath, minSuccessCount = 3) {
    const findingIds = getHighImpactFindings(phrenPath, minSuccessCount);
    // Legacy API encoded project+findingId; new API tracks finding ID globally.
    // Return IDs as-is to preserve compatibility where only membership checks are used.
    return findingIds;
}

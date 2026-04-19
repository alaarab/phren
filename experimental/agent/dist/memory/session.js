import { endSessionRecord, findMostRecentSummaryWithProject, incrementSessionStateCounter, loadLastSessionMessages as loadSharedLastSessionMessages, loadLastSessionSnapshot as loadSharedLastSessionSnapshot, saveSessionMessages as saveSharedSessionMessages, startSessionRecord, } from "@phren/cli/session/artifacts";
export function startSession(ctx) {
    return startSessionRecord(ctx.phrenPath, {
        project: ctx.project ?? undefined,
        agentCreated: true,
    });
}
export function endSession(ctx, sessionId, summary) {
    endSessionRecord(ctx.phrenPath, sessionId, summary);
}
export function incrementSessionCounter(phrenPath, sessionId, counter) {
    incrementSessionStateCounter(phrenPath, sessionId, counter);
}
export function getPriorSummary(ctx) {
    return findMostRecentSummaryWithProject(ctx.phrenPath, ctx.project ?? undefined).summary;
}
export function saveSessionMessages(phrenPath, sessionId, messages, project) {
    saveSharedSessionMessages(phrenPath, sessionId, messages, project);
}
export function loadLastSessionSnapshot(phrenPath, project) {
    const snapshot = loadSharedLastSessionSnapshot(phrenPath, project);
    if (!snapshot)
        return null;
    return {
        sessionId: snapshot.sessionId,
        project: snapshot.project,
        savedAt: snapshot.savedAt,
        messages: snapshot.messages,
    };
}
export function loadLastSessionMessages(phrenPath, project) {
    return loadSharedLastSessionMessages(phrenPath, project);
}

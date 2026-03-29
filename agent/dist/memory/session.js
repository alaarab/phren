import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
function sessionsDir(phrenPath) {
    const dir = path.join(phrenPath, ".runtime", "sessions");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
function sessionFile(phrenPath, sessionId) {
    return path.join(sessionsDir(phrenPath), `session-${sessionId}.json`);
}
export function startSession(ctx) {
    const sessionId = crypto.randomUUID();
    const state = {
        sessionId,
        project: ctx.project || undefined,
        startedAt: new Date().toISOString(),
        findingsAdded: 0,
        tasksCompleted: 0,
        agentCreated: true,
    };
    const file = sessionFile(ctx.phrenPath, sessionId);
    fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
    return sessionId;
}
export function endSession(ctx, sessionId, summary) {
    const file = sessionFile(ctx.phrenPath, sessionId);
    if (!fs.existsSync(file))
        return;
    try {
        const state = JSON.parse(fs.readFileSync(file, "utf-8"));
        state.endedAt = new Date().toISOString();
        if (summary) {
            // Also write to last-summary.json for fast pickup by next session_start
            const summaryFile = path.join(sessionsDir(ctx.phrenPath), "last-summary.json");
            fs.writeFileSync(summaryFile, JSON.stringify({
                summary,
                sessionId,
                project: state.project,
                endedAt: state.endedAt,
            }, null, 2) + "\n");
        }
        fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
    }
    catch { /* best effort */ }
}
export function incrementSessionCounter(phrenPath, sessionId, counter) {
    const file = sessionFile(phrenPath, sessionId);
    if (!fs.existsSync(file))
        return;
    try {
        const state = JSON.parse(fs.readFileSync(file, "utf-8"));
        state[counter] = (state[counter] ?? 0) + 1;
        fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
    }
    catch { /* best effort */ }
}
/** Read the most recent session summary for prior context. */
export function getPriorSummary(ctx) {
    try {
        const summaryFile = path.join(sessionsDir(ctx.phrenPath), "last-summary.json");
        if (!fs.existsSync(summaryFile))
            return null;
        const data = JSON.parse(fs.readFileSync(summaryFile, "utf-8"));
        return data.summary || null;
    }
    catch {
        return null;
    }
}
function messagesDir(phrenPath) {
    const dir = path.join(phrenPath, ".runtime", "sessions");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
/** Save session messages for later resume. */
export function saveSessionMessages(phrenPath, sessionId, messages) {
    const file = path.join(messagesDir(phrenPath), `session-${sessionId}-messages.json`);
    fs.writeFileSync(file, JSON.stringify(messages, null, 2) + "\n");
}
/** Load the last session's messages for resume. Returns null if none found. */
export function loadLastSessionMessages(phrenPath) {
    try {
        const dir = messagesDir(phrenPath);
        const files = fs.readdirSync(dir)
            .filter(f => f.endsWith("-messages.json"))
            .map(f => ({
            name: f,
            mtime: fs.statSync(path.join(dir, f)).mtimeMs,
        }))
            .sort((a, b) => b.mtime - a.mtime);
        if (files.length === 0)
            return null;
        const data = fs.readFileSync(path.join(dir, files[0].name), "utf-8");
        return JSON.parse(data);
    }
    catch {
        return null;
    }
}

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { withFileLock } from "../shared/governance.js";
import { atomicWriteJson, debugError, readSessionStateFile, scanSessionFiles, sessionFileForId, runtimeSessionsDir, writeSessionStateFile, } from "./utils.js";
function normalizeSummary(summary) {
    const trimmed = summary?.trim();
    return trimmed ? trimmed : undefined;
}
function sessionMessagesFileForId(phrenPath, sessionId) {
    return path.join(runtimeSessionsDir(phrenPath), `session-${sessionId}-messages.json`);
}
function inferProjectForSession(phrenPath, sessionId) {
    return readSessionState(phrenPath, sessionId)?.project;
}
function inferSavedAt(filePath) {
    try {
        return new Date(fs.statSync(filePath).mtimeMs).toISOString();
    }
    catch {
        return new Date(0).toISOString();
    }
}
function extractSessionIdFromMessageFile(filePath) {
    const match = path.basename(filePath).match(/^session-(.+)-messages\.json$/);
    return match?.[1] ?? "unknown";
}
function parseSessionMessagesSnapshot(filePath) {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (Array.isArray(parsed)) {
            return {
                schemaVersion: 1,
                sessionId: extractSessionIdFromMessageFile(filePath),
                savedAt: inferSavedAt(filePath),
                messages: parsed,
            };
        }
        if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.messages)) {
            return null;
        }
        return {
            schemaVersion: 1,
            sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : extractSessionIdFromMessageFile(filePath),
            project: typeof parsed.project === "string" ? parsed.project : undefined,
            savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : inferSavedAt(filePath),
            messages: parsed.messages,
        };
    }
    catch (err) {
        debugError("parseSessionMessagesSnapshot", err);
        return null;
    }
}
function listSessionMessageSnapshots(phrenPath) {
    const dir = runtimeSessionsDir(phrenPath);
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch (err) {
        debugError("listSessionMessageSnapshots readdir", err);
        return [];
    }
    const snapshots = [];
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.startsWith("session-") || !entry.name.endsWith("-messages.json"))
            continue;
        const fullPath = path.join(dir, entry.name);
        const snapshot = parseSessionMessagesSnapshot(fullPath);
        if (!snapshot)
            continue;
        let mtimeMs = 0;
        try {
            mtimeMs = fs.statSync(fullPath).mtimeMs;
        }
        catch {
            mtimeMs = 0;
        }
        snapshots.push({ snapshot, mtimeMs });
    }
    snapshots.sort((a, b) => {
        const bySavedAt = Date.parse(b.snapshot.savedAt) - Date.parse(a.snapshot.savedAt);
        if (!Number.isNaN(bySavedAt) && bySavedAt !== 0)
            return bySavedAt;
        return b.mtimeMs - a.mtimeMs;
    });
    return snapshots;
}
export function lastSummaryPath(phrenPath) {
    return path.join(runtimeSessionsDir(phrenPath), "last-summary.json");
}
export function readLastSummary(phrenPath) {
    try {
        const parsed = JSON.parse(fs.readFileSync(lastSummaryPath(phrenPath), "utf8"));
        if (!parsed || typeof parsed !== "object")
            return null;
        if (typeof parsed.summary !== "string" || typeof parsed.sessionId !== "string")
            return null;
        return {
            summary: parsed.summary,
            sessionId: parsed.sessionId,
            project: typeof parsed.project === "string" ? parsed.project : undefined,
            endedAt: typeof parsed.endedAt === "string" ? parsed.endedAt : undefined,
        };
    }
    catch (err) {
        if (err.code !== "ENOENT") {
            debugError("readLastSummary", err);
        }
        return null;
    }
}
export function writeLastSummary(phrenPath, record) {
    try {
        atomicWriteJson(lastSummaryPath(phrenPath), {
            summary: record.summary,
            sessionId: record.sessionId,
            project: record.project,
            endedAt: record.endedAt ?? new Date().toISOString(),
        });
    }
    catch (err) {
        debugError("writeLastSummary", err);
    }
}
export function findMostRecentSummaryWithProject(phrenPath, project) {
    const fastPath = readLastSummary(phrenPath);
    if (fastPath && (!project || fastPath.project === project)) {
        return fastPath;
    }
    const dir = runtimeSessionsDir(phrenPath);
    const results = scanSessionFiles(dir, readSessionStateFile, (state) => typeof state.summary === "string" && state.summary.trim().length > 0, { errorScope: "findMostRecentSummaryWithProject" });
    if (!project) {
        if (results.length === 0)
            return { summary: null };
        const best = results[0].data;
        return {
            summary: best.summary ?? null,
            sessionId: best.sessionId,
            project: best.project,
            endedAt: best.endedAt,
        };
    }
    const projectMatch = results.find(({ data }) => data.project === project);
    if (projectMatch) {
        return {
            summary: projectMatch.data.summary ?? null,
            sessionId: projectMatch.data.sessionId,
            project: projectMatch.data.project,
            endedAt: projectMatch.data.endedAt,
        };
    }
    if (results.length === 0)
        return { summary: null };
    const fallback = results[0].data;
    return {
        summary: fallback.summary ?? null,
        sessionId: fallback.sessionId,
        project: fallback.project,
        endedAt: fallback.endedAt,
    };
}
export function startSessionRecord(phrenPath, options = {}) {
    const sessionId = options.sessionId ?? crypto.randomUUID();
    const state = {
        sessionId,
        project: options.project,
        agentScope: options.agentScope,
        startedAt: new Date().toISOString(),
        findingsAdded: 0,
        tasksCompleted: 0,
        hookCreated: options.hookCreated,
        agentCreated: options.agentCreated,
    };
    writeSessionStateFile(sessionFileForId(phrenPath, sessionId), state);
    return sessionId;
}
export function readSessionState(phrenPath, sessionId) {
    return readSessionStateFile(sessionFileForId(phrenPath, sessionId));
}
export function endSessionRecord(phrenPath, sessionId, summary) {
    const file = sessionFileForId(phrenPath, sessionId);
    if (!fs.existsSync(file))
        return;
    const normalizedSummary = normalizeSummary(summary);
    try {
        withFileLock(file, () => {
            const current = readSessionStateFile(file);
            if (!current)
                return;
            const nextState = {
                ...current,
                endedAt: new Date().toISOString(),
                summary: normalizedSummary ?? current.summary,
                findingsAdded: Number.isFinite(current.findingsAdded) ? current.findingsAdded : 0,
                tasksCompleted: Number.isFinite(current.tasksCompleted) ? current.tasksCompleted : 0,
            };
            writeSessionStateFile(file, nextState);
            if (normalizedSummary) {
                writeLastSummary(phrenPath, {
                    summary: normalizedSummary,
                    sessionId,
                    project: nextState.project,
                    endedAt: nextState.endedAt,
                });
            }
        });
    }
    catch (err) {
        debugError("endSessionRecord", err);
    }
}
export function incrementSessionStateCounter(phrenPath, sessionId, field, count = 1) {
    const file = sessionFileForId(phrenPath, sessionId);
    if (!fs.existsSync(file))
        return;
    try {
        withFileLock(file, () => {
            const current = readSessionStateFile(file);
            if (!current)
                return;
            const currentValue = Number.isFinite(current[field]) ? current[field] : 0;
            writeSessionStateFile(file, {
                ...current,
                findingsAdded: Number.isFinite(current.findingsAdded) ? current.findingsAdded : 0,
                tasksCompleted: Number.isFinite(current.tasksCompleted) ? current.tasksCompleted : 0,
                [field]: currentValue + count,
            });
        });
    }
    catch (err) {
        debugError(`incrementSessionStateCounter(${field})`, err);
    }
}
export function saveSessionMessages(phrenPath, sessionId, messages, project) {
    const snapshot = {
        schemaVersion: 1,
        sessionId,
        project: project ?? inferProjectForSession(phrenPath, sessionId),
        savedAt: new Date().toISOString(),
        messages,
    };
    atomicWriteJson(sessionMessagesFileForId(phrenPath, sessionId), snapshot);
}
export function loadLastSessionSnapshot(phrenPath, project) {
    const snapshots = listSessionMessageSnapshots(phrenPath);
    if (snapshots.length === 0)
        return null;
    if (project) {
        const projectSnapshot = snapshots.find(({ snapshot }) => snapshot.project === project);
        if (projectSnapshot)
            return projectSnapshot.snapshot;
    }
    return snapshots[0]?.snapshot ?? null;
}
export function loadLastSessionMessages(phrenPath, project) {
    return loadLastSessionSnapshot(phrenPath, project)?.messages ?? null;
}

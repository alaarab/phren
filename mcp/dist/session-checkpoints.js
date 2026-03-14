import * as fs from "fs";
import * as path from "path";
import { errorMessage } from "./utils.js";
import { debugLog, sessionMarker } from "./shared.js";
import { atomicWriteJson } from "./session-utils.js";
function sanitizeFileSegment(value) {
    const trimmed = value.trim();
    const safe = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "_");
    return safe || "unknown";
}
function checkpointDir(phrenPath) {
    const probe = sessionMarker(phrenPath, "checkpoint-probe.json");
    return path.dirname(probe);
}
function checkpointFileName(project, taskId) {
    return `checkpoint-${sanitizeFileSegment(project)}-${sanitizeFileSegment(taskId)}.json`;
}
export function checkpointPath(phrenPath, project, taskId) {
    return sessionMarker(phrenPath, checkpointFileName(project, taskId));
}
function readCheckpointFile(filePath) {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (!parsed || typeof parsed !== "object")
            return null;
        if (typeof parsed.project !== "string" || typeof parsed.taskId !== "string" || typeof parsed.taskLine !== "string")
            return null;
        return {
            project: parsed.project,
            taskId: parsed.taskId,
            taskText: typeof parsed.taskText === "string" ? parsed.taskText : parsed.taskLine,
            taskLine: parsed.taskLine,
            sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
            createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
            resumptionHint: {
                lastAttempt: parsed.resumptionHint?.lastAttempt && typeof parsed.resumptionHint.lastAttempt === "string"
                    ? parsed.resumptionHint.lastAttempt
                    : "No prior attempt captured",
                nextStep: parsed.resumptionHint?.nextStep && typeof parsed.resumptionHint.nextStep === "string"
                    ? parsed.resumptionHint.nextStep
                    : parsed.taskLine,
            },
            gitStatus: typeof parsed.gitStatus === "string" ? parsed.gitStatus : "",
            editedFiles: Array.isArray(parsed.editedFiles) ? parsed.editedFiles.filter((v) => typeof v === "string") : [],
            failingTests: Array.isArray(parsed.failingTests) ? parsed.failingTests.filter((v) => typeof v === "string") : [],
        };
    }
    catch (err) {
        debugLog(`checkpoint read ${filePath}: ${errorMessage(err)}`);
        return null;
    }
}
export function writeTaskCheckpoint(phrenPath, checkpoint) {
    const filePath = checkpointPath(phrenPath, checkpoint.project, checkpoint.taskId);
    const normalizedCheckpoint = {
        ...checkpoint,
        taskText: checkpoint.taskText ?? checkpoint.taskLine,
    };
    atomicWriteJson(filePath, normalizedCheckpoint);
}
export function listTaskCheckpoints(phrenPath, project) {
    const dir = checkpointDir(phrenPath);
    let files;
    try {
        files = fs.readdirSync(dir);
    }
    catch {
        return [];
    }
    const rows = [];
    for (const name of files) {
        if (!name.startsWith("checkpoint-") || !name.endsWith(".json"))
            continue;
        const filePath = path.join(dir, name);
        const parsed = readCheckpointFile(filePath);
        if (!parsed)
            continue;
        if (project && parsed.project !== project)
            continue;
        let mtimeMs = 0;
        try {
            mtimeMs = fs.statSync(filePath).mtimeMs;
        }
        catch {
            // keep 0
        }
        rows.push({ checkpoint: parsed, mtimeMs });
    }
    rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return rows.map((row) => row.checkpoint);
}
export function clearTaskCheckpoint(phrenPath, args) {
    const ids = new Set();
    if (args.taskId)
        ids.add(args.taskId);
    if (args.stableId)
        ids.add(args.stableId);
    if (args.positionalId)
        ids.add(args.positionalId);
    let removed = 0;
    for (const id of ids) {
        const filePath = checkpointPath(phrenPath, args.project, id);
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                removed++;
            }
        }
        catch (err) {
            debugLog(`checkpoint clear ${filePath}: ${errorMessage(err)}`);
        }
    }
    const allProjectCheckpoints = listTaskCheckpoints(phrenPath, args.project);
    for (const checkpoint of allProjectCheckpoints) {
        const idMatch = ids.size > 0 && ids.has(checkpoint.taskId);
        const lineMatch = args.taskLine && checkpoint.taskLine === args.taskLine;
        if (!idMatch && !lineMatch)
            continue;
        const filePath = checkpointPath(phrenPath, checkpoint.project, checkpoint.taskId);
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                removed++;
            }
        }
        catch (err) {
            debugLog(`checkpoint clear scan ${filePath}: ${errorMessage(err)}`);
        }
    }
    return removed;
}

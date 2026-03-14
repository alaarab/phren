import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { runtimeDir, phrenOk, phrenErr, PhrenError } from "./shared.js";
import { withFileLock } from "./shared-governance.js";
import { addFindingToFile } from "./shared-content.js";
import { isValidProjectName, errorMessage } from "./utils.js";
function journalRoot(phrenPath) {
    const dir = path.join(runtimeDir(phrenPath), "finding-journal");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
function sanitizeSessionId(sessionId) {
    const raw = (sessionId || `session-${new Date().toISOString().slice(0, 10)}`).trim();
    const safe = raw.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
    return safe || "session";
}
function journalFileFor(phrenPath, project, sessionId) {
    const projectDir = path.join(journalRoot(phrenPath), project);
    fs.mkdirSync(projectDir, { recursive: true });
    return path.join(projectDir, `${sanitizeSessionId(sessionId)}.jsonl`);
}
function listJournalFiles(phrenPath, project) {
    const root = journalRoot(phrenPath);
    const projects = project ? [project] : fs.readdirSync(root).filter((entry) => fs.statSync(path.join(root, entry)).isDirectory());
    const files = [];
    for (const projectName of projects) {
        const projectDir = path.join(root, projectName);
        if (!fs.existsSync(projectDir))
            continue;
        for (const entry of fs.readdirSync(projectDir)) {
            if (!entry.endsWith(".jsonl"))
                continue;
            files.push(path.join(projectDir, entry));
        }
    }
    return files.sort();
}
export function appendFindingJournal(phrenPath, project, text, opts = {}) {
    if (!isValidProjectName(project))
        return phrenErr(`Invalid project name: "${project}".`, PhrenError.INVALID_PROJECT_NAME);
    const filePath = journalFileFor(phrenPath, project, opts.sessionId);
    const entry = {
        at: new Date().toISOString(),
        project,
        text,
        ...(opts.source ? { source: opts.source } : {}),
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        ...(opts.repo ? { repo: opts.repo } : {}),
        ...(opts.commit ? { commit: opts.commit } : {}),
        ...(opts.file ? { file: opts.file } : {}),
    };
    try {
        withFileLock(filePath, () => {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.appendFileSync(filePath, JSON.stringify(entry) + "\n");
        });
        return phrenOk(filePath);
    }
    catch (err) {
        return phrenErr(`Failed to append finding journal: ${errorMessage(err)}`, PhrenError.PERMISSION_DENIED);
    }
}
export function compactFindingJournals(phrenPath, project) {
    const result = {
        filesProcessed: 0,
        entriesProcessed: 0,
        added: 0,
        skipped: 0,
        failed: 0,
    };
    for (const filePath of listJournalFiles(phrenPath, project)) {
        const claimed = `${filePath}.${crypto.randomUUID()}.claim`;
        try {
            fs.renameSync(filePath, claimed);
        }
        catch {
            continue;
        }
        result.filesProcessed += 1;
        try {
            const entries = fs.readFileSync(claimed, "utf8")
                .split("\n")
                .filter(Boolean)
                .map((line) => {
                try {
                    return JSON.parse(line);
                }
                catch {
                    return null;
                }
            })
                .filter((entry) => Boolean(entry && entry.project && entry.text));
            for (const entry of entries) {
                result.entriesProcessed += 1;
                const write = addFindingToFile(phrenPath, entry.project, entry.text, {
                    ...(entry.repo ? { repo: entry.repo } : {}),
                    ...(entry.commit ? { commit: entry.commit } : {}),
                    ...(entry.file ? { file: entry.file } : {}),
                }, {
                    source: entry.source,
                    sessionId: entry.sessionId,
                });
                if (!write.ok) {
                    result.failed += 1;
                    continue;
                }
                if (typeof write.data === "string" && write.data.includes("Skipped duplicate"))
                    result.skipped += 1;
                else
                    result.added += 1;
            }
        }
        finally {
            try {
                fs.unlinkSync(claimed);
            }
            catch { }
        }
    }
    return result;
}

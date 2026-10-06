/** One line per sync outcome in background-sync.log, and the words doctor and status show for it. */
import * as fs from "fs";
import * as path from "path";
import { runtimeFile } from "../phren-paths.js";
import { debugLog } from "../shared.js";
import { errorMessage } from "../utils.js";
/** Commits on each side of the upstream, from the last fetched tracking ref. Undefined without an upstream. */
export async function aheadBehind(cwd, git) {
    try {
        const counts = await git(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
        const match = counts.ok ? /^(\d+)\s+(\d+)$/.exec((counts.output ?? "").trim()) : null;
        return match ? { ahead: Number(match[1]), behind: Number(match[2]) } : undefined;
    }
    catch (err) {
        debugLog(`ahead/behind: ${errorMessage(err)}`);
        return undefined;
    }
}
/** The first non-empty line of an error, bounded, for logs and one-line status text. */
export function firstLine(text, max = 200) {
    return (text ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, max) ?? "";
}
export function formatCounts(counts) {
    return counts && typeof counts.ahead === "number" && typeof counts.behind === "number"
        ? ` (ahead ${counts.ahead}, behind ${counts.behind})` : "";
}
/** Appends `[time] <source>: ok|failed <reason> (ahead N, behind M)` to the store's background-sync.log. */
export function logSyncOutcome(phrenPath, source, outcome) {
    // Long enough for a conflict detail to keep its whole file list.
    const reason = firstLine(outcome.detail, 1000);
    appendSyncLog(phrenPath, source, `${outcome.ok ? "ok" : "failed"}${reason ? ` ${reason}` : ""}${formatCounts(outcome.counts)}`);
}
export function appendSyncLog(phrenPath, source, detail) {
    try {
        const logPath = runtimeFile(phrenPath, "background-sync.log");
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${source}: ${detail}\n`);
    }
    catch (err) {
        debugLog(`${source} log: ${errorMessage(err)}`);
    }
}
/**
 * What doctor's runtime-auto-save check says: a failure names its first
 * error line and the ahead/behind counts instead of only "sync-failed".
 */
export function describeAutoSave(autoSave, sync) {
    if (!autoSave?.status)
        return "no auto-save runtime record yet";
    const at = autoSave.at ? ` @ ${autoSave.at}` : "";
    if (autoSave.status === "sync-failed" || autoSave.status === "error") {
        const reason = firstLine(autoSave.detail);
        const label = autoSave.status === "sync-failed" ? "sync failed" : "auto-save failed";
        return `${label}${reason ? `: ${reason}` : ""}${formatCounts(sync)}${at}`;
    }
    return `last auto-save: ${autoSave.status}${at}`;
}

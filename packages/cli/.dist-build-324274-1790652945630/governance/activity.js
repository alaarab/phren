import * as fs from "fs";
import * as path from "path";
import { lookupEventsLogFile } from "../phren-paths.js";
import { debugLog } from "../shared.js";
import { errorMessage } from "../utils.js";
const MAX_LOG_LINES = 500;
const ROTATE_BYTES = 500_000;
const MAX_SNIPPET_CHARS = 240;
function clampSnippet(snippet) {
    if (!snippet)
        return undefined;
    const flat = snippet.replace(/\s+/g, " ").trim();
    if (flat.length <= MAX_SNIPPET_CHARS)
        return flat;
    return flat.slice(0, MAX_SNIPPET_CHARS - 1) + "…";
}
/**
 * Append one or more lookup events to the live log. Best-effort: a logging
 * failure must never break a search, so all errors are swallowed (debug-logged).
 */
export function recordLookupEvents(phrenPath, events) {
    if (!events.length)
        return;
    const logPath = lookupEventsLogFile(phrenPath);
    try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        const now = new Date().toISOString();
        const lines = events.map((e) => JSON.stringify({
            at: e.at ?? now,
            query: e.query,
            project: e.project,
            filename: e.filename,
            type: e.type,
            ...(e.path ? { path: e.path } : {}),
            ...(e.nodeId ? { nodeId: e.nodeId } : {}),
            ...(e.snippet ? { snippet: clampSnippet(e.snippet) } : {}),
            source: e.source,
            ...(e.session ? { session: e.session } : {}),
        }));
        fs.appendFileSync(logPath, lines.join("\n") + "\n");
    }
    catch (err) {
        debugLog(`recordLookupEvents write failed: ${errorMessage(err)}`);
        return;
    }
    try {
        const stat = fs.statSync(logPath);
        if (stat.size > ROTATE_BYTES) {
            const content = fs.readFileSync(logPath, "utf8");
            const kept = content.split("\n").filter(Boolean).slice(-MAX_LOG_LINES);
            fs.writeFileSync(logPath, kept.join("\n") + "\n");
        }
    }
    catch (err) {
        debugLog(`recordLookupEvents rotation failed: ${errorMessage(err)}`);
    }
}
/** Read the most recent lookup events (newest first), parsed from the JSONL log. */
export function readRecentLookups(phrenPath, limit = 40) {
    const logPath = lookupEventsLogFile(phrenPath);
    try {
        if (!fs.existsSync(logPath))
            return [];
        const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
        const recent = lines.slice(-limit).reverse();
        const out = [];
        for (const line of recent) {
            try {
                const parsed = JSON.parse(line);
                if (parsed && typeof parsed.at === "string")
                    out.push(parsed);
            }
            catch {
                // Skip malformed lines rather than failing the whole read.
            }
        }
        return out;
    }
    catch (err) {
        debugLog(`readRecentLookups failed: ${errorMessage(err)}`);
        return [];
    }
}

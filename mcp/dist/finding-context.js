import * as fs from "fs";
import * as path from "path";
import { safeProjectPath } from "./utils.js";
import { resolveTaskFilePath } from "./data-tasks.js";
const ACTIVE_HEADINGS = new Set(["active", "in progress", "in-progress", "current", "wip"]);
const QUEUE_HEADINGS = new Set(["queue", "queued", "task", "todo", "upcoming", "next"]);
const DONE_HEADINGS = new Set(["done", "completed", "finished", "archived"]);
const BID_PATTERN = /\s*<!--\s*bid:([a-z0-9]{8})\s*-->/;
function stripBulletPrefix(line) {
    return line
        .replace(/^-\s*\[[ xX]\]\s+/, "")
        .replace(/^-\s+/, "")
        .trim();
}
function stripBid(text) {
    const match = text.match(BID_PATTERN);
    if (!match)
        return { clean: text.trimEnd() };
    return {
        clean: text.replace(BID_PATTERN, "").trimEnd(),
        bid: match[1],
    };
}
function normalizePriority(text) {
    const match = text.replace(/\s*\[pinned\]/gi, "").match(/\[(high|medium|low)\]\s*$/i);
    if (!match)
        return undefined;
    return match[1].toLowerCase();
}
function detectPinned(text) {
    return /\[pinned\]/i.test(text);
}
function parseTaskItems(taskPath) {
    if (!fs.existsSync(taskPath))
        return [];
    const lines = fs.readFileSync(taskPath, "utf8").split("\n");
    let section = "Queue";
    const counters = { Active: 0, Queue: 0, Done: 0 };
    const items = [];
    for (const line of lines) {
        const heading = line.trim().match(/^##\s+(.+?)[\s]*$/);
        if (heading) {
            const token = heading[1].replace(/\s+/g, " ").trim().toLowerCase();
            if (ACTIVE_HEADINGS.has(token))
                section = "Active";
            else if (QUEUE_HEADINGS.has(token))
                section = "Queue";
            else if (DONE_HEADINGS.has(token))
                section = "Done";
            continue;
        }
        if (!line.startsWith("- "))
            continue;
        counters[section] += 1;
        const itemId = `${section === "Active" ? "A" : section === "Queue" ? "Q" : "D"}${counters[section]}`;
        const stripped = stripBulletPrefix(line);
        const { clean, bid } = stripBid(stripped);
        items.push({
            id: itemId,
            stableId: bid,
            section,
            line: clean,
            priority: normalizePriority(clean),
            pinned: detectPinned(clean) || undefined,
        });
    }
    return items;
}
function resolveTaskItemMatch(items, match) {
    const needle = match.trim().toLowerCase();
    if (!needle)
        return { error: "task reference must not be empty." };
    const bidNeedle = needle.replace(/^bid:/, "");
    if (/^[a-f0-9]{8}$/.test(bidNeedle)) {
        const stable = items.find((item) => item.stableId === bidNeedle);
        if (stable?.stableId)
            return { stableId: stable.stableId };
    }
    const byId = items.find((item) => item.id.toLowerCase() === needle);
    if (byId?.stableId)
        return { stableId: byId.stableId };
    const exact = items.filter((item) => item.line.trim().toLowerCase() === needle);
    if (exact.length === 1) {
        if (!exact[0].stableId)
            return { error: `Task "${match}" does not have a stable ID yet.` };
        return { stableId: exact[0].stableId };
    }
    if (exact.length > 1) {
        return { error: `Task "${match}" is ambiguous (${exact.length} exact matches). Use item ID or stable ID.` };
    }
    const partial = items.filter((item) => item.line.toLowerCase().includes(needle));
    if (partial.length === 1) {
        if (!partial[0].stableId)
            return { error: `Task "${match}" does not have a stable ID yet.` };
        return { stableId: partial[0].stableId };
    }
    if (partial.length > 1) {
        return { error: `Task "${match}" is ambiguous (${partial.length} partial matches). Use item ID or stable ID.` };
    }
    return { error: `No task matching "${match}" in project tasks.` };
}
export function resolveFindingTaskReference(phrenPath, project, match) {
    const projectDir = safeProjectPath(phrenPath, project);
    if (!projectDir)
        return { error: `Invalid project name: "${project}".` };
    const taskPath = resolveTaskFilePath(phrenPath, project);
    const items = parseTaskItems(taskPath ?? path.join(projectDir, "tasks.md"));
    return resolveTaskItemMatch(items, match);
}
export function resolveAutoFindingTaskItem(phrenPath, project) {
    const projectDir = safeProjectPath(phrenPath, project);
    if (!projectDir)
        return undefined;
    const taskPath = resolveTaskFilePath(phrenPath, project);
    const active = parseTaskItems(taskPath ?? path.join(projectDir, "tasks.md")).filter((item) => item.section === "Active" && item.stableId);
    if (active.length === 1)
        return active[0].stableId;
    const pinned = active.filter((item) => item.pinned);
    if (pinned.length === 1)
        return pinned[0].stableId;
    const high = active.filter((item) => item.priority === "high");
    if (high.length === 1)
        return high[0].stableId;
    return undefined;
}
function sessionsDir(phrenPath) {
    return path.join(phrenPath, ".runtime", "sessions");
}
function listActiveSessions(phrenPath) {
    const dir = sessionsDir(phrenPath);
    if (!fs.existsSync(dir))
        return [];
    const sessions = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.startsWith("session-") || !entry.name.endsWith(".json"))
            continue;
        const fullPath = path.join(dir, entry.name);
        try {
            const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
            if (!parsed.sessionId || parsed.endedAt)
                continue;
            sessions.push(parsed);
        }
        catch {
            continue;
        }
    }
    return sessions;
}
function sessionSortValue(state) {
    if (state.startedAt) {
        const parsed = Date.parse(state.startedAt);
        if (!Number.isNaN(parsed))
            return parsed;
    }
    return 0;
}
export function resolveFindingSessionId(phrenPath, project, explicitSessionId) {
    const trimmed = explicitSessionId?.trim();
    if (trimmed)
        return trimmed;
    const active = listActiveSessions(phrenPath);
    if (active.length === 0)
        return undefined;
    const matchingProject = active
        .filter((session) => session.project === project)
        .sort((a, b) => sessionSortValue(b) - sessionSortValue(a));
    if (matchingProject.length > 0)
        return matchingProject[0].sessionId;
    const sorted = active.sort((a, b) => sessionSortValue(b) - sessionSortValue(a));
    return sorted[0]?.sessionId;
}

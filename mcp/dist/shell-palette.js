import { execFileSync } from "child_process";
import * as path from "path";
import { fileURLToPath } from "url";
import { runLink } from "./link.js";
import { runPhrenUpdate } from "./update.js";
import { EXEC_TIMEOUT_MS, } from "./shared.js";
export function resultMsg(r) {
    if (!r.ok)
        return r.error;
    return typeof r.data === "string" ? r.data : JSON.stringify(r.data);
}
export function editDistance(a, b) {
    const m = a.length;
    const n = b.length;
    const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++)
        dp[i][0] = i;
    for (let j = 0; j <= n; j++)
        dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}
export function tokenize(input) {
    const out = [];
    let current = "";
    let quote = null;
    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if ((ch === '"' || ch === "'") && (!quote || quote === ch)) {
            quote = quote ? null : ch;
            continue;
        }
        if (!quote && /\s/.test(ch)) {
            if (current) {
                out.push(current);
                current = "";
            }
            continue;
        }
        current += ch;
    }
    if (current)
        out.push(current);
    return out;
}
export function tasksByFilter(items, filter) {
    const needle = filter.toLowerCase().trim();
    if (!needle)
        return items;
    return items.filter((item) => `${item.id} ${item.line} ${item.context || ""} ${item.githubIssue ? `#${item.githubIssue}` : ""} ${item.githubUrl || ""}`.toLowerCase().includes(needle));
}
export function queueByFilter(items, filter) {
    const needle = filter.toLowerCase().trim();
    if (!needle)
        return items;
    return items.filter((item) => `${item.id} ${item.section} ${item.text}`.toLowerCase().includes(needle));
}
export function expandIds(input) {
    const parts = input.split(",").map((s) => s.trim()).filter(Boolean);
    const result = [];
    for (const part of parts) {
        const rangeMatch = part.match(/^([AQD])(\d+)-\1?(\d+)$/i);
        if (rangeMatch) {
            const prefix = rangeMatch[1].toUpperCase();
            const start = Number.parseInt(rangeMatch[2], 10);
            const end = Number.parseInt(rangeMatch[3], 10);
            for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
                result.push(`${prefix}${i}`);
            }
        }
        else {
            result.push(part);
        }
    }
    return result;
}
export function normalizeSection(sectionRaw) {
    const normalized = sectionRaw.toLowerCase();
    if (["active", "a"].includes(normalized))
        return "Active";
    if (["queue", "queued", "q"].includes(normalized))
        return "Queue";
    if (["done", "d"].includes(normalized))
        return "Done";
    return null;
}
// ── Infrastructure ───────────────────────────────────────────────────────────
export function resolveEntryScript() {
    const current = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(current), "index.js");
}
export async function defaultRunHooks(phrenPath) {
    const entry = resolveEntryScript();
    execFileSync(process.execPath, [entry, "hook-session-start"], {
        cwd: phrenPath,
        stdio: "ignore",
        timeout: EXEC_TIMEOUT_MS,
    });
    execFileSync(process.execPath, [entry, "hook-stop"], {
        cwd: phrenPath,
        stdio: "ignore",
        timeout: EXEC_TIMEOUT_MS,
    });
    return "Lifecycle hooks rerun (session-start + stop).";
}
export async function defaultRunUpdate() {
    const result = await runPhrenUpdate();
    return result.message;
}
export async function defaultRunRelink(phrenPath) {
    await runLink(phrenPath, { register: false, allTools: true });
    return "Relink completed for detected tools.";
}

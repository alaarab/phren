/**
 * Auto-capture: extract findings from error tool results.
 * Runs after each turn on error results only.
 */
import * as crypto from "crypto";
import { importCoreFinding } from "../phren-imports.js";
const SESSION_CAP = 10;
const COOLDOWN_MS = 30_000;
/** Patterns that indicate capturable knowledge in error output. */
const CAPTURE_PATTERNS = [
    { pattern: /ENOENT.*no such file/i, label: "missing-file" },
    { pattern: /EACCES|permission denied/i, label: "permission-error" },
    { pattern: /Cannot find module/i, label: "missing-module" },
    { pattern: /ERR_MODULE_NOT_FOUND/i, label: "missing-module" },
    { pattern: /ECONNREFUSED|ETIMEDOUT/i, label: "connection-error" },
    { pattern: /port\s+\d+\s+(already|in use)/i, label: "port-conflict" },
    { pattern: /deprecated/i, label: "deprecation" },
    { pattern: /version\s+mismatch|incompatible/i, label: "version-mismatch" },
    { pattern: /out of memory|heap|OOM/i, label: "memory-issue" },
    { pattern: /syntax\s*error/i, label: "syntax-error" },
    { pattern: /type\s*error.*is not a function/i, label: "type-error" },
    { pattern: /config(uration)?\s+(not found|missing|invalid)/i, label: "config-issue" },
    { pattern: /https?:\/\/\S+:\d+/i, label: "service-endpoint" },
    { pattern: /env\s+var(iable)?.*not set|missing.*env/i, label: "env-var" },
];
export function createCaptureState() {
    return { captured: 0, hashes: new Set(), lastCaptureTime: 0 };
}
function hashText(text) {
    return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}
/**
 * Analyze error output and auto-capture relevant findings.
 * Returns the number of findings captured this call.
 */
export async function analyzeAndCapture(ctx, errorOutput, state) {
    if (!ctx.project)
        return 0;
    if (state.captured >= SESSION_CAP)
        return 0;
    const now = Date.now();
    if (now - state.lastCaptureTime < COOLDOWN_MS)
        return 0;
    let captured = 0;
    for (const { pattern, label } of CAPTURE_PATTERNS) {
        if (state.captured + captured >= SESSION_CAP)
            break;
        const match = errorOutput.match(pattern);
        if (!match)
            continue;
        // Build a concise finding from the matched line
        const lines = errorOutput.split("\n");
        const matchedLine = lines.find((l) => pattern.test(l))?.trim() ?? match[0];
        const finding = `[auto-capture:${label}] ${matchedLine.slice(0, 200)}`;
        const hash = hashText(finding);
        if (state.hashes.has(hash))
            continue;
        try {
            const { addFinding } = await importCoreFinding();
            await addFinding(ctx.phrenPath, ctx.project, finding);
            state.hashes.add(hash);
            captured++;
        }
        catch {
            // best effort
        }
    }
    if (captured > 0) {
        state.captured += captured;
        state.lastCaptureTime = now;
    }
    return captured;
}

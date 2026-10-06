import { open } from "node:fs/promises";
import path from "node:path";
// How far back from the end of a rollout to look for the session's settings.
// A long Codex session writes tens of megabytes; one turn rarely spans more.
const SCAN_LIMIT = 64 * 1_048_576;
const CHUNK = 1_048_576;
/** Whether Codex's automatic reviewer, not the owner, decides this session's
 * approval requests. Codex runs the PermissionRequest hook before its reviewer
 * and the payload does not say which one will decide (permission_mode is
 * "default" either way), so read the settings the session itself recorded: the
 * latest turn_context or thread_settings_applied line in its rollout, which
 * follows /approvals changes mid-session. Codex routes a request to the
 * reviewer only with approvals_reviewer "auto_review" and an on-request or
 * granular approval policy; anything else, or a rollout that can't be read,
 * keeps the owner as the approver. */
export async function codexAutoReview(transcriptPath) {
    if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath)
        || !/^rollout-.*\.jsonl$/.test(path.basename(transcriptPath)))
        return false;
    const file = await open(transcriptPath, "r").catch(() => undefined);
    if (!file)
        return false;
    try {
        const size = (await file.stat()).size;
        let end = size, carry = Buffer.alloc(0);
        while (end > 0 && size - end < SCAN_LIMIT) {
            const start = Math.max(0, end - CHUNK), buffer = Buffer.alloc(end - start);
            await file.read(buffer, 0, buffer.length, start);
            const bytes = Buffer.concat([buffer, carry]);
            // Lines newest first; the bytes before the first newline may continue
            // a line that began in an earlier chunk, so they carry over.
            let lineEnd = bytes.length;
            for (let at = bytes.lastIndexOf(10, lineEnd - 1); at >= 0; at = bytes.lastIndexOf(10, lineEnd - 1)) {
                const settings = reviewSettings(bytes.subarray(at + 1, lineEnd).toString("utf8"));
                if (settings)
                    return autoReviewed(settings);
                lineEnd = at;
                if (at === 0)
                    break;
            }
            carry = bytes.subarray(0, lineEnd);
            end = start;
        }
        const settings = end === 0 ? reviewSettings(carry.toString("utf8")) : undefined;
        return !!settings && autoReviewed(settings);
    }
    catch {
        return false;
    }
    finally {
        await file.close().catch(() => { });
    }
}
function reviewSettings(line) {
    if (!line.includes("\"approvals_reviewer\"")
        || !(line.includes("\"type\":\"turn_context\"") || line.includes("\"type\":\"thread_settings_applied\"")))
        return undefined;
    try {
        const entry = JSON.parse(line);
        const payload = entry?.payload;
        const settings = entry?.type === "turn_context" ? payload
            : entry?.type === "event_msg" && payload?.type === "thread_settings_applied" ? payload.thread_settings : undefined;
        if (!settings || !("approvals_reviewer" in settings))
            return undefined;
        return { reviewer: settings.approvals_reviewer, policy: settings.approval_policy };
    }
    catch {
        return undefined;
    }
}
function autoReviewed({ reviewer, policy }) {
    return reviewer === "auto_review"
        && (policy === "on-request" || (!!policy && typeof policy === "object" && "granular" in policy));
}

/**
 * Git helpers for session hooks.
 * Extracted from hooks-session.ts for modularity.
 */
import { execFileSync } from "child_process";
import * as path from "path";
import { EXEC_TIMEOUT_MS, debugLog } from "../shared.js";
import { errorMessage, runGit } from "../utils.js";
import { nonInteractiveGitEnv } from "../utils-helpers.js";
import { withFileLock } from "../governance/locks.js";
import { runtimeFile } from "../phren-paths.js";
import { mergeStoreUpstream } from "../sync/store-merge.js";
import { aheadBehind, logSyncOutcome } from "../sync/outcome.js";
import { activeStoreAuthFailure, authBackoffActive, isGitAuthFailure, storeAuthDetail, withStoreAuthBackoff } from "../sync/auth.js";
export function getGitContext(cwd) {
    if (!cwd)
        return null;
    const git = (args) => runGit(cwd, args, EXEC_TIMEOUT_MS, debugLog);
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!branch)
        return null;
    const changedFiles = new Set();
    for (const changed of [
        git(["diff", "--name-only"]),
        git(["diff", "--name-only", "--cached"]),
    ]) {
        if (!changed)
            continue;
        for (const line of changed.split("\n").map((s) => s.trim()).filter(Boolean)) {
            changedFiles.add(line);
            const basename = path.basename(line);
            if (basename)
                changedFiles.add(basename);
        }
    }
    return { branch, changedFiles };
}
// ── Git command helpers ─────────────────────────────────────────────────────
function isTransientGitError(message) {
    return /(timed out|connection|network|could not resolve host|rpc failed|429|502|503|504|service unavailable)/i.test(message);
}
function shouldRetryGitCommand(args) {
    const cmd = args[0] || "";
    return cmd === "push" || cmd === "pull" || cmd === "fetch";
}
async function runBestEffortGitCommand(args, cwd) {
    const retries = shouldRetryGitCommand(args) ? 2 : 0;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const output = execFileSync("git", args, {
                cwd,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
                timeout: EXEC_TIMEOUT_MS,
                env: nonInteractiveGitEnv(),
            }).trim();
            return { ok: true, output };
        }
        catch (err) {
            const message = errorMessage(err);
            if (attempt < retries && !isGitAuthFailure(message) && isTransientGitError(message)) {
                const delayMs = 500 * (attempt + 1);
                await new Promise((resolve) => setTimeout(resolve, delayMs));
                continue;
            }
            return { ok: false, output: "", error: message };
        }
    }
    return { ok: false, output: "", error: "git command failed" };
}
const guardedSessionGit = withStoreAuthBackoff((cwd, args) => runBestEffortGitCommand(args, cwd));
export async function runBestEffortGit(args, cwd) {
    return guardedSessionGit(cwd, args);
}
/**
 * True when local HEAD and the tracking branch share no common ancestor.
 *
 * This is what happens when a store's remote is re-initialized: every
 * an ordinary pull cannot reconcile it, and the next commit re-enters the
 * same loop forever. A generic "pull failed" sends the user chasing
 * network problems, so it is worth naming — no retry will ever fix it.
 *
 * Returns false when there is no upstream, or when git cannot answer; callers
 * treat that as "some other failure" and report the raw error instead.
 */
export async function hasUnrelatedHistories(cwd) {
    const upstream = await runBestEffortGit(["rev-parse", "--abbrev-ref", "@{upstream}"], cwd);
    if (!upstream.ok || !upstream.output)
        return false;
    // Make sure we are comparing against what the remote actually has now.
    await runBestEffortGit(["fetch", "--quiet"], cwd);
    const localHead = await runBestEffortGit(["rev-parse", "HEAD"], cwd);
    const remoteHead = await runBestEffortGit(["rev-parse", upstream.output.trim()], cwd);
    if (!localHead.ok || !remoteHead.ok || !localHead.output || !remoteHead.output)
        return false;
    // `merge-base` exits non-zero with no output when the two commits are
    // unrelated, which is exactly the signal we want.
    const mergeBase = await runBestEffortGit(["merge-base", localHead.output.trim(), remoteHead.output.trim()], cwd);
    return !mergeBase.ok || !mergeBase.output?.trim();
}
/**
 * Files phren is allowed to auto-stage in a team store. Anything not in this
 * list (notably `.runtime/`, secrets, build output) is skipped on session-stop
 * and `push_changes`.
 */
export const TEAM_STORE_PATHSPECS = [
    "*/journal/*",
    "*/tasks.md",
    "*/truths.md",
    "*/FINDINGS.md",
    "*/FINDINGS.md.bak",
    "*/summary.md",
    "*/review.md",
    "*/AGENTS.md",
    "*/topic-config.json",
    "*/phren.project.yaml",
    "*/reference/**",
    "*/skills/**",
    "*/notes/**",
    ".phren-team.yaml",
];
export async function countUnsyncedCommits(cwd) {
    const upstream = await runBestEffortGit(["rev-parse", "--abbrev-ref", "@{upstream}"], cwd);
    if (!upstream.ok || !upstream.output) {
        const allCommits = await runBestEffortGit(["rev-list", "--count", "HEAD"], cwd);
        if (!allCommits.ok || !allCommits.output)
            return 0;
        const parsed = Number.parseInt(allCommits.output.trim(), 10);
        return Number.isNaN(parsed) ? 0 : parsed;
    }
    const ahead = await runBestEffortGit(["rev-list", "--count", `${upstream.output.trim()}..HEAD`], cwd);
    if (!ahead.ok || !ahead.output)
        return 0;
    const parsed = Number.parseInt(ahead.output.trim(), 10);
    return Number.isNaN(parsed) ? 0 : parsed;
}
const runSessionStoreGit = async (cwd, args) => {
    const result = await runBestEffortGitCommand(args, cwd);
    return { ok: result.ok, output: result.output ?? "", error: result.error };
};
/** Startup pulls share the store's Git lock and never rewrite local commits. */
export async function pullAtSessionStart(cwd, git = runSessionStoreGit, now = Date.now()) {
    const result = await pullAtSessionStartUnlogged(cwd, git, now);
    const counts = await aheadBehind(cwd, git);
    logSyncOutcome(cwd, "session-start-pull", { ok: result.ok, detail: result.ok ? result.output : result.error, counts });
    return counts ? { ...result, counts } : result;
}
async function pullAtSessionStartUnlogged(cwd, git, now) {
    try {
        return await withFileLock(runtimeFile(cwd, "git-op"), async () => {
            const auth = activeStoreAuthFailure(cwd);
            if (authBackoffActive(auth, now))
                return { ok: false, error: storeAuthDetail(auth) };
            const result = await mergeStoreUpstream(cwd, {
                git: withStoreAuthBackoff(git, () => now),
                commitMessage: "auto-save phren (session start)",
            });
            return result.status === "updated" || result.status === "unchanged"
                ? { ok: true, output: result.detail }
                : { ok: false, error: result.detail };
        });
    }
    catch (err) {
        return { ok: false, error: errorMessage(err) };
    }
}
export async function recoverPushConflict(cwd) {
    const merged = await mergeStoreUpstream(cwd, { git: withStoreAuthBackoff(runSessionStoreGit), commitLocalWrites: false });
    if (merged.status !== "updated" && merged.status !== "unchanged") {
        return { ok: false, detail: merged.detail, pullStatus: "error", pullDetail: merged.detail };
    }
    const retryPush = await runBestEffortGit(["push"], cwd);
    return {
        ok: retryPush.ok,
        detail: retryPush.ok ? "commit pushed after merging remote changes" : (retryPush.error || "push failed after merging remote changes"),
        pullStatus: "ok",
        pullDetail: merged.detail,
    };
}

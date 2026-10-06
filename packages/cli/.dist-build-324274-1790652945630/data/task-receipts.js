import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import * as path from "node:path";
const writes = new AsyncLocalStorage();
/** Scope receipts to one queued mutation, including its asynchronous claim sync. */
export async function captureTaskWrites(fn) {
    const state = {};
    return writes.run(state, async () => ({ result: await fn(), write: state.write?.receipt ?? null }));
}
/** Called only after the task file's atomic rename succeeds. */
export function recordTaskWrite(file, content) {
    const state = writes.getStore();
    if (state)
        state.write = { receipt: { path: path.resolve(file), commit: null }, content };
}
/**
 * Observe commits made by task claim sync without changing when it commits.
 * Keep the autosave's hash even if a later fetch/merge moves HEAD or push fails.
 * Reading HEAD alone would also acknowledge unrelated or failed commits.
 */
export function trackTaskWriteCommits(git) {
    return async (cwd, args) => {
        const write = writes.getStore()?.write;
        const committing = args[0] === "commit" || (args[0] === "-c" && args[2] === "commit");
        if (!write || !committing)
            return git(cwd, args);
        let before;
        try {
            before = await git(cwd, ["rev-parse", "--verify", "HEAD"]);
        }
        catch {
            return git(cwd, args);
        }
        const result = await git(cwd, args);
        if (!result.ok)
            return result;
        // Verification is best effort and must never turn a completed write into a failure.
        try {
            const relative = path.relative(path.resolve(cwd), write.receipt.path).split(path.sep).join("/");
            if (relative.startsWith("../") || path.isAbsolute(relative))
                return result;
            const head = await git(cwd, ["rev-list", "--parents", "-n", "1", "HEAD"]);
            if (!head.ok)
                return result;
            const [commit, ...parents] = head.output.trim().split(/\s+/);
            if (!/^[0-9a-f]{40,64}$/.test(commit))
                return result;
            if (before.ok ? parents.length !== 1 || parents[0] !== before.output.trim() : parents.length !== 0)
                return result;
            const tree = await git(cwd, ["ls-tree", commit, "--", relative]);
            const blob = tree.ok && /^\d+ blob ([0-9a-f]+)\t/.exec(tree.output)?.[1];
            if (!blob)
                return result;
            const expected = createHash(blob.length === 64 ? "sha256" : "sha1")
                .update(`blob ${Buffer.byteLength(write.content)}\0`).update(write.content).digest("hex");
            if (blob !== expected)
                return result;
            if (parents.length) {
                const prior = await git(cwd, ["ls-tree", parents[0], "--", relative]);
                if (!prior.ok || /^\d+ blob ([0-9a-f]+)\t/.exec(prior.output)?.[1] === blob)
                    return result;
            }
            write.receipt.commit = commit;
        }
        catch { /* Leave the receipt uncommitted when verification is unavailable. */ }
        return result;
    };
}

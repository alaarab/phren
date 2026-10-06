import { type Json } from "./protocol.js";
interface Run {
    code: number | null;
    output: string;
    missing: boolean;
    timedOut: boolean;
}
/** One process with stdout and stderr interleaved in arrival order, bounded,
 * never attached to a terminal and never prompting. */
export declare function runCombined(command: string, args: string[], cwd: string, timeout: number): Promise<Run>;
/** `git commit` of the index only: no `-a`, no `--no-verify`, no amend. A
 * hook's refusal comes back as `{ ok: false, output }`, exactly as printed. */
export declare function gitCommit(cwd: string, message: unknown): Promise<Json>;
/** The current branch to its upstream, or to `origin` with the upstream set.
 * Never forced: no `--force`, no `+` refspec, no `--no-verify`. The default
 * branch needs the phone's explicit `confirmDefault`. */
export declare function gitPush(cwd: string, confirmDefault: unknown): Promise<Json>;
/** `gh pr create --fill` for the current branch. A missing or signed-out gh
 * is `{ ok: false, reason: "missing" | "auth" }`; gh's own refusal is
 * `reason: "failed"` with its output. A pull request that already exists for
 * the branch comes back as success with `existing: true`. */
export declare function gitPullRequest(cwd: string, draft: unknown): Promise<Json>;
export {};

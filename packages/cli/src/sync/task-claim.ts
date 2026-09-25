import { runBestEffortGit } from "../cli/session-git.js";
import { claimTask, resolveTaskItem, type TaskClaim, type TaskItem } from "../data/tasks.js";
import { withFileLock } from "../governance/locks.js";
import { runtimeFile } from "../phren-paths.js";
import { mergeStoreUpstream, type RunStoreGit } from "./store-merge.js";

const git: RunStoreGit = async (cwd, args) => {
  const result = await runBestEffortGit(args, cwd);
  return { ok: result.ok, output: result.output ?? "", error: result.error };
};

export interface ClaimOutcome {
  /** True when this computer holds the claim after syncing; false after a release. */
  claimed: boolean;
  item?: TaskItem;
  /** The claim that won when another computer's reached the remote first. */
  heldBy?: TaskClaim;
  /** False when the claim could not reach the store's remote. */
  synced: boolean;
  detail: string;
  error?: string;
}

/**
 * Claims a task across unlinked conductors: pull the store so a claim already
 * pushed elsewhere refuses this one, write the claim, then commit and push.
 * When another computer's claim reached the remote first, the store merge
 * keeps theirs, so the task is read again after the push to see who won.
 */
export async function claimTaskSynced(phrenPath: string, project: string, match: string, claim: TaskClaim,
  opts: { release?: boolean; force?: boolean } = {}): Promise<ClaimOutcome> {
  return withFileLock(runtimeFile(phrenPath, "git-op"), async () => {
    const pulled = await mergeStoreUpstream(phrenPath, { git, commitMessage: "auto-save phren (task claim)" });
    const offline = pulled.status === "error" || pulled.status === "busy" ? pulled.detail : undefined;
    const written = claimTask(phrenPath, project, match, claim, opts);
    if (!written.ok) return { claimed: false, synced: !offline, detail: offline ?? "", error: written.error };
    const bid = written.data.stableId ?? match;
    const verb = opts.release ? "releases" : "claims";
    const saved = await mergeStoreUpstream(phrenPath, { git, commitMessage: `phren: ${claim.computer} ${verb} ${project} task ${bid}` });
    if (offline || saved.status === "error" || saved.status === "busy") {
      return { claimed: !opts.release, item: written.data, synced: false, detail: `The change is written on this computer but not synced: ${offline ?? saved.detail}` };
    }
    if (/no tracking remote/i.test(saved.detail)) {
      return { claimed: !opts.release, item: written.data, synced: false, detail: "The store has no remote, so the change is only on this computer." };
    }
    let pushed = await git(phrenPath, ["push", "--quiet"]);
    if (!pushed.ok) {
      const merged = await mergeStoreUpstream(phrenPath, { git, commitLocalWrites: false });
      pushed = merged.status === "updated" || merged.status === "unchanged" ? await git(phrenPath, ["push", "--quiet"]) : { ok: false, output: "", error: merged.detail };
    }
    const current = resolveTaskItem(phrenPath, project, bid);
    const now = current.ok ? current.data : undefined;
    if (!opts.release && now?.claim && now.claim.computer !== claim.computer) {
      return { claimed: false, item: now, heldBy: now.claim, synced: pushed.ok, detail: `${now.claim.computer} claimed this task first.` };
    }
    return { claimed: !opts.release, item: now ?? written.data, synced: pushed.ok,
      detail: pushed.ok ? "Pushed to the store's remote." : `Committed but not pushed: ${pushed.error ?? "push failed"}` };
  });
}

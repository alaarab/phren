/**
 * One full reconcile of a store with its remote: clean up abandoned state,
 * commit pending writes, merge the remote (diverged history included, see
 * store-merge.ts), push what the remote lacks, and record the outcome where
 * the Hook, `phren status` and doctor read it. The Hook runs this on a timer
 * for every store, so a computer nobody is typing on still converges.
 */
import * as fs from "fs";
import * as path from "path";
import { tryFileLock } from "../governance/locks.js";
import { getRuntimeHealth, updateRuntimeHealth, type SyncStatus } from "../governance/policy.js";
import { runtimeFile } from "../phren-paths.js";
import { isGitAuthFailure, withStoreAuthBackoff } from "./auth.js";
import { aheadBehind, firstLine, logSyncOutcome, type AheadBehind } from "./outcome.js";
import { periodicPullEnabled, runGitWithin, runPollGit } from "./pull.js";
import { resolveAllStores } from "../store-registry.js";
import { debugLog } from "../shared.js";
import { errorMessage } from "../utils.js";
import { cleanupStore } from "./store-cleanup.js";
import { mergeStoreUpstream, type RunStoreGit } from "./store-merge.js";

export type StoreSyncStatus = "unchanged" | "updated" | "pushed" | "conflict" | "busy" | "error" | "skipped";

export interface StoreSyncOutcome {
  status: StoreSyncStatus;
  detail: string;
  counts?: AheadBehind;
  backupRef?: string;
  /** Abandoned state removed before syncing, one line each. */
  cleaned: string[];
}

export interface StoreSyncOptions {
  git?: RunStoreGit;
  now?: number;
  /** A pull-only store never pushes. */
  push?: boolean;
  /** Names the caller in background-sync.log. */
  source?: string;
}

/** Hook store sync cadence; `PHREN_STORE_SYNC_SECONDS=0` turns it off. */
export const DEFAULT_STORE_SYNC_SECONDS = 300;
export function storeSyncSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PHREN_STORE_SYNC_SECONDS;
  if (raw === undefined || raw === "") return DEFAULT_STORE_SYNC_SECONDS;
  if (raw === "off") return 0;
  const seconds = Number(raw);
  return Number.isInteger(seconds) && seconds >= 0 ? (seconds === 0 ? 0 : Math.max(30, seconds)) : DEFAULT_STORE_SYNC_SECONDS;
}

export async function syncStore(store: string, options: StoreSyncOptions = {}): Promise<StoreSyncOutcome> {
  const now = options.now ?? Date.now();
  // A long-diverged store fetches and pushes far more than a poll's 10 s allows.
  const raw = options.git ?? ((cwd: string, args: string[]) => runGitWithin(120_000, cwd, args));
  const source = options.source ?? "store-sync";
  if (!fs.existsSync(path.join(store, ".git"))) return { status: "skipped", detail: "The store is not a Git repository.", cleaned: [] };

  const release = tryFileLock(runtimeFile(store, "git-op"));
  if (!release) return { status: "busy", detail: "Another Phren Git operation is running.", cleaned: [] };
  let outcome: StoreSyncOutcome;
  try {
    const cleaned = await cleanupStore(store, raw, { now });
    outcome = { ...(await reconcile(store, withStoreAuthBackoff(raw, () => now), options.push !== false)), cleaned };
  } finally { release(); }
  record(store, source, outcome, now);
  return outcome;
}

async function reconcile(store: string, git: RunStoreGit, push: boolean): Promise<Omit<StoreSyncOutcome, "cleaned">> {
  const merge = () => mergeStoreUpstream(store, { git, commitMessage: "auto-save phren (store sync)" });
  let merged = await merge();
  let backupRef = merged.backupRef;
  if (merged.status === "busy" || merged.status === "conflict" || merged.status === "error") {
    return { status: merged.status, detail: merged.detail, counts: await aheadBehind(store, git) };
  }
  let counts = await aheadBehind(store, git);
  if (!push || !counts || counts.ahead === 0) {
    return { status: merged.status, detail: merged.detail, counts, ...(backupRef ? { backupRef } : {}) };
  }
  let pushed = await git(store, ["push", "--quiet"]);
  // The remote moved between the merge and the push: merge once more.
  if (!pushed.ok && !isGitAuthFailure(pushed.error)) {
    merged = await merge();
    backupRef ??= merged.backupRef;
    if (merged.status === "updated" || merged.status === "unchanged") pushed = await git(store, ["push", "--quiet"]);
    else return { status: merged.status === "busy" ? "busy" : merged.status, detail: merged.detail, counts: await aheadBehind(store, git) };
  }
  counts = await aheadBehind(store, git);
  if (!pushed.ok) return { status: "error", detail: `Push failed: ${firstLine(pushed.error, 400) || "unknown Git error"}`, counts };
  return { status: "pushed", detail: `${merged.detail} Pushed local commits.`, counts, ...(backupRef ? { backupRef } : {}) };
}

function record(store: string, source: string, outcome: StoreSyncOutcome, now: number): void {
  if (outcome.status === "skipped" || outcome.status === "busy") return;
  const at = new Date(now).toISOString();
  const ok = outcome.status === "unchanged" || outcome.status === "updated" || outcome.status === "pushed";
  const previous = getRuntimeHealth(store).lastSync;
  const counts = outcome.counts ?? {};
  const patch: SyncStatus = ok
    ? {
      lastPullAt: at, lastPullStatus: "ok", lastPullDetail: outcome.detail, lastSuccessfulPullAt: at,
      ...(outcome.status === "pushed" || outcome.counts?.ahead === 0
        ? { lastPushAt: at, lastPushStatus: "saved-pushed", lastPushDetail: outcome.detail, lastSuccessfulPushAt: at, consecutiveFailures: 0, unsyncedCommits: 0 }
        : { unsyncedCommits: outcome.counts?.ahead ?? previous?.unsyncedCommits }),
      lastError: undefined, lastErrorAt: undefined,
      ...counts,
    }
    : {
      lastPullAt: at, lastPullStatus: "error", lastPullDetail: outcome.detail,
      lastPushAt: at, lastPushStatus: outcome.status === "conflict" ? "pull-failed" : "error", lastPushDetail: outcome.detail,
      consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
      lastError: firstLine(outcome.detail, 1000), lastErrorAt: at,
      ...(typeof outcome.counts?.ahead === "number" ? { unsyncedCommits: outcome.counts.ahead } : {}),
      ...counts,
    };
  updateRuntimeHealth(store, { lastSync: patch });
  // A quiet success is logged only when it follows a failure or changed something.
  if (!ok || outcome.status !== "unchanged" || previous?.lastError || outcome.cleaned.length) {
    const extra = [outcome.backupRef ? `kept ${outcome.backupRef}` : "", ...outcome.cleaned].filter(Boolean).join("; ");
    logSyncOutcome(store, source, { ok, detail: `${outcome.status}: ${outcome.detail}${extra ? ` (${extra})` : ""}`, counts: outcome.counts });
  }
}

/** Every store this computer has, in turn: a readonly or pull-only store only pulls. */
export async function syncAllStores(primary: string, options: Omit<StoreSyncOptions, "push"> = {}): Promise<Array<{ name: string; outcome: StoreSyncOutcome }>> {
  if (!periodicPullEnabled(primary)) return [];
  const results: Array<{ name: string; outcome: StoreSyncOutcome }> = [];
  for (const entry of resolveAllStores(primary).filter((store) => store.available !== false).slice(0, 16)) {
    const push = entry.role !== "readonly" && entry.sync !== "pull-only";
    results.push({ name: entry.name, outcome: await syncStore(entry.path, { ...options, push }) });
  }
  return results;
}

/** The Hook's sync loop: the first pass a minute after start, then every `seconds`. */
export function startStoreSyncLoop(primary: string, seconds = storeSyncSeconds()): { stop: () => void } {
  if (!seconds) return { stop: () => {} };
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void syncAllStores(primary, { source: "hook-sync" })
      .catch((err: unknown) => debugLog(`hook store sync: ${errorMessage(err)}`))
      .finally(() => { running = false; });
  };
  const first = setTimeout(tick, Math.min(60_000, seconds * 1000));
  const timer = setInterval(tick, seconds * 1000);
  first.unref(); timer.unref();
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}

/** A store with a remote that has not synced for this long is flagged. */
export const STORE_STALE_MS = 60 * 60 * 1000;

/** Diverged, stale and failing in one sentence, most urgent first. */
export function storeWarning(store: { name: string; ahead?: number; behind?: number; diverged?: boolean; stale?: boolean; error?: string; lastSyncedAt?: string }, now = Date.now()): string | undefined {
  const parts: string[] = [];
  if (store.diverged) parts.push(`diverged from its remote (${store.ahead} ahead, ${store.behind} behind)`);
  if (store.stale) {
    const at = store.lastSyncedAt ? Date.parse(store.lastSyncedAt) : Number.NaN;
    parts.push(Number.isNaN(at) ? "has not synced yet" : `has not synced for ${Math.max(1, Math.round((now - at) / 3_600_000))} h`);
  }
  if (store.error) parts.push(`last error: ${store.error}`);
  return parts.length ? `Store ${store.name} ${parts.join("; ")}` : undefined;
}

/** The newest successful pull or push in a store's sync record. */
export function lastSyncedAt(sync: SyncStatus | undefined): string | undefined {
  return [sync?.lastSuccessfulPullAt, sync?.lastSuccessfulPushAt].filter((at): at is string => !!at && !Number.isNaN(Date.parse(at)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

export interface StoreSyncState {
  name: string; upstream?: string; ahead?: number; behind?: number; lastSyncedAt?: string;
  diverged: boolean; stale: boolean; error?: string; warning?: string;
}

/** Where a store stands against its last-fetched upstream and its sync record; nothing is fetched. */
export async function storeSyncState(name: string, store: string, git: RunStoreGit = runPollGit, now = Date.now()): Promise<StoreSyncState> {
  const upstream = await git(store, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const state: StoreSyncState = { name, diverged: false, stale: false };
  const sync = getRuntimeHealth(store).lastSync;
  const synced = lastSyncedAt(sync);
  if (synced) state.lastSyncedAt = synced;
  if (sync?.lastError) state.error = sync.lastError;
  if (upstream.ok && upstream.output) {
    state.upstream = upstream.output;
    const counts = await aheadBehind(store, git);
    if (counts) Object.assign(state, counts);
    state.diverged = (state.ahead ?? 0) > 0 && (state.behind ?? 0) > 0;
    state.stale = !synced || now - Date.parse(synced) > STORE_STALE_MS;
  }
  const warning = storeWarning(state, now);
  if (warning) state.warning = warning;
  return state;
}

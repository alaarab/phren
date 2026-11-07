import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { readTasks, updateTask, type TaskItem } from "../data/tasks.js";
import { taskStores } from "../data/task-store-directory.js";
import { getStoreProjectDirs } from "../store-registry.js";
import { withFileLock } from "../governance/locks.js";
import { permissionDeniedError } from "../governance/rbac.js";
import { renameOverSync } from "../phren-paths.js";
import { resolveProjectGithubRepo } from "./github.js";
import { linksFromContext, parsePrLink, prUrl, uniqueLinks, type TaskLinks } from "./merge-links.js";

const exec = promisify(execFile);
const prStateSchema = z.object({ number: z.number().int().positive(), url: z.string(), state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  mergedAt: z.string().nullable(), mergeCommit: z.object({ oid: z.string() }).nullable(), headRefName: z.string().optional(), headRepository: z.object({ nameWithOwner: z.string() }).nullable().optional() });
export type PrState = z.infer<typeof prStateSchema>;
const fields = "number,url,state,mergedAt,mergeCommit,headRefName,headRepository";
const cacheSchema = z.record(z.string(), z.object({ at: z.number(), value: z.array(prStateSchema).optional() }));
const TTL = 15 * 60 * 1000;

/** Unknown acceptance prose is intentionally conservative; a human can finish it. */
export function mergeDecision(item: TaskItem, states: PrState[]): "done" | "merged, verify" | "closed, review" | undefined {
  if (!states.length) return undefined;
  if (states.some(pr => pr.state === "CLOSED")) return "closed, review";
  if (states.some(pr => pr.state !== "MERGED" || !pr.mergedAt || !Number.isFinite(Date.parse(pr.mergedAt)) || !/^[a-f0-9]{40,64}$/.test(pr.mergeCommit?.oid ?? ""))) return undefined;
  const text = [item.line, item.context, ...(item.opaqueContinuationLines ?? [])].join("\n");
  const acceptance = [...text.matchAll(/(?:acceptance|accepts?|done when)\s*:\s*([^\n]+)/gi)].map(m => m[1].trim());
  const mergeOnly = /^(?:PR\s+)?(?:is\s+)?merged?(?:\s+(?:to|into)\s+(?:main|master))?[.!]?$/i;
  return item.responsibility === "human" || item.dependencies?.length || item.taskContractRaw !== undefined
    || acceptance.some(value => !mergeOnly.test(value))
    || /\b(?:verify|verification|on.device|testflight|deploy|release|publish|ship|rollout|monitor|owner|manual|acceptance|done\s+when|smoke\s+test)\b/i.test(text.replace(/(?:acceptance|accepts?|done when)\s*:\s*(?:PR\s+)?(?:is\s+)?merged?(?:\s+(?:to|into)\s+(?:main|master))?[.!]?/gi, ""))
    ? "merged, verify" : "done";
}
export interface ReconcileSummary { dryRun: boolean; checked: number; done: number; review: number; linked: number; skipped: number; errors: number; requests: number }
function saveJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameOverSync(temp, file);
}
function readJson(file: string): unknown { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; } }

/** Read-only GitHub queries; all writes stay in the selected private stores. */
export async function reconcileTasks(base: string, options: { dryRun?: boolean; apply?: boolean; project?: string } = {}): Promise<ReconcileSummary> {
  const runtime = path.join(base, ".runtime", "task-reconcile");
  return withFileLock(runtime, async () => {
    const config = path.join(base, ".config", "task-reconcile.json");
    const enabled = (readJson(config) as { enabled?: boolean } | undefined)?.enabled === true;
    const dryRun = options.dryRun === true || (!options.apply && !enabled);
    const summary: ReconcileSummary = { dryRun, checked: 0, done: 0, review: 0, linked: 0, skipped: 0, errors: 0, requests: 0 };
    const cacheFile = `${runtime}.json`;
    const parsed = cacheSchema.safeParse(readJson(cacheFile));
    const cache = parsed.success ? parsed.data : {};
    let offline = !!cache.offline && Date.now() - cache.offline.at < TTL;
    const query = async (key: string, args: string[]): Promise<PrState[] | undefined> => {
      const hit = cache[key];
      if (hit && Date.now() >= hit.at && Date.now() - hit.at < TTL) return hit.value;
      if (offline || summary.requests >= 100) return undefined;
      summary.requests++;
      try {
        const { stdout } = await exec("gh", args, { encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1" }, windowsHide: true });
        const raw: unknown = JSON.parse(stdout);
        const result = z.array(prStateSchema).parse(Array.isArray(raw) ? raw : [raw]);
        cache[key] = { at: Date.now(), value: result };
        return result;
      } catch {
        // Stop after any failure (offline, auth, rate limit, missing/deleted PR).
        // Failure entries provide backoff, never completion evidence.
        offline = true; summary.errors++; cache[key] = { at: Date.now() }; cache.offline = { at: Date.now() };
        return undefined;
      }
    };
    const work: { store: ReturnType<typeof taskStores>[number]; project: string; snapshot: TaskItem; repo?: string }[] = [];
    for (const store of taskStores(base)) {
      if (store.role === "readonly" || store.available === false) continue;
      for (const directory of getStoreProjectDirs(store)) {
        const project = path.basename(directory);
        if (options.project && options.project !== project) continue;
        if (permissionDeniedError(store.path, "update_task", project)) continue;
        const doc = readTasks(store.path, project);
        if (!doc.ok || path.resolve(doc.data.path) !== path.join(path.resolve(store.path), project, "tasks.md")) continue;
        const repo = resolveProjectGithubRepo(store.path, project);
        for (const snapshot of [...doc.data.items.Active, ...doc.data.items.Queue]) work.push({ store, project, snapshot, repo });
      }
    }
    const progressFile = `${runtime}-progress.json`;
    const progress = readJson(progressFile) as { offsets?: Record<string, number> } | undefined;
    const scope = options.project ?? "*";
    const offsets = progress?.offsets ?? {};
    const offset = Number.isSafeInteger(offsets[scope]) && offsets[scope] >= 0 ? offsets[scope] % Math.max(work.length, 1) : 0;
    let resume = 0;
    for (let at = 0; at < work.length; at++) {
      const index = (offset + at) % work.length;
      if (summary.requests >= 100) { resume = index; break; }
      const { store, project, snapshot, repo } = work[index];
      // Re-read before each task: earlier completions change the document revision.
      const fresh = readTasks(store.path, project);
      if (!fresh.ok) { summary.errors++; continue; }
      const candidates = [...fresh.data.items.Active, ...fresh.data.items.Queue].filter(i => snapshot.stableId ? i.stableId === snapshot.stableId : i.line === snapshot.line);
      if (candidates.length !== 1) { summary.skipped++; continue; }
      const item = candidates[0];
      const match = item.stableId ? `bid:${item.stableId}` : item.id;
      if (item.checked || item.identityAmbiguous || /\[needs owner\]/i.test(item.line) || /\bneeds owner\b/i.test(item.context ?? "")
        || item.opaqueContinuationLines?.some(line => line.trim().startsWith("Links:"))) { summary.skipped++; continue; }
      const links = item.links ?? linksFromContext(item.context ?? "", repo);
      if (!links.prs.length && !links.branches.length) { summary.skipped++; continue; }
      summary.checked++;
      const prs = [...links.prs];
      let uncertain = false;
      // A branch-only link must resolve to exactly one PR. Deleted branches,
      // reused names and truncated results cannot prove a task is complete.
      if (!links.prs.length) for (const branch of links.branches) {
        const states = await query(`branch:${branch.repo}@${branch.name}`, ["pr", "list", "--repo", branch.repo, "--head", branch.name, "--state", "all", "--limit", "100", "--json", fields]);
        const ref = states?.length === 1 ? parsePrLink(states[0].url) : undefined;
        if (!ref || ref.repo.toLowerCase() !== branch.repo.toLowerCase() || states?.[0].headRefName !== branch.name
          || states?.[0].headRepository?.nameWithOwner.toLowerCase() !== branch.repo.toLowerCase()) uncertain = true;
        else prs.push(ref);
      }
      const states: PrState[] = [];
      for (const pr of uniqueLinks(prs)) {
        const found = await query(`pr:${pr.repo}#${pr.number}`, ["pr", "view", String(pr.number), "--repo", pr.repo, "--json", fields]);
        if (found?.length !== 1 || found[0].number !== pr.number || found[0].url.toLowerCase() !== prUrl(pr).toLowerCase()) uncertain = true;
        else states.push(found[0]);
      }
      // Resume this task next sweep if the budget expired mid-task.
      if (uncertain && summary.requests >= 100) { resume = index; break; }
      const decision = uncertain ? undefined : mergeDecision(item, states);
      const next: TaskLinks = { ...links, prs: uncertain ? links.prs : uniqueLinks(prs) };
      if (decision) {
        next.review = decision === "done" ? undefined : decision;
        next.evidence = states.filter(pr => pr.state !== "OPEN").map(pr => pr.state === "MERGED"
          ? `Merged ${pr.url} ${pr.mergeCommit?.oid} ${pr.mergedAt}` : `Closed unmerged ${pr.url}`);
      }
      const changed = JSON.stringify(item.links) !== JSON.stringify(next);
      if (!changed && decision !== "done") continue;
      if (!dryRun) {
        if (decision === "done" && permissionDeniedError(store.path, "complete_task", project)) { summary.skipped++; continue; }
        const result = updateTask(store.path, project, match, { links: next, ...(decision === "done" ? { section: "Done" } : {}) }, base, fresh.data.revision);
        if (!result.ok) { summary.errors++; continue; }
      }
      if (!item.links) summary.linked++;
      if (decision === "done") summary.done++;
      else if (decision) summary.review++;
    }
    saveJson(progressFile, { offsets: { ...offsets, [scope]: resume } });
    // Runtime cache is bounded and local; a dry run never changes task files or opts in.
    saveJson(cacheFile, Object.fromEntries(Object.entries(cache).filter(([, value]) => Date.now() - value.at < TTL).slice(-2000)));
    if (options.apply && !options.dryRun) saveJson(config, { enabled: true });
    return summary;
  });
}

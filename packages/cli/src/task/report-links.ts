import * as path from "node:path";
import { readTasks, updateTask } from "../data/tasks.js";
import { taskStores } from "../data/task-store-directory.js";
import { getStoreProjectDirs } from "../store-registry.js";
import { permissionDeniedError } from "../governance/rbac.js";
import type { TaskDependency } from "../data/task-contract.js";
import { parsePrLink, taskLinksSchema, uniqueLinks, type TaskLinks } from "./merge-links.js";

/** Record reports in the private task store. No Git/forge writes or fuzzy title matching. */
export function recordTaskPrs(base: string, reports: { url: string; repo: string; branch: string }[], task?: TaskDependency, dispatch?: string): { linked: boolean; error?: string } {
  const targets: { root: string; project: string; match: string; revision: string; links?: TaskLinks; branches: { repo: string; name: string }[]; prs: { repo: string; number: number }[] }[] = [];
  for (const store of taskStores(base)) {
    if (store.available === false || store.role === "readonly" || (task && store.taskStoreId !== task.storeId)) continue;
    for (const dir of getStoreProjectDirs(store)) {
      const project = path.basename(dir);
      if (task && task.project !== project) continue;
      const doc = readTasks(store.path, project);
      if (!doc.ok || !doc.data.revision || path.resolve(doc.data.path) !== path.join(path.resolve(store.path), project, "tasks.md")) continue;
      for (const item of [...doc.data.items.Active, ...doc.data.items.Queue]) {
        if (!(task ? item.stableId === task.stableId : dispatch && item.claim?.session === `task-launch:${dispatch}`)) continue;
        if (!item.stableId || item.identityAmbiguous) return { linked: false, error: "Ambiguous task identity." };
        targets.push({ root: store.path, project, match: `bid:${item.stableId}`, revision: doc.data.revision, links: item.links, branches: item.links?.branches ?? [], prs: item.links?.prs ?? [] });
      }
    }
  }
  if (targets.length !== 1) return { linked: false, ...(targets.length ? { error: "Ambiguous task association." } : {}) };
  const target = targets[0];
  if (permissionDeniedError(target.root, "update_task", target.project)) return { linked: false, error: "Task update denied." };
  const prs = reports.flatMap(report => {
    const pr = parsePrLink(report.url);
    return pr && pr.repo.toLowerCase() === report.repo.toLowerCase() ? [pr] : [];
  });
  if (prs.length !== reports.length) return { linked: false, error: "Report URLs must identify PRs in their reported repository." };
  const links = taskLinksSchema.safeParse({ ...target.links, version: 1, prs: uniqueLinks([...target.prs, ...prs]), branches: uniqueLinks([...target.branches, ...reports.map(report => ({ repo: report.repo, name: report.branch }))]) });
  if (!links.success) return { linked: false, error: "Invalid task links." };
  if (JSON.stringify(target.links) === JSON.stringify(links.data)) return { linked: true };
  const result = updateTask(target.root, target.project, target.match, { links: links.data }, base, target.revision);
  return result.ok ? { linked: true } : { linked: false, error: result.error };
}

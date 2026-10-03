import * as path from "node:path";
import * as fs from "node:fs";
import { withSafeLock } from "../shared/data-utils.js";
import type { PhrenResult } from "../shared.js";
import { resolveAllStores, registeredStoreIdentity, getStoreProjectDirs } from "../store-registry.js";
import { readTasks, stripBid, parseTaskContent, type TaskDoc, type TaskItem } from "./tasks.js";

export type TaskResponsibility = "human" | "agent";
export interface TaskDependency { storeId: string; project: string; stableId: string }
export interface TaskChange { at: string; change: string }
export interface TaskPrerequisite extends TaskDependency {
  title: string; responsibility: TaskResponsibility; completed: boolean; missing: boolean;
}
export interface TaskReadiness {
  responsibility: TaskResponsibility;
  readiness: "ready" | "waiting-on-human" | "waiting-on-task";
  prerequisites: TaskPrerequisite[];
}
/** Writers that can create cycles lock every writable attached store in path order.
 * Reciprocal links edited from different store roots serialize on the same locks. */
export function withTaskGraphLock<T>(base: string, fn: () => PhrenResult<T>): PhrenResult<T> {
  const roots = [...new Set(taskStores(base).filter(s => s.role !== "readonly" && s.available !== false).map(s => path.resolve(s.path)))].sort();
  const lock = (at: number): PhrenResult<T> => at === roots.length ? fn() : withSafeLock(path.join(roots[at], ".runtime", "task-dependencies"), () => lock(at + 1));
  return lock(0);
}
const key = (ref: TaskDependency) => `${ref.storeId}/${ref.project}/${ref.stableId}`;

/** Preserve local access roles/subscriptions while resolving portable IDs from
 * each target store. Duplicate canonical IDs remain ambiguous, never first-win. */
export function taskStores(base: string) {
  return resolveAllStores(base).map(entry => {
    // A synced registry may record another machine's primary checkout path.
    const store = entry.role === "primary" ? { ...entry, path: path.resolve(base), available: true } : entry;
    return { ...store, taskStoreId: store.available === false ? undefined : registeredStoreIdentity(store.path) };
  });
}

export function taskStoreHasProject(store: ReturnType<typeof taskStores>[number], project: string): boolean {
  return getStoreProjectDirs(store).some(dir => path.basename(dir) === project);
}

export function taskIdentity(phrenPath: string, doc: TaskDoc, item: TaskItem): TaskDependency | undefined {
  const stores = taskStores(phrenPath);
  const owner = stores.filter(s => path.resolve(s.path) === path.dirname(path.dirname(path.resolve(doc.path))));
  if (owner.length !== 1 || !item.stableId || !owner[0].taskStoreId || !taskStoreHasProject(owner[0], doc.project)) return undefined;
  const storeId = owner[0].taskStoreId;
  return stores.filter(s => s.taskStoreId === storeId).length === 1 ? { storeId, project: doc.project, stableId: item.stableId } : undefined;
}

function resolver(phrenPath: string, current?: TaskDoc) {
  const stores = taskStores(phrenPath);
  const cache = new Map<string, TaskDoc | undefined>();
  return (ref: TaskDependency): TaskItem | undefined => {
    const owners = stores.filter(s => s.taskStoreId === ref.storeId);
    if (owners.length !== 1 || owners[0].available === false || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(ref.project)) return undefined;
    if (!taskStoreHasProject(owners[0], ref.project)) return undefined;
    const file = path.join(owners[0].path, ref.project, "tasks.md");
    let doc: TaskDoc | undefined;
    if (current && path.resolve(current.path) === path.resolve(file)) doc = current;
    else {
      if (!cache.has(file)) {
        const result = readTasks(owners[0].path, ref.project);
        cache.set(file, result.ok && path.resolve(result.data.path) === path.resolve(file) ? result.data : undefined);
      }
      doc = cache.get(file);
    }
    const matches = doc ? [...doc.items.Active, ...doc.items.Queue, ...doc.items.Done].filter(i => i.stableId === ref.stableId) : [];
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return undefined;
    // Completed prerequisites remain satisfied after tidy archives their history.
    const archive = path.join(owners[0].path, ".config", "task-archive", `${ref.project}.md`);
    try {
      const source = fs.readFileSync(archive, "utf8").split("\n"), records: string[][] = [];
      for (let i = 0; i < source.length; i++) {
        if (!/^- \[[xX]\]/.test(source[i])) continue;
        if (stripBid(source[i]).bid !== ref.stableId) continue;
        const lines = [source[i]]; while (source[i + 1]?.startsWith("  ")) lines.push(source[++i]); records.push(lines);
      }
      if (records.length === 1) return parseTaskContent(ref.project, archive, `# Archive\n\n## Done\n\n${records[0].join("\n")}`).items.Done[0];
    } catch { /* An absent archive is not completion evidence. */ }
    return undefined;
  };
}

/** Derived, never persisted. Missing or unknown metadata blocks autonomous selection. */
export function taskReadiness(phrenPath: string, doc: TaskDoc, item: TaskItem): TaskReadiness {
  const resolve = resolver(phrenPath, doc);
  const prerequisites = (item.dependencies ?? []).map(ref => {
    const target = resolve(ref);
    return { ...ref, title: target?.line ?? `Unavailable prerequisite ${key(ref)}`, responsibility: target?.responsibility ?? "agent", completed: target?.section === "Done" || target?.checked === true, missing: !target };
  });
  const responsibility = item.responsibility ?? "agent";
  const waiting = prerequisites.filter(p => !p.completed);
  const invalid = item.dependencies?.length ? validateTaskDependencies(phrenPath, doc, item, item.dependencies) : undefined;
  const readiness = responsibility === "human" || waiting.some(p => p.responsibility === "human") ? "waiting-on-human"
    : item.taskContractRaw !== undefined || invalid || waiting.length ? "waiting-on-task" : "ready";
  return { responsibility, readiness, prerequisites };
}

export function taskView(phrenPath: string, doc: TaskDoc, item: TaskItem) {
  return { ...item, ...taskReadiness(phrenPath, doc, item), identity: taskIdentity(phrenPath, doc, item) ?? null };
}

export function validateTaskDependencies(phrenPath: string, doc: TaskDoc, item: TaskItem, refs: TaskDependency[]): string | undefined {
  if (!Array.isArray(refs) || refs.length > 100 || refs.some(r => !r || !/^[a-f0-9]{8}$/.test(r.storeId) || !/^[a-f0-9]{8}$/.test(r.stableId) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(r.project))) return "Dependencies require storeId, project and stableId (at most 100).";
  const own = taskIdentity(phrenPath, doc, item);
  if (!own) return "The task needs an unambiguous store identity and stable ID.";
  const resolve = resolver(phrenPath, doc);
  const complete = new Set<string>();
  const visiting = new Set<string>([key(own)]);
  let visited = 0;
  const visit = (ref: TaskDependency): string | undefined => {
    const id = key(ref);
    if (visiting.has(id)) return "Task dependencies cannot contain self-links or cycles.";
    if (complete.has(id)) return undefined;
    if (++visited > 10000 || visiting.size > 200) return "Dependency graph is too large to validate safely.";
    const target = resolve(ref);
    if (!target) return `Prerequisite ${id} is missing, unavailable or ambiguous.`;
    if (target.taskContractRaw !== undefined) return `Prerequisite ${id} has unsupported task metadata.`;
    visiting.add(id);
    for (const child of target.dependencies ?? []) { const error = visit(child); if (error) return error; }
    visiting.delete(id); complete.add(id);
    return undefined;
  };
  if (new Set(refs.map(key)).size !== refs.length) return "Duplicate task dependencies are not allowed.";
  for (const ref of refs) { const error = visit(ref); if (error) return error; }
  return undefined;
}

export interface TaskFilter { responsibility?: TaskResponsibility; readiness?: TaskReadiness["readiness"] }
export function filterTaskDoc(base: string, doc: TaskDoc, filter: TaskFilter): TaskDoc {
  if (!filter.responsibility && !filter.readiness) return doc;
  return { ...doc, items: Object.fromEntries(Object.entries(doc.items).map(([section, items]) => [section, items.filter(item => {
    const ready = taskReadiness(base, doc, item);
    return (!filter.responsibility || ready.responsibility === filter.responsibility) && (!filter.readiness || ready.readiness === filter.readiness);
  })])) as TaskDoc["items"] };
}
export function taskCounts(base: string, doc: TaskDoc) {
  const counts = { human: 0, agentReady: 0, agentWaitingOnHuman: 0, agentWaitingOnTask: 0, done: doc.items.Done.length };
  for (const item of [...doc.items.Active, ...doc.items.Queue]) {
    const ready = taskReadiness(base, doc, item);
    if (ready.responsibility === "human") counts.human++;
    else if (ready.readiness === "ready") counts.agentReady++;
    else if (ready.readiness === "waiting-on-human") counts.agentWaitingOnHuman++;
    else counts.agentWaitingOnTask++;
  }
  return counts;
}

import * as path from "node:path";
import * as fs from "node:fs";
import { withSafeLock } from "../shared/data-utils.js";
import type { PhrenResult } from "../shared.js";
import { resolveAllStores } from "../store-registry.js";
import { readTasks, type TaskDoc, type TaskItem } from "./tasks.js";

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
  const roots = [...new Set(resolveAllStores(base).filter(s => s.role !== "readonly" && s.available !== false).map(s => path.resolve(s.path)))].sort();
  const lock = (at: number): PhrenResult<T> => at === roots.length ? fn() : withSafeLock(path.join(roots[at], ".runtime", "task-dependencies"), () => lock(at + 1));
  return lock(0);
}
const key = (ref: TaskDependency) => `${ref.storeId}/${ref.project}/${ref.stableId}`;

export function taskIdentity(phrenPath: string, doc: TaskDoc, item: TaskItem): TaskDependency | undefined {
  const owner = resolveAllStores(phrenPath).filter(s => path.resolve(s.path) === path.dirname(path.dirname(path.resolve(doc.path))));
  return owner.length === 1 && item.stableId ? { storeId: owner[0].id, project: doc.project, stableId: item.stableId } : undefined;
}

function resolver(phrenPath: string, current?: TaskDoc) {
  const stores = resolveAllStores(phrenPath);
  const cache = new Map<string, TaskDoc | undefined>();
  return (ref: TaskDependency): TaskItem | undefined => {
    const owners = stores.filter(s => s.id === ref.storeId);
    if (owners.length !== 1 || owners[0].available === false || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(ref.project)) return undefined;
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
      const lines = fs.readFileSync(archive, "utf8").split("\n").filter(line => /^- \[[xX]\]/.test(line) && line.includes(`bid:${ref.stableId}`));
      if (lines.length === 1) return { id: `bid:${ref.stableId}`, stableId: ref.stableId, line: lines[0].replace(/^- \[[xX]\]\s*/, "").replace(/\s*<!--.*?-->/, ""), section: "Done", checked: true };
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
    : item.taskContractRaw || invalid || waiting.length ? "waiting-on-task" : "ready";
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
    if (target.taskContractRaw) return `Prerequisite ${id} has unsupported task metadata.`;
    visiting.add(id);
    for (const child of target.dependencies ?? []) { const error = visit(child); if (error) return error; }
    visiting.delete(id); complete.add(id);
    return undefined;
  };
  if (new Set(refs.map(key)).size !== refs.length) return "Duplicate task dependencies are not allowed.";
  for (const ref of refs) { const error = visit(ref); if (error) return error; }
  return undefined;
}

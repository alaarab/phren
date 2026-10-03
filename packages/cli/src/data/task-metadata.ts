/** Strict, side-effect-free validator shared by task parsing and three-way sync. */
import type { TaskChange, TaskDependency, TaskResponsibility } from "./task-contract.js";
export interface TaskMetadata { version: 1; responsibility: TaskResponsibility; dependencies: TaskDependency[]; history: TaskChange[] }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
export function isTaskDependency(value: unknown): value is TaskDependency {
  return record(value) && keys(value, ["storeId", "project", "stableId"])
    && typeof value.storeId === "string" && /^[a-f0-9]{8}$/.test(value.storeId)
    && typeof value.stableId === "string" && /^[a-f0-9]{8}$/.test(value.stableId)
    && typeof value.project === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value.project);
}
export function parseTaskMetadata(raw: string): TaskMetadata | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (!record(value) || !keys(value, ["version", "responsibility", "dependencies", "history"]) || value.version !== 1
      || (value.responsibility !== "human" && value.responsibility !== "agent")) return undefined;
    if (!Array.isArray(value.dependencies) || value.dependencies.length > 100 || value.dependencies.some(dep => !isTaskDependency(dep))) return undefined;
    if (!Array.isArray(value.history) || value.history.some(change => !record(change) || !keys(change, ["at", "change"]) || typeof change.at !== "string" || typeof change.change !== "string")) return undefined;
    return value as unknown as TaskMetadata;
  } catch { return undefined; }
}

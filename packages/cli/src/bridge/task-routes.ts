import { z } from "zod";
import * as path from "node:path";
import { getStoreProjectDirs } from "../store-registry.js";
import { readTasks, updateTask } from "../data/tasks.js";
import { taskView, taskCounts, filterTaskDoc, taskStores, taskStoreHasProject } from "../data/task-contract.js";
import { permissionDeniedError } from "../governance/rbac.js";
import { BridgeError } from "./protocol.js";
import { storeRepositoryIdentity } from "./memory-store.js";
import { taskFormatStatus } from "../data/task-format.js";

export const taskUpdatesSchema = z.object({
  responsibility: z.enum(["human", "agent"]).optional(),
  dependencies: z.array(z.object({ storeId: z.string().regex(/^[a-f0-9]{8}$/), project: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/), stableId: z.string().regex(/^[a-f0-9]{8}$/) }).strict()).max(100).optional(),
  section: z.enum(["Active", "Queue", "Done"]).optional(),
}).strict();
const identitySchema = z.object({ storeId: z.string().regex(/^[a-f0-9]{8}$/), project: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/), stableId: z.string().regex(/^[a-f0-9]{8}$/) });

function owner(base: string, id: string, write: boolean) {
  const matches = taskStores(base).filter(s => s.taskStoreId === id && s.available !== false);
  if (matches.length !== 1) throw new BridgeError(404, "Task store is unavailable or ambiguous.");
  if (write && matches[0].role === "readonly") throw new BridgeError(403, "Task store is read-only.");
  return matches[0];
}

/** Native clients discover portable identities without knowing filesystem paths
 * or accidentally treating machine-local attachment IDs as dependency IDs. */
export async function getTaskDirectoryRoute(base: string) {
  const stores = taskStores(base);
  return { ok: true, version: 1, stores: await Promise.all(stores.map(async store => {
    const ambiguous = !!store.taskStoreId && stores.filter(s => s.taskStoreId === store.taskStoreId).length !== 1;
    const identityReady = !!store.taskStoreId && !ambiguous;
    const repositoryIdentity = store.available === false ? undefined : await storeRepositoryIdentity(store.path);
    return {
      id: store.taskStoreId ?? null, name: store.name, role: store.role, primary: store.role === "primary", available: store.available !== false,
      identityReady, ambiguous, ...(repositoryIdentity ? { repositoryIdentity } : {}),
      metadataWritable: identityReady && store.role !== "readonly" && !permissionDeniedError(store.path, "update_task") && taskFormatStatus(store.path).enabled,
      projects: store.available === false ? [] : getStoreProjectDirs(store).map(dir => path.basename(dir))
        .filter(project => /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(project)).sort(),
    };
  })) };
}

export function getTaskRoute(base: string, url: URL) {
  const { storeId, project } = identitySchema.omit({ stableId: true }).parse(Object.fromEntries(url.searchParams));
  const store = owner(base, storeId, false);
  if (!taskStoreHasProject(store, project)) throw new BridgeError(404, "Project is not in that task store.");
  const result = readTasks(store.path, project);
  if (!result.ok) throw new BridgeError(400, result.error);
  if (path.resolve(result.data.path) !== path.join(path.resolve(store.path), project, "tasks.md")) throw new BridgeError(404, "Project is not in that task store.");
  const filter = z.object({ responsibility: z.enum(["human", "agent"]).optional(), readiness: z.enum(["ready", "waiting-on-human", "waiting-on-task"]).optional() }).parse(Object.fromEntries(url.searchParams));
  const filtered = filterTaskDoc(base, result.data, filter);
  return { ok: true, version: 1, storeId, project, metadataWritable: store.role !== "readonly" && !permissionDeniedError(store.path, "update_task", project) && taskFormatStatus(store.path).enabled, counts: taskCounts(base, result.data), items: Object.fromEntries(Object.entries(filtered.items).map(([section, items]) => [section, items.map(i => taskView(base, result.data, i))])) };
}

export function updateTaskRoute(base: string, input: unknown) {
  const data = identitySchema.extend({ updates: taskUpdatesSchema }).strict().parse(input);
  const store = owner(base, data.storeId, true);
  if (!taskStoreHasProject(store, data.project)) throw new BridgeError(404, "Project is not in that task store.");
  const denied = permissionDeniedError(store.path, "update_task", data.project);
  if (denied) throw new BridgeError(403, denied);
  const current = readTasks(store.path, data.project);
  if (!current.ok || path.resolve(current.data.path) !== path.join(path.resolve(store.path), data.project, "tasks.md")) throw new BridgeError(404, "Project is not in that task store.");
  const result = updateTask(store.path, data.project, `bid:${data.stableId}`, data.updates, base);
  if (!result.ok) throw new BridgeError(400, result.error);
  return getTaskRoute(base, new URL(`http://phren.local/v1/tasks?storeId=${data.storeId}&project=${data.project}`));
}

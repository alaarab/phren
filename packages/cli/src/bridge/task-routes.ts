import { z } from "zod";
import * as path from "node:path";
import { readTasks, updateTask, saveTask, taskRevisionConflict, type TaskDoc } from "../data/tasks.js";
import { taskView, taskCounts, filterTaskDoc, taskStores, taskStoreHasProject, type TaskFilter } from "../data/task-contract.js";
import { permissionDeniedError } from "../governance/rbac.js";
import { BridgeError } from "./protocol.js";
import { taskStoreProjects, taskStoreRepositoryIdentity } from "../data/task-store-directory.js";
import { nativeTaskWriteBlock, taskWriterSafety } from "../data/task-format.js";

export const taskUpdatesSchema = z.object({
  responsibility: z.enum(["human", "agent"]).optional(),
  dependencies: z.array(z.object({ storeId: z.string().regex(/^[a-f0-9]{8}$/), project: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/), stableId: z.string().regex(/^[a-f0-9]{8}$/) }).strict()).max(100).optional(),
  section: z.enum(["Active", "Queue", "Done"]).optional(),
}).strict();
const identitySchema = z.object({ storeId: z.string().regex(/^[a-f0-9]{8}$/), project: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/), stableId: z.string().regex(/^[a-f0-9]{8}$/) });
const textSchema = z.string().trim().min(1).max(10000).refine(value => !/[\x00-\x1f\x7f]|<!--\s*bid:/i.test(value));
const contextSchema = z.string().max(64000).refine(value => !/[\x00-\x1f\x7f]/.test(value)).nullable();
const saveBase = identitySchema.omit({ stableId: true }).extend({ expectedRevision: z.string().regex(/^[a-f0-9]{64}$/) });
export const taskSaveSchema = z.discriminatedUnion("mode", [
  saveBase.extend({ mode: z.literal("create"), task: z.object({
    text: textSchema, context: contextSchema.optional(), responsibility: z.enum(["human", "agent"]),
    dependencies: taskUpdatesSchema.shape.dependencies,
  }).strict() }).strict(),
  saveBase.extend({ mode: z.literal("update"), stableId: identitySchema.shape.stableId,
    updates: taskUpdatesSchema.extend({ text: textSchema.optional(), context: contextSchema.optional() }).strict()
      .refine(value => Object.keys(value).length > 0, "At least one update is required."),
  }).strict(),
]);

function owner(base: string, id: string, write: boolean) {
  const matches = taskStores(base).filter(s => s.taskStoreId === id);
  if (matches.length !== 1) throw new BridgeError(404, "Task store is unavailable or ambiguous.");
  if (matches[0].available === false) throw new BridgeError(404, "Task store is unavailable or ambiguous.");
  if (write && matches[0].role === "readonly") throw new BridgeError(403, "Task store is read-only.");
  return matches[0];
}

/** Explicit blocking capability for a client: Hook support is read support,
 * never evidence that an older MCP/CLI/sync/app writer has been replaced. */
function metadataAccess(store: ReturnType<typeof owner>, identityReady: boolean, projects: string[]) {
  const block = !identityReady ? "identity-unavailable" : store.role === "readonly" ? "readonly-store"
    : !projects.some(project => !permissionDeniedError(store.path, "update_task", project)) ? "permission-denied"
    : nativeTaskWriteBlock(store.path);
  return { metadataWritable: false, metadataWriteBlock: block };
}

/** Native clients discover portable identities without knowing filesystem paths
 * or accidentally treating machine-local attachment IDs as dependency IDs. */
export async function getTaskDirectoryRoute(base: string) {
  const stores = taskStores(base);
  return { ok: true, version: 1, saveContractVersion: 1, saveWritable: false, stores: await Promise.all(stores.map(async store => {
    const ambiguous = !!store.taskStoreId && stores.filter(s => s.taskStoreId === store.taskStoreId).length !== 1;
    const identityReady = !!store.taskStoreId && !ambiguous;
    const repositoryIdentity = store.available === false ? undefined : await taskStoreRepositoryIdentity(store.path);
    const projects = taskStoreProjects(store);
    return {
      id: store.taskStoreId ?? null, name: store.name, role: store.role, primary: store.role === "primary", available: store.available !== false,
      identityReady, ambiguous, ...(repositoryIdentity ? { repositoryIdentity } : {}),
      ...metadataAccess(store, identityReady, projects),
      writerSafety: store.available === false ? null : taskWriterSafety(store.path),
      projects,
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
  return taskResponse(base, store, result.data, filter);
}

function taskResponse(base: string, store: ReturnType<typeof owner>, doc: TaskDoc, filter: TaskFilter = {}) {
  const filtered = filterTaskDoc(base, doc, filter);
  return { ok: true, version: 1, storeId: store.taskStoreId!, project: doc.project, revision: doc.revision,
    saveContractVersion: 1, saveWritable: false, ...metadataAccess(store, true, [doc.project]), writerSafety: taskWriterSafety(store.path), counts: taskCounts(base, doc),
    items: Object.fromEntries(Object.entries(filtered.items).map(([section, items]) => [section, items.map(i => taskView(base, doc, i))])) };
}

function requireNativeTaskWrites(store: ReturnType<typeof owner>) {
  const code = nativeTaskWriteBlock(store.path);
  if (code) throw new BridgeError(409, "Task creation and metadata edits are blocked until installed writers have a compatible adoption fence.", { code });
}

export function updateTaskRoute(base: string, input: unknown) {
  const data = identitySchema.extend({ updates: taskUpdatesSchema }).strict().parse(input);
  const store = owner(base, data.storeId, true);
  if (!taskStoreHasProject(store, data.project)) throw new BridgeError(404, "Project is not in that task store.");
  const denied = permissionDeniedError(store.path, "update_task", data.project);
  if (denied) throw new BridgeError(403, denied);
  if (data.updates.responsibility !== undefined || data.updates.dependencies !== undefined) requireNativeTaskWrites(store);
  const current = readTasks(store.path, data.project);
  if (!current.ok || path.resolve(current.data.path) !== path.join(path.resolve(store.path), data.project, "tasks.md")) throw new BridgeError(404, "Project is not in that task store.");
  const result = updateTask(store.path, data.project, `bid:${data.stableId}`, data.updates, base);
  if (!result.ok) throw new BridgeError(400, result.error);
  return getTaskRoute(base, new URL(`http://phren.local/v1/tasks?storeId=${data.storeId}&project=${data.project}`));
}

/** Integrator wires POST /v1/tasks/save under the authenticated tasks module.
 * The schema/atomic engine are staged; the native adoption guard stays closed. */
export function saveTaskRoute(base: string, input: unknown) {
  const data = taskSaveSchema.parse(input);
  const store = owner(base, data.storeId, true);
  if (!taskStoreHasProject(store, data.project)) throw new BridgeError(404, "Project is not in that task store.");
  const operations = data.mode === "create" ? ["add_task", "update_task"] as const : ["update_task"] as const;
  for (const operation of operations) {
    const denied = permissionDeniedError(store.path, operation, data.project);
    if (denied) throw new BridgeError(403, denied);
  }
  requireNativeTaskWrites(store);
  const result = saveTask(store.path, data.project, data.expectedRevision, data, base);
  if (!result.ok) throw new BridgeError(result.error === taskRevisionConflict ? 409 : 400, result.error,
    { code: result.error === taskRevisionConflict ? "stale-task-revision" : "invalid-task-save" });
  return { ...taskResponse(base, store, result.data.doc), savedIdentity: result.data.identity };
}

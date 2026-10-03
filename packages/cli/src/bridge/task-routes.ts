import { z } from "zod";
import * as path from "node:path";
import { addTask, validTaskTitle, readTasks, updateTask, reserveTaskLaunch } from "../data/tasks.js";
import { taskView, taskCounts, filterTaskDoc, taskStores, taskStoreHasProject } from "../data/task-contract.js";
import { permissionDeniedError } from "../governance/rbac.js";
import { BridgeError, launchEfforts, PERMISSION_MODES, type Json } from "./protocol.js";
import { realpath, stat } from "node:fs/promises";
import { getProjectSourcePath } from "../project-config.js";
import { getMachineName } from "../machine-identity.js";
import { launchSession } from "./server-launch.js";
import { isAccountSlug } from "./claude-accounts.js";
import { taskStoreProjects, taskStoreRepositoryIdentity } from "../data/task-store-directory.js";
import { taskWriterSafety } from "../data/task-format.js";

export const taskUpdatesSchema = z.object({
  responsibility: z.enum(["human", "agent"]).optional(),
  dependencies: z.array(z.object({ storeId: z.string().regex(/^[a-f0-9]{8}$/), project: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/), stableId: z.string().regex(/^[a-f0-9]{8}$/) }).strict()).max(100).optional(),
  section: z.enum(["Active", "Queue", "Done"]).optional(),
}).strict();
const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
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
    const repositoryIdentity = store.available === false ? undefined : await taskStoreRepositoryIdentity(store.path);
    const writerSafety = store.available === false ? null : taskWriterSafety(store.path);
    return {
      id: store.taskStoreId ?? null, name: store.name, role: store.role, primary: store.role === "primary", available: store.available !== false,
      identityReady, ambiguous, ...(repositoryIdentity ? { repositoryIdentity } : {}),
      writerSafety,
      metadataWritable: identityReady && store.role !== "readonly" && !permissionDeniedError(store.path, "update_task") && writerSafety?.activation === "owner-acknowledged",
      projects: taskStoreProjects(store),
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
  const writerSafety = taskWriterSafety(store.path);
  return { ok: true, version: 1, storeId, project, revision: result.data.revision, writerSafety, metadataWritable: store.role !== "readonly" && !permissionDeniedError(store.path, "update_task", project) && writerSafety.activation === "owner-acknowledged", counts: taskCounts(base, result.data), items: Object.fromEntries(Object.entries(filtered.items).map(([section, items]) => [section, items.map(i => taskView(base, result.data, i))])) };
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

/** One locked write: a Human task is never observable as Agent-ready. The
 * client keeps one stable ID across uncertain replies; conflicts never recreate. */
export function createTaskRoute(base: string, input: unknown) {
  const data = identitySchema.extend({ text: z.string().min(1).max(16000).refine(validTaskTitle, "Task title must be one line without embedded task identities"),
    responsibility: z.enum(["human", "agent"]) }).strict().parse(input);
  const store = owner(base, data.storeId, true);
  if (!taskStoreHasProject(store, data.project)) throw new BridgeError(404, "Project is not in that task store.");
  for (const operation of ["add_task", "update_task"] as const) {
    const denied = permissionDeniedError(store.path, operation, data.project);
    if (denied) throw new BridgeError(403, denied);
  }
  const current = readTasks(store.path, data.project);
  if (!current.ok || path.resolve(current.data.path) !== path.join(path.resolve(store.path), data.project, "tasks.md")) throw new BridgeError(404, "Project is not in that task store.");
  const result = addTask(store.path, data.project, data.text, { stableId: data.stableId, responsibility: data.responsibility, graphRoot: base });
  if (!result.ok) throw new BridgeError(409, result.error);
  return getTaskRoute(base, new URL(`http://phren.local/v1/tasks?storeId=${data.storeId}&project=${data.project}`));
}

/** CAS applies the complete change set under the data layer's graph/document
 * locks. Empty context clears it; omitted fields retain their current value. */
export function saveTaskRoute(base: string, input: unknown) {
  const data = identitySchema.extend({ expectedRevision: revisionSchema, updates: taskUpdatesSchema.extend({
    text: z.string().min(1).max(16000).refine(validTaskTitle).optional(),
    context: z.string().max(14000).refine(value => !/[\x00-\x1f\x7f]/.test(value)).optional(),
  }).strict().refine(value => Object.keys(value).length > 0, "Supply at least one change.") }).strict().parse(input);
  const store = writableTaskProject(base, data.storeId, data.project);
  const result = updateTask(store.path, data.project, `bid:${data.stableId}`, { ...data.updates, replace_context: true }, base, data.expectedRevision);
  if (!result.ok) throw new BridgeError(409, result.error, { code: "task-save-conflict" });
  return getTaskRoute(base, new URL(`http://phren.local/v1/tasks?storeId=${data.storeId}&project=${data.project}`));
}

function writableTaskProject(base: string, storeId: string, project: string) {
  const store = owner(base, storeId, true);
  if (!taskStoreHasProject(store, project)) throw new BridgeError(404, "Project is not in that task store.");
  const denied = permissionDeniedError(store.path, "update_task", project);
  if (denied) throw new BridgeError(403, denied);
  const current = readTasks(store.path, project);
  if (!current.ok || path.resolve(current.data.path) !== path.join(path.resolve(store.path), project, "tasks.md")) throw new BridgeError(404, "Project is not in that task store.");
  if (taskWriterSafety(store.path).activation !== "owner-acknowledged") throw new BridgeError(409, "Task metadata is not enabled.");
  return store;
}

/** The task and prompt are bound by a durable reservation, before invoking the
 * ordinary launcher. Never roll back that claim after an uncertain side effect. */
export async function launchTaskRoute(base: string, server: string, input: unknown): Promise<Json> {
  const data = identitySchema.extend({ expectedRevision: revisionSchema, kind: z.enum(["claude", "codex", "opencode"]),
    model: z.string().min(1).max(200).refine(value => !/[\x00-\x1f\x7f]/.test(value)).optional(),
    effort: z.enum(launchEfforts).optional(), account: z.string().refine(isAccountSlug).optional(),
    permissionMode: z.enum(PERMISSION_MODES).optional(),
  }).strict().parse(input);
  if (data.kind === "opencode" && data.permissionMode !== undefined) throw new BridgeError(400, "OpenCode takes permissions from its own config.");
  const store = writableTaskProject(base, data.storeId, data.project);
  // Resolve the selected store's configured checkout, never another store's
  // same-named project or a caller-supplied path/prompt.
  const configured = getProjectSourcePath(store.path, data.project);
  const cwd = configured ? await realpath(configured).catch(() => undefined) : undefined;
  if (!cwd || !(await stat(cwd)).isDirectory()) throw new BridgeError(409, "This task project has no configured checkout on this computer.");
  // Async directory resolution must not leave stale store/rights admission.
  const currentStore = writableTaskProject(base, data.storeId, data.project);
  if (path.resolve(currentStore.path) !== path.resolve(store.path)) throw new BridgeError(409, "Task store changed; refresh before starting.");
  const reserved = reserveTaskLaunch(store.path, data.project, data.stableId, data.expectedRevision, getMachineName(), base);
  if (!reserved.ok) throw new BridgeError(409, reserved.error, { code: "task-launch-conflict" });
  const task = reserved.data;
  const text = `Work on task ${task.identity.storeId}/${task.identity.project}/${task.identity.stableId}.\n\n${task.text}${task.context ? `\n\nContext: ${task.context}` : ""}`;
  try {
    const launched = await launchSession(server, { kind: data.kind, model: data.model, effort: data.effort, account: data.account,
      permissionMode: data.permissionMode, role: "agent", cwd, label: task.text.slice(0, 200),
      launchId: task.launchId, brief: { id: task.launchId, text } }, { trustFolder: true });
    return { ...launched, task: task.identity, taskRevision: task.revision, launchId: task.launchId, claimPreserved: true,
      state: launched.briefState === "sent" ? "started" : "uncertain" };
  } catch (error) {
    throw new BridgeError(error instanceof BridgeError ? error.status : 503,
      "Task launch did not confirm success. Its reservation is preserved; review the worker and claim before retrying.",
      { ...(error instanceof BridgeError ? error.details : {}), code: "task-launch-uncertain", task: task.identity, launchId: task.launchId, claimPreserved: true });
  }
}

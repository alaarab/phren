// Shared task reads: Home and Tasks join in-flight requests and reuse them for a minute.
import { hookGet } from "../api.js";
import { store } from "./store.js";

export const TASK_FRESH_MS = 60_000;
const reads = new Map();
function read(key, fetch, force = false) {
  const cached = reads.get(key);
  if (cached && (cached.pending || (!force && Date.now() - cached.at < TASK_FRESH_MS))) return cached.promise;
  const entry = { at: Date.now(), pending: true };
  entry.promise = fetch().then((value) => { entry.pending = false; return value; }, (error) => {
    if (reads.get(key) === entry) reads.delete(key);
    throw error;
  });
  reads.set(key, entry);
  return entry.promise;
}
export const taskSourceKey = (source) => JSON.stringify([source.computer, source.id]);
const docKey = (source, project) => JSON.stringify([source.computer, source.id, project]);
export function loadTaskDoc(source, project, force = false) {
  return read(docKey(source, project), () => hookGet(source.computer, "/v1/tasks", { storeId: source.id, project }), force);
}
export function cacheTaskDoc(source, project, doc) {
  reads.set(docKey(source, project), { at: Date.now(), promise: Promise.resolve(doc), pending: false });
}
export async function loadTaskSources(computers) {
  const lists = await Promise.all(computers.filter((c) => c.state === "online").map(async (c) => {
    try {
      return await read(JSON.stringify([c.computer, "stores"]), async () => {
        const [caps, body] = await Promise.all([
          store.capabilities(c.computer), hookGet(c.computer, "/v1/tasks/stores"),
        ]);
        return (body.stores ?? []).filter((s) => s.id && s.available !== false && s.identityReady !== false && !s.ambiguous)
          .map((s) => ({ ...s, computer: c.computer, name: s.name || s.id, primary: !!s.primary,
            readonly: s.role === "readonly", contract: caps.taskDependencies === true,
            projects: Array.isArray(s.projects) ? s.projects : [] }));
      });
    } catch { return []; }
  }));
  return lists.flat().sort((a, b) => (b.primary - a.primary) || a.computer.localeCompare(b.computer) || a.name.localeCompare(b.name));
}

// Code index client. Resolves which project's index a session uses and reads
// that index through the Hook, per "Code index and search (phase 1c)".

import { hookGet, hookPost } from "./api.js";

const projectCache = new Map(); // computer + "\0" + repository -> { project, available }

/**
 * Resolve the registered project behind a session's repository, once per
 * computer+repository. Never throws: any failure is "no index".
 */
export async function resolveProject(computer, target) {
  try {
    const status = await hookPost(computer, "/v1/git/status", { target });
    const repository = status.repository;
    if (!repository) return { project: null, available: false };
    const key = `${computer}\0${repository}`;
    const hit = projectCache.get(key);
    if (hit) return hit;
    let result = { project: null, available: false };
    const { repos } = await hookGet(computer, "/v1/projects/repos");
    const entry = (repos || []).find((r) => r.directory === repository && r.registered);
    if (entry) {
      const codeStatus = await hookGet(computer, "/v1/code/status", { project: entry.name });
      result = { project: entry.name, available: codeStatus.available === true };
    }
    projectCache.set(key, result);
    return result;
  } catch {
    return { project: null, available: false };
  }
}

const CACHE_MS = 30_000;

/** A read-through view of one project's code index. */
export function makeIndex(computer, project) {
  const cache = new Map(); // path -> { refs?, outline? }, each { value, at }

  async function cached(path, field, load) {
    let entry = cache.get(path);
    if (!entry) { entry = {}; cache.set(path, entry); }
    const hit = entry[field];
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const value = await load();
    entry[field] = { value, at: Date.now() };
    return value;
  }

  return {
    fileReferences: (path) =>
      cached(path, "refs", () => hookGet(computer, "/v1/code/file-references", { project, path })),
    outline: (path) =>
      cached(path, "outline", () => hookGet(computer, "/v1/code/outline", { project, path })),
    definition: (name) => hookGet(computer, "/v1/code/definition", { project, name }),
    references: (name) => hookGet(computer, "/v1/code/references", { project, name, limit: 200 }),
    search: (q) => hookGet(computer, "/v1/code/search", { project, q, limit: 50 }),
    invalidate: (path) => { cache.delete(path); },
  };
}

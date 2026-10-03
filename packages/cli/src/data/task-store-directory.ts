import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readTaskStoreEntries, registeredStoreIdentity, getStoreProjectDirs } from "../store-registry.js";
import { githubStoreRepository } from "../bridge/memory-store.js";

const exec = promisify(execFile);

/** Local attachment roles/subscriptions authorize access; only the target's
 * synced primary ID identifies a task store on another machine. */
export function taskStores(base: string) {
  return readTaskStoreEntries(base).map(store => ({ ...store,
    taskStoreId: store.available === false ? undefined : registeredStoreIdentity(store.path),
  }));
}

export function taskStoreProjects(store: ReturnType<typeof taskStores>[number]): string[] {
  if (store.available === false) return [];
  try {
    return getStoreProjectDirs(store).map(dir => path.basename(dir))
      .filter(project => /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(project)).sort();
  } catch { return []; }
}

export function taskStoreHasProject(store: ReturnType<typeof taskStores>[number], project: string): boolean {
  return taskStoreProjects(store).includes(project);
}

/** The directory never snapshots Git or returns its stderr/remote/path. Only
 * bounded, read-only Git queries and the existing credential-stripping parser. */
export async function taskStoreRepositoryIdentity(store: string): Promise<{ repository: string; branch: string } | undefined> {
  const git = async (args: string[]) => exec("git", ["-C", store, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" }, timeout: 5000, maxBuffer: 8192,
  }).then(result => result.stdout.trim(), () => "");
  const [remote, branch] = await Promise.all([git(["config", "--get", "remote.origin.url"]), git(["symbolic-ref", "--quiet", "--short", "HEAD"])]);
  const repository = githubStoreRepository(remote);
  return repository && branch && !/[\x00-\x1f\x7f]/.test(branch) ? { repository, branch } : undefined;
}

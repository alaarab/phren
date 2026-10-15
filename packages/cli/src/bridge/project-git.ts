import { z } from "zod";
import { getProjectSourcePath } from "../project-config.js";
import { resolveProject } from "../store-routing.js";
import { isValidProjectName } from "../utils.js";
import { gitHostToken } from "./git-publish.js";
import { gitPulls } from "./git.js";
import { locateProject } from "./locate.js";
import { gitRoot } from "./projects.js";
import { BridgeError, type Json } from "./protocol.js";

/** Project git reads and token Connect share the same checkout lookup.
 *  `GET /v1/projects/:project/git`: the project's host, branch and open pull
 *  requests with their checks, read from its checkout on this computer, so the
 *  desktop's Projects page needs no session running there. */
export const PROJECT_GIT_ROUTE = /^\/v1\/projects\/([^/]+)\/git(?:\/(host-token))?$/;

/** The recorded source folder for this computer wins; otherwise the folders
 *  `/v1/projects/locate` offers, newest session first. */
async function projectCheckout(base: string, rawProject: string, activity: Json[]): Promise<{ project: string; directory: string }> {
  let project: string;
  try { project = decodeURIComponent(rawProject); } catch { throw new BridgeError(400, "Invalid project name."); }
  if (!isValidProjectName(project)) throw new BridgeError(400, "Invalid project name.");
  const folders: string[] = [];
  try {
    const source = getProjectSourcePath(resolveProject(base, project).store.path, project);
    if (source) folders.push(source);
  } catch { /* not in the store: located folders only */ }
  for (const candidate of await locateProject(project, activity)) folders.push(candidate.directory);
  for (const folder of folders) {
    const root = await gitRoot(folder).catch(() => undefined);
    if (root) return { project, directory: root };
  }
  throw new BridgeError(404, "No checkout of this project on this computer.", { code: "no-checkout" });
}

export async function projectGit(base: string, rawProject: string, activity: Json[]): Promise<Json> {
  const checkout = await projectCheckout(base, rawProject, activity);
  return { ...checkout, ...(await gitPulls(checkout.directory)) };
}

/** No pull-list read here: resolve locally before passing a token to the host. */
export async function projectHostToken(base: string, rawProject: string, activity: Json[], data: unknown): Promise<Json> {
  const request = z.object({ token: z.string().max(4096), expectedHost: z.string().trim().min(1).max(253) }).parse(data);
  const checkout = await projectCheckout(base, rawProject, activity);
  return gitHostToken(checkout.directory, request);
}

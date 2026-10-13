import { getProjectSourcePath } from "../project-config.js";
import { resolveProject } from "../store-routing.js";
import { isValidProjectName } from "../utils.js";
import { gitPulls } from "./git.js";
import { locateProject } from "./locate.js";
import { gitRoot } from "./projects.js";
import { BridgeError, type Json } from "./protocol.js";

/** `GET /v1/projects/:project/git`: the project's host, branch and open pull
 *  requests with their checks, read from its checkout on this computer, so the
 *  desktop's Projects page needs no session running there. */
export const PROJECT_GIT_ROUTE = /^\/v1\/projects\/([^/]+)\/git$/;

/** The recorded source folder for this computer wins; otherwise the folders
 *  `/v1/projects/locate` offers, newest session first. */
export async function projectGit(base: string, rawProject: string, activity: Json[]): Promise<Json> {
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
    if (root) return { project, directory: root, ...(await gitPulls(root)) };
  }
  throw new BridgeError(404, "No checkout of this project on this computer.", { code: "no-checkout" });
}

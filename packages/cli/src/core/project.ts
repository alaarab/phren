import * as path from "path";
import { phrenErr, phrenOk, readRootManifest, type PhrenResult } from "../shared.js";
import { bootstrapFromExisting } from "../init/setup.js";
import { resolveActiveProfile } from "../profile-store.js";
import type { ProjectOwnershipMode } from "../project-config.js";
import { TASKS_FILENAME } from "../data/tasks.js";
import { FINDINGS_FILENAME } from "../data/access.js";

interface AddedProjectData {
  project: string;
  path: string;
  profile: string | null;
  ownership: ProjectOwnershipMode;
  files: {
    claude: string | null;
    summary: string;
    findings: string;
    task: string;
  };
}

export function addProjectFromPath(
  phrenPath: string,
  targetPath: string | undefined,
  requestedProfile?: string,
  ownership?: ProjectOwnershipMode,
): PhrenResult<AddedProjectData> {
  if (!targetPath) {
    return phrenErr("Path is required. Pass the current project directory explicitly to avoid adding the wrong working directory.");
  }

  const activeProfile = resolveActiveProfile(phrenPath, requestedProfile);
  if (!activeProfile.ok) return activeProfile;

  const manifest = readRootManifest(phrenPath);
  const resolvedPath = path.resolve(targetPath);
  if (manifest?.installMode === "project-local") {
    const workspaceRoot = path.resolve(manifest.workspaceRoot || "");
    const matchesWorkspace = resolvedPath === workspaceRoot || resolvedPath.startsWith(workspaceRoot + path.sep);
    if (!matchesWorkspace) {
      return phrenErr(`Project-local phren can only add the owning workspace: ${workspaceRoot}`);
    }
  }
  const selectedProfile = activeProfile.data;
  const added = bootstrapFromExisting(phrenPath, resolvedPath, { profile: selectedProfile, ownership });

  return phrenOk({
    project: added.project,
    path: resolvedPath,
    profile: selectedProfile ?? null,
    ownership: added.ownership,
    files: {
      claude: added.claudePath,
      summary: path.join(phrenPath, added.project, "summary.md"),
      findings: path.join(phrenPath, added.project, FINDINGS_FILENAME),
      task: path.join(phrenPath, added.project, TASKS_FILENAME),
    },
  });
}

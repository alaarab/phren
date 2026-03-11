import * as path from "path";
import { cortexErr, cortexOk, type CortexResult } from "./shared.js";
import { bootstrapFromExisting } from "./init-setup.js";
import { resolveActiveProfile } from "./profile-store.js";
import type { ProjectOwnershipMode } from "./project-config.js";
import { TASKS_FILENAME } from "./data-tasks.js";

export interface AddedProjectData {
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
  cortexPath: string,
  targetPath: string | undefined,
  requestedProfile?: string,
  ownership?: ProjectOwnershipMode,
): CortexResult<AddedProjectData> {
  if (!targetPath) {
    return cortexErr("Path is required. Pass the current project directory explicitly to avoid adding the wrong working directory.");
  }

  const activeProfile = resolveActiveProfile(cortexPath, requestedProfile);
  if (!activeProfile.ok) return activeProfile;

  const resolvedPath = path.resolve(targetPath);
  const selectedProfile = activeProfile.data;
  const added = bootstrapFromExisting(cortexPath, resolvedPath, { profile: selectedProfile, ownership });

  return cortexOk({
    project: added.project,
    path: resolvedPath,
    profile: selectedProfile ?? null,
    ownership: added.ownership,
    files: {
      claude: added.claudePath,
      summary: path.join(cortexPath, added.project, "summary.md"),
      findings: path.join(cortexPath, added.project, "FINDINGS.md"),
      task: path.join(cortexPath, added.project, TASKS_FILENAME),
    },
  });
}

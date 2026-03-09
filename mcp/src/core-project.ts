import * as path from "path";
import { cortexErr, cortexOk, type CortexResult } from "./shared.js";
import { bootstrapFromExisting } from "./init-setup.js";
import { resolveActiveProfile } from "./profile-store.js";

export interface AddedProjectData {
  project: string;
  path: string;
  profile: string | null;
  files: {
    claude: string;
    summary: string;
    findings: string;
    backlog: string;
  };
}

export function addProjectFromPath(
  cortexPath: string,
  targetPath: string | undefined,
  requestedProfile?: string,
): CortexResult<AddedProjectData> {
  if (!targetPath) {
    return cortexErr("Path is required. Pass the current project directory explicitly to avoid adding the wrong working directory.");
  }

  const activeProfile = resolveActiveProfile(cortexPath, requestedProfile);
  if (!activeProfile.ok) return activeProfile;

  const resolvedPath = path.resolve(targetPath);
  const selectedProfile = activeProfile.data;
  const projectName = bootstrapFromExisting(cortexPath, resolvedPath, selectedProfile);

  return cortexOk({
    project: projectName,
    path: resolvedPath,
    profile: selectedProfile ?? null,
    files: {
      claude: path.join(cortexPath, projectName, "CLAUDE.md"),
      summary: path.join(cortexPath, projectName, "summary.md"),
      findings: path.join(cortexPath, projectName, "FINDINGS.md"),
      backlog: path.join(cortexPath, projectName, "backlog.md"),
    },
  });
}

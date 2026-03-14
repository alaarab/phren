import * as path from "path";
import { phrenErr, phrenOk, readRootManifest } from "./shared.js";
import { bootstrapFromExisting } from "./init-setup.js";
import { resolveActiveProfile } from "./profile-store.js";
import { TASKS_FILENAME } from "./data-tasks.js";
export function addProjectFromPath(phrenPath, targetPath, requestedProfile, ownership) {
    if (!targetPath) {
        return phrenErr("Path is required. Pass the current project directory explicitly to avoid adding the wrong working directory.");
    }
    const activeProfile = resolveActiveProfile(phrenPath, requestedProfile);
    if (!activeProfile.ok)
        return activeProfile;
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
            findings: path.join(phrenPath, added.project, "FINDINGS.md"),
            task: path.join(phrenPath, added.project, TASKS_FILENAME),
        },
    });
}

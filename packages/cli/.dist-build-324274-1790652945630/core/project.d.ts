import { type PhrenResult } from "../shared.js";
import type { ProjectOwnershipMode } from "../project-config.js";
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
interface AddProjectFromPathOptions {
    writeToPath?: string;
}
export declare function addProjectFromPath(phrenPath: string, targetPath: string | undefined, requestedProfile?: string, ownership?: ProjectOwnershipMode, options?: AddProjectFromPathOptions): PhrenResult<AddedProjectData>;
export {};

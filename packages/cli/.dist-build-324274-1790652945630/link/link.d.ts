import { type McpMode } from "../init/init.js";
export { runDoctor } from "./doctor.js";
export { updateFileChecksums, verifyFileChecksums } from "./checksums.js";
export { findProjectDir } from "../project-locator.js";
export { parseSkillFrontmatter, validateSkillFrontmatter, validateSkillsDir, readSkillManifestHooks, } from "./skills.js";
export type { ManifestHooks, SkillFrontmatter, } from "./skills.js";
interface LinkOptions {
    machine?: string;
    profile?: string;
    register?: boolean;
    task?: "debugging" | "planning" | "clean";
    allTools?: boolean;
    mcp?: McpMode;
}
export interface DoctorResult {
    ok: boolean;
    machine?: string;
    profile?: string;
    checks: Array<{
        name: string;
        ok: boolean;
        detail: string;
    }>;
}
export { getMachineName } from "../machine-identity.js";
export declare function lookupProfile(phrenPath: string, machine: string): string;
export declare function findProfileFile(phrenPath: string, profileName: string): string | null;
export declare function getProfileProjects(profileFile: string): string[];
export declare function runLink(phrenPath: string, opts?: LinkOptions): Promise<void>;

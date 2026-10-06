import { type ProjectOwnershipMode } from "../project-config.js";
import { type BuiltinTopic } from "../project-topics.js";
/** Project domain used to pick starter topics and the AGENTS.md template. */
export type InitProjectDomain = "software" | "music" | "game" | "research" | "writing" | "creative" | "other";
interface BootstrapProjectOptions {
    profile?: string;
    profilePhrenPath?: string;
    ownership?: ProjectOwnershipMode;
}
interface BootstrapProjectResult {
    project: string;
    ownership: ProjectOwnershipMode;
    claudePath: string | null;
}
export interface InferredInitScaffold {
    domain: InitProjectDomain;
    topics: BuiltinTopic[];
    referenceHints: string[];
    commandHints: string[];
    confidence: number;
    reason: string;
}
export declare function inferInitScaffoldFromRepo(repoRoot: string, fallbackDomain?: InitProjectDomain): InferredInitScaffold | null;
export declare function ensureProjectScaffold(projectDir: string, projectName: string, domain?: InitProjectDomain, inference?: InferredInitScaffold | null): void;
export declare function bootstrapFromExisting(phrenPath: string, projectPath: string, opts?: string | BootstrapProjectOptions): BootstrapProjectResult;
export {};

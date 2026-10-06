import type { ProjectOwnershipMode } from "../project-config.js";
import { type ManagementPreset } from "./management-preset.js";
import type { ProactivityLevel } from "../proactivity.js";
import { type InitProjectDomain, type InferredInitScaffold } from "./setup.js";
import type { McpMode } from "./shared.js";
type WorkflowRiskSection = "Review" | "Stale" | "Conflicts";
type StorageLocationChoice = "global" | "project" | "custom";
export type WalkthroughChoice<T extends string> = {
    value: T;
    name: string;
    description?: string;
};
export type WalkthroughPromptUi = {
    input(message: string, initialValue?: string): Promise<string>;
    confirm(message: string, defaultValue?: boolean): Promise<boolean>;
    select<T extends string>(message: string, choices: WalkthroughChoice<T>[], defaultValue?: T): Promise<T>;
};
export type WalkthroughStyle = {
    header: (text: string) => string;
    success: (text: string) => string;
    warning: (text: string) => string;
};
export declare function withFallbackColors(style?: {
    header?: (text: string) => string;
    success?: (text: string) => string;
    warning?: (text: string) => string;
}): WalkthroughStyle;
export declare function createWalkthroughStyle(): Promise<WalkthroughStyle>;
export declare function createWalkthroughPrompts(): Promise<WalkthroughPromptUi>;
/** Adapts an Inquirer module, or returns null when it offers neither API. */
export declare function walkthroughPromptsFrom(inquirerModule: unknown): WalkthroughPromptUi | null;
export interface WalkthroughResult {
    storageChoice: StorageLocationChoice;
    storagePath: string;
    storageRepoRoot?: string;
    machine: string;
    profile: string;
    mcp: McpMode;
    hooks: McpMode;
    projectOwnershipDefault: ProjectOwnershipMode;
    managementPreset: ManagementPreset;
    findingsProactivity: ProactivityLevel;
    taskProactivity: ProactivityLevel;
    lowConfidenceThreshold: number;
    riskySections: WorkflowRiskSection[];
    taskMode: "off" | "manual" | "suggest" | "auto";
    bootstrapCurrentProject: boolean;
    bootstrapOwnership?: ProjectOwnershipMode;
    ollamaEnabled: boolean;
    autoCaptureEnabled: boolean;
    semanticDedupEnabled: boolean;
    semanticConflictEnabled: boolean;
    findingSensitivity: "minimal" | "conservative" | "balanced" | "aggressive";
    githubUsername?: string;
    githubRepo?: string;
    /** Create the private repo with gh and push, instead of printing the steps. */
    githubCreate?: boolean;
    /** Install Phren Hook and show the pairing QR code once setup finishes. */
    connectPhone?: boolean;
    cloneUrl?: string;
    domain: InitProjectDomain;
    inferredScaffold?: InferredInitScaffold;
}
export interface WalkthroughOptions {
    /** When true, skip the express prompt and use recommended defaults immediately */
    express?: boolean;
    /** When true, skip the express prompt and ask about every setting */
    advanced?: boolean;
    /** The signed-in GitHub login from gh, for the sync offer; injectable for tests */
    githubLogin?: () => Promise<string | undefined>;
}
/** The login gh is signed in as, or undefined when gh is missing or signed out. */
export declare function ghLogin(): Promise<string | undefined>;
export declare function runWalkthrough(phrenPath: string, options?: WalkthroughOptions): Promise<WalkthroughResult>;
export {};

import { type PhrenResult } from "./shared.js";
import type { RetentionPolicyPatch } from "./governance/policy.js";
export interface ProfilePolicyDefaults {
    findingSensitivity?: "minimal" | "conservative" | "balanced" | "aggressive";
    proactivity?: "high" | "medium" | "low";
    proactivityFindings?: "high" | "medium" | "low";
    proactivityTask?: "high" | "medium" | "low";
    taskMode?: "off" | "manual" | "suggest" | "auto";
    retentionPolicy?: RetentionPolicyPatch;
    workflowPolicy?: {
        lowConfidenceThreshold?: number;
        riskySections?: Array<"Review" | "Stale" | "Conflicts">;
    };
}
export interface ProfileInfo {
    name: string;
    description?: string;
    file: string;
    projects: string[];
    defaults?: ProfilePolicyDefaults;
}
export interface ProjectCard {
    name: string;
    summary: string;
    docs: string[];
    /** Name of the non-primary store this project lives in, if any. */
    store?: string;
}
export declare function resolveActiveProfile(phrenPath: string, requestedProfile?: string): PhrenResult<string | undefined>;
/** Explain implicit selection without changing the selected profile. */
export declare function describeProfileMapping(phrenPath: string): {
    machine: string;
    mapped: boolean;
    assumed?: string;
};
export declare function getDefaultMachineAlias(): string;
export declare function listMachines(phrenPath: string): PhrenResult<Record<string, string>>;
export declare function setMachineProfile(phrenPath: string, machine: string, profile: string): PhrenResult<string>;
export declare function getActiveProfileDefaults(phrenPath: string, profile?: string): ProfilePolicyDefaults | undefined;
export declare function listProfiles(phrenPath: string): PhrenResult<ProfileInfo[]>;
export declare function addProjectToProfile(phrenPath: string, profile: string, project: string): PhrenResult<string>;
export declare function removeProjectFromProfile(phrenPath: string, profile: string, project: string): PhrenResult<string>;
export declare function listProjectCards(phrenPath: string, profile?: string): ProjectCard[];

import { type FindingSensitivityLevel } from "../shared/governance.js";
export declare const FINDING_SENSITIVITY_CONFIG: Record<FindingSensitivityLevel, {
    sessionCap: number;
    proactivityFindings: string;
    agentInstruction: string;
}>;
export declare function handleConfigTaskMode(args: string[]): void;
export declare function handleConfigFindingSensitivity(args: string[]): void;
export declare function handleIndexPolicy(args: string[]): Promise<void>;
export declare function handleRetentionPolicy(args: string[]): Promise<void>;
export declare function handleWorkflowPolicy(args: string[]): Promise<void>;

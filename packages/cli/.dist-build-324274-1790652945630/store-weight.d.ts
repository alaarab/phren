import { homePath } from "./phren-paths.js";
export interface StoreWeight {
    projects: number;
    /** Words in FINDINGS.md files (active findings). */
    findings: number;
    /** Words under reference/, the archive. */
    reference: number;
    tasks: number;
    skills: number;
    /** Words in the global AGENTS.md every session loads. */
    globalClaude: number;
}
export declare function storeWeight(phrenPath: string, profile?: string): StoreWeight;
/** Median tokens the prompt hook injected per prompt, from the live lookup log's hook events. */
export declare function medianHookInjectionTokens(phrenPath: string, lastPrompts?: number): {
    prompts: number;
    medianTokens: number;
};
export declare const CONTEXT_COST_LIMITS: {
    globalClaudeWords: number;
    medianInjectionTokens: number;
};
export { homePath };

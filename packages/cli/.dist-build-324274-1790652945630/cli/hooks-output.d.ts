import type { SelectedSnippet, GitContext } from "../shared/retrieval.js";
export declare function buildHookOutput(selected: SelectedSnippet[], usedTokens: number, intent: string, gitCtx: GitContext | null, detectedProject: string | null, stage: Record<string, number>, tokenBudget: number, phrenPathLocal: string, sessionId?: string): string[];

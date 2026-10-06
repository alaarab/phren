export declare function handleHookTool(): Promise<void>;
interface LearningCandidate {
    text: string;
    confidence: number;
    explicit?: boolean;
}
export declare function filterToolFindingsForProactivity(candidates: Array<{
    text: string;
    confidence: number;
    explicit?: boolean;
}>, level?: "high" | "low" | "medium"): Array<{
    text: string;
    confidence: number;
    explicit?: boolean;
}>;
export declare function extractToolFindings(toolName: string, input: Record<string, unknown>, responseStr: string, toolResponse?: unknown): LearningCandidate[];
export declare function handleHookContext(): Promise<void>;
export {};

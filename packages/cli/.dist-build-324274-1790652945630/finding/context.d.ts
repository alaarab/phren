interface TaskReferenceResolution {
    stableId?: string;
    error?: string;
}
export declare function resolveFindingTaskReference(phrenPath: string, project: string, match: string): TaskReferenceResolution;
export declare function resolveAutoFindingTaskItem(phrenPath: string, project: string): string | undefined;
export declare function resolveFindingSessionId(phrenPath: string, project: string, explicitSessionId?: string): string | undefined;
export {};

export interface TaskCheckpoint {
    project: string;
    taskId: string;
    taskText?: string;
    taskLine: string;
    sessionId?: string;
    createdAt: string;
    resumptionHint: {
        lastAttempt: string;
        nextStep: string;
    };
    gitStatus: string;
    editedFiles: string[];
    failingTests: string[];
}
export declare function checkpointPath(phrenPath: string, project: string, taskId: string): string;
export declare function writeTaskCheckpoint(phrenPath: string, checkpoint: TaskCheckpoint): void;
export declare function listTaskCheckpoints(phrenPath: string, project?: string): TaskCheckpoint[];
export declare function clearTaskCheckpoint(phrenPath: string, args: {
    project: string;
    taskId?: string;
    stableId?: string;
    positionalId?: string;
    taskLine?: string;
}): number;

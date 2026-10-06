export declare function isValidProjectName(name: string): boolean;
export declare function safeProjectPath(base: string, ...segments: string[]): string | null;
export declare const QUEUE_FILENAME = "review.md";
export declare function queueFilePath(phrenPath: string, project: string): string;

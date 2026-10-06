/** A non-blocking lock for background work. Uses the same files as withFileLock. */
export declare function tryFileLock(filePath: string): (() => void) | null;
export declare function withFileLock<T>(filePath: string, fn: () => T): T extends Promise<infer U> ? Promise<U> : T;
export declare function isFiniteNumber(value: unknown): value is number;
export declare function hasValidSchemaVersion(data: Record<string, unknown>): boolean;

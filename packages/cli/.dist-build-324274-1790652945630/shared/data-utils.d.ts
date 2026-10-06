import { type PhrenResult } from "../shared.js";
export declare function withSafeLock<T>(filePath: string, fn: () => PhrenResult<T>): PhrenResult<T>;
/**
 * Recursively walk a directory and return paths of files matching an optional filter.
 * Defaults to `.md` files only. Uses an iterative stack to avoid recursion limits.
 */
export declare function walkDirectory(root: string, filter?: (name: string) => boolean): string[];
export declare function ensureProject(phrenPath: string, project: string): PhrenResult<string>;

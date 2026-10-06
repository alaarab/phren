import type { TaskItem, QueueItem } from "../data/access.js";
import { type PhrenResult } from "../shared.js";
export declare function resultMsg(r: PhrenResult<unknown>): string;
export declare function editDistance(a: string, b: string): number;
/** Splits a typed palette command into words on whitespace, honoring single and double quotes. */
export declare function splitCommandLine(input: string): string[];
export declare function tasksByFilter(items: TaskItem[], filter: string): TaskItem[];
export declare function queueByFilter(items: QueueItem[], filter: string): QueueItem[];
export declare function expandIds(input: string): string[];
export declare function normalizeSection(sectionRaw: string): "Active" | "Queue" | "Done" | null;
export declare function defaultRunHooks(phrenPath: string): Promise<string>;
export declare function defaultRunUpdate(): Promise<string>;
export declare function defaultRunRelink(phrenPath: string): Promise<string>;

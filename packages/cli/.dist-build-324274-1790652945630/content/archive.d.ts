import { type PhrenResult } from "../shared.js";
/**
 * Count active (non-archived) finding entries in FINDINGS.md content.
 * Entries inside archive blocks are considered archived.
 * Supports structured archive markers and HTML details blocks.
 */
export declare function countActiveFindings(content: string): number;
/**
 * Archive the oldest entries from FINDINGS.md into reference/{topic}.md files.
 * Keeps `keepCount` most recent entries, archives the rest grouped by topic.
 * Returns the number of entries archived.
 */
export declare function autoArchiveToReference(phrenPath: string, project: string, keepCount: number): PhrenResult<number>;

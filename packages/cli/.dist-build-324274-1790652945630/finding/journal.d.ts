import { PhrenResult } from "../shared.js";
import { type FindingProvenanceSource } from "../content/citation.js";
interface FindingJournalCompactResult {
    filesProcessed: number;
    entriesProcessed: number;
    added: number;
    skipped: number;
    failed: number;
}
export declare function appendFindingJournal(phrenPath: string, project: string, text: string, opts?: {
    sessionId?: string;
    repo?: string;
    commit?: string;
    file?: string;
    source?: FindingProvenanceSource;
}): PhrenResult<string>;
export declare function compactFindingJournals(phrenPath: string, project?: string): FindingJournalCompactResult;
/**
 * Append a finding to a team store's journal.
 * Each actor gets one file per day — no merge conflicts possible.
 * These are markdown files committed to git (not runtime JSONL).
 */
export declare function appendTeamJournal(storePath: string, project: string, finding: string, actor?: string, machine?: string): PhrenResult<string>;
/**
 * Read all team journal entries for a project, newest first.
 */
export declare function readTeamJournalEntries(storePath: string, project: string): Array<{
    file: string;
    date: string;
    actor: string;
    entries: string[];
}>;
/**
 * Materialize FINDINGS.md from team journal entries.
 * Groups by date, includes actor attribution.
 */
export declare function materializeTeamFindings(storePath: string, project: string): PhrenResult<{
    entryCount: number;
}>;
export {};

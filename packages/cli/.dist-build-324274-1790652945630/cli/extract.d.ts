import { type FindingProvenanceSource } from "../content/citation.js";
export declare function parseGitLogRecords(cwd: string, days: number): Array<{
    hash: string;
    subject: string;
    body: string;
}>;
interface Candidate {
    text: string;
    score: number;
    commit?: string;
    file?: string;
    sourceText?: string;
}
export declare function runGhJson<T>(cwd: string, args: string[]): Promise<T | null>;
export declare function ghCachePath(repoRoot: string): string;
export declare function mineGithubCandidates(repoRoot: string): Promise<Candidate[]>;
export declare function scoreFindingCandidate(subject: string, body: string): {
    score: number;
    text: string;
} | null;
/**
 * Render the provenance a queued candidate needs to stay promotable.
 *
 * A candidate below `autoAcceptThreshold` never reaches FINDINGS.md — approving it
 * is what writes it. For the promoted finding to be indistinguishable from an
 * auto-accepted one, the queue line has to carry the same provenance the journal
 * path passes to `addFindingToFile`: source/session plus repo/commit/file. Both are
 * emitted as HTML comments, invisible in rendered markdown and stripped from the
 * queue item's display text.
 */
export declare function buildQueueProvenanceMeta(opts: {
    source?: FindingProvenanceSource;
    sessionId?: string;
    repo?: string;
    commit?: string;
    file?: string;
    capturedAt?: string;
}): string;
export declare function handleExtractMemories(projectArg?: string, cwdArg?: string, silent?: boolean, sessionId?: string, source?: FindingProvenanceSource): Promise<void>;
export {};

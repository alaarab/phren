import { type PhrenResult, type FindingTag } from "../shared.js";
import { type FindingCitation, type FindingProvenance } from "./citation.js";
interface AddFindingOptions {
    extraAnnotations?: string[];
    sessionId?: string;
    scope?: string;
    provenance?: FindingProvenance;
    /**
     * Clock and id-source overrides. Both default to the real clock/CSPRNG, so
     * omitting them is byte-identical to today's behaviour; they exist solely so
     * `generate-fixtures.mjs` can make its output reproducible the same way
     * `notes.addNote`'s `now` option and `tasks.addTask`'s `createdAt` option
     * already let the fixture generator fix the clock for notes and tasks.
     */
    now?: Date;
    idSource?: () => string;
}
export interface AddFindingResult {
    message: string;
    status: "added" | "created" | "skipped";
}
/**
 * Heuristically infer a finding's type tag from its own wording when the
 * caller didn't supply one. Return type is FindingTag (not FindingType)
 * because "workaround" and "context" are valid outputs here even though
 * they aren't part of the smaller offered/pickable FINDING_TYPES set —
 * both still have a FINDING_TYPE_DECAY row and are searchable via
 * search_knowledge's `tag` filter (FINDING_TAGS), so this function agrees
 * with both.
 */
export declare function autoDetectFindingType(text: string): FindingTag | null;
export declare function upsertCanonical(phrenPath: string, project: string, memory: string): PhrenResult<string>;
export declare function addFindingToFile(phrenPath: string, project: string, learning: string, citationInput?: Partial<FindingCitation>, opts?: AddFindingOptions): PhrenResult<AddFindingResult>;
export declare function addFindingsToFile(phrenPath: string, project: string, learnings: string[], opts?: {
    extraAnnotationsByFinding?: string[][];
    sessionId?: string;
    scope?: string;
    provenance?: FindingProvenance;
}): PhrenResult<{
    added: string[];
    skipped: string[];
    rejected: {
        text: string;
        reason: string;
    }[];
}>;
export {};

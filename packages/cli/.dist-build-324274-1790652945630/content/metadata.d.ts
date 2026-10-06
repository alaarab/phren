/**
 * Consolidated metadata regex patterns and parsing helpers for HTML comment
 * metadata embedded in FINDINGS.md and related files.
 *
 * `phren:` prefixes are used for HTML comment metadata.
 */
export declare const METADATA_REGEX: {
    /** Matches `<!-- phren:status "active" -->` or `<!-- phren:status "superseded" -->` etc. */
    readonly status: RegExp;
    /** Matches `<!-- phren:status_updated "2025-01-01" -->` */
    readonly statusUpdated: RegExp;
    /** Matches `<!-- phren:status_reason "superseded_by" -->` */
    readonly statusReason: RegExp;
    /** Matches `<!-- phren:status_ref "some ref" -->` */
    readonly statusRef: RegExp;
    /** Generic field matcher factory for status_updated / status_reason / status_ref. */
    readonly statusField: (field: string) => RegExp;
    /** Raw (unquoted) fallback for status fields: `<!-- phren:status_ref some text -->` */
    readonly statusFieldRaw: (field: string) => RegExp;
    /** Matches `<!-- phren:superseded_by "text" 2025-01-01 -->` */
    readonly supersededBy: RegExp;
    /** Legacy `<!-- superseded_by: "text" -->` */
    readonly supersededByLegacy: RegExp;
    /** Matches `<!-- phren:supersedes "text" -->` */
    readonly supersedes: RegExp;
    /** Matches `<!-- phren:contradicts "text" -->` */
    readonly contradicts: RegExp;
    /** Global version for matchAll */
    readonly contradictsAll: RegExp;
    /** Legacy `<!-- conflicts_with: "text" -->` or `<!-- conflicts_with: "text" (from project: foo) -->` */
    readonly conflictsWith: RegExp;
    /** Global version for matchAll on conflicts_with */
    readonly conflictsWithAll: RegExp;
    /** Matches `<!-- phren:cite {...} -->` or `<!-- phren:cite {...} -->` on a full line. */
    readonly citation: RegExp;
    /** Matches the opening marker (not line-anchored) for extracting JSON payload. */
    readonly citationMarker: RegExp;
    /** Matches `<!-- phren:archive:start -->` or `<!-- phren:archive:start -->` */
    readonly archiveStart: RegExp;
    /** Matches `<!-- phren:archive:end -->` or `<!-- phren:archive:end -->` */
    readonly archiveEnd: RegExp;
    /** Matches `<!-- fid:abcd1234 -->` */
    readonly findingId: RegExp;
    /** Matches `<!-- created: 2025-01-01 -->` */
    readonly createdDate: RegExp;
    /** Matches any lifecycle annotation: status, status_updated, status_reason, status_ref */
    readonly lifecycleAnnotation: RegExp;
    /** Matches `<!-- source:... -->` */
    readonly source: RegExp;
    /** Matches any HTML comment `<!-- ... -->` (non-greedy). */
    readonly anyComment: RegExp;
    /** Strip status comment */
    readonly stripStatus: RegExp;
    /** Strip status_updated comment */
    readonly stripStatusUpdated: RegExp;
    /** Strip status_reason comment */
    readonly stripStatusReason: RegExp;
    /** Strip status_ref comment */
    readonly stripStatusRef: RegExp;
    /** Strip legacy `<!-- superseded_by: "..." -->` */
    readonly stripSupersededByLegacy: RegExp;
    /** Strip `<!-- phren:superseded_by "..." ... -->` */
    readonly stripSupersededBy: RegExp;
    /** Strip `<!-- phren:supersedes "..." -->` */
    readonly stripSupersedes: RegExp;
    /** Strip legacy `<!-- conflicts_with: "..." -->` */
    readonly stripConflictsWith: RegExp;
    /** Strip `<!-- phren:contradicts "..." -->` */
    readonly stripContradicts: RegExp;
};
/** Parse `<!-- phren:status "active" -->` from a line. Returns the status string or undefined. */
export declare function parseStatus(line: string): string | undefined;
/** Parse a quoted status field (status_updated, status_reason, status_ref) from a line. */
export declare function parseStatusField(line: string, field: string): string | undefined;
/** Parse supersession metadata: returns `{ ref, date }` or null. Checks both prefixed and legacy forms. */
export declare function parseSupersession(line: string): {
    ref: string;
    date?: string;
} | null;
/** Parse `<!-- phren:supersedes "..." -->` from a line. Returns the ref or undefined. */
export declare function parseSupersedesRef(line: string): string | undefined;
/** Parse contradiction metadata. Checks both prefixed `contradicts` and legacy `conflicts_with`. */
export declare function parseContradiction(line: string): string | null;
/** Parse all contradiction refs from a line using matchAll. */
export declare function parseAllContradictions(line: string): string[];
/** Parse `<!-- fid:XXXXXXXX -->` from a line. Returns the 8-char hex ID or undefined. */
export declare function parseFindingId(line: string): string | undefined;
/** Parse `<!-- created: YYYY-MM-DD -->` from a line. Returns the date string or undefined. */
export declare function parseCreatedDate(line: string): string | undefined;
/** Check if a line (or next line) contains a citation comment. */
export declare function isCitationLine(line: string): boolean;
/** Check if a line marks the start of an archive block. */
export declare function isArchiveStart(line: string): boolean;
/** Check if a line marks the end of an archive block. */
export declare function isArchiveEnd(line: string): boolean;
/** Strip all lifecycle status comments (status, status_updated, status_reason, status_ref). */
export declare function stripLifecycleMetadata(line: string): string;
/** Strip all relation comments (superseded_by, supersedes, conflicts_with, contradicts). */
export declare function stripRelationMetadata(line: string): string;
/** Strip all phren/phren metadata comments from a line. */
export declare function stripAllMetadata(line: string): string;
/** Strip all HTML comments from text. */
export declare function stripComments(text: string): string;
/** Normalize finding text for comparison: strips bullet prefix, HTML comments, confidence tags, normalizes whitespace, lowercases. */
export declare function normalizeFindingText(raw: string): string;
/** Build a metadata comment string. */
export declare function addMetadata(type: string, value: string, extra?: string): string;

/**
 * Consolidated metadata regex patterns and parsing helpers for HTML comment
 * metadata embedded in FINDINGS.md and related files.
 *
 * `phren:` prefixes are used for HTML comment metadata.
 */

// ---------------------------------------------------------------------------
// Prefix pattern (shared across all metadata types)
// ---------------------------------------------------------------------------

/** Matches `phren` as a comment prefix. */
const PREFIX = `phren`;

// ---------------------------------------------------------------------------
// Raw regex patterns — exported for direct use when the helpers don't fit
// ---------------------------------------------------------------------------

export const METADATA_REGEX = {
  /** Matches `<!-- phren:status "active" -->` or `<!-- phren:status "superseded" -->` etc. */
  status: new RegExp(
    `<!--\\s*${PREFIX}:status\\s+"?(active|superseded|contradicted|stale|invalid_citation|retracted)"?\\s*-->`,
    "i",
  ),

  /** Matches `<!-- phren:status_updated "2025-01-01" -->` */
  statusUpdated: new RegExp(`<!--\\s*${PREFIX}:status_updated\\s+"([^"]+)"\\s*-->`, "i"),

  /** Matches `<!-- phren:status_reason "superseded_by" -->` */
  statusReason: new RegExp(`<!--\\s*${PREFIX}:status_reason\\s+"([^"]+)"\\s*-->`, "i"),

  /** Matches `<!-- phren:status_ref "some ref" -->` */
  statusRef: new RegExp(`<!--\\s*${PREFIX}:status_ref\\s+"([^"]+)"\\s*-->`, "i"),

  /** Generic field matcher factory for status_updated / status_reason / status_ref. */
  statusField(field: string): RegExp {
    return new RegExp(`<!--\\s*${PREFIX}:${field}\\s+"([^"]+)"\\s*-->`, "i");
  },

  /** Raw (unquoted) fallback for status fields: `<!-- phren:status_ref some text -->` */
  statusFieldRaw(field: string): RegExp {
    return new RegExp(`<!--\\s*${PREFIX}:${field}\\s+([^>]+?)\\s*-->`, "i");
  },

  /** Matches `<!-- phren:superseded_by "text" 2025-01-01 -->` */
  supersededBy: new RegExp(
    `<!--\\s*${PREFIX}:superseded_by\\s+"([^"]+)"(?:\\s+([0-9]{4}-[0-9]{2}-[0-9]{2}))?\\s*-->`,
    "i",
  ),

  /** Legacy `<!-- superseded_by: "text" -->` */
  supersededByLegacy: /<!--\s*superseded_by:\s*"([^"]+)"\s*-->/i,

  /** Matches `<!-- phren:supersedes "text" -->` */
  supersedes: new RegExp(`<!--\\s*${PREFIX}:supersedes\\s+"([^"]+)"\\s*-->`, "i"),

  /** Matches `<!-- phren:contradicts "text" -->` */
  contradicts: new RegExp(`<!--\\s*${PREFIX}:contradicts\\s+"([^"]+)"\\s*-->`, "i"),

  /** Global version for matchAll */
  contradictsAll: new RegExp(`<!--\\s*phren:contradicts\\s+"([^"]+)"\\s*-->`, "g"),

  /** Legacy `<!-- conflicts_with: "text" -->` or `<!-- conflicts_with: "text" (from project: foo) -->` */
  conflictsWith: /<!--\s*conflicts_with:\s*"([^"]+)"(?:\s*\(from project:\s*[^)]+\))?\s*-->/i,

  /** Global version for matchAll on conflicts_with */
  conflictsWithAll: /<!--\s*conflicts_with:\s*"([^"]+)"(?:\s*\(from project:\s*[^)]+\))?\s*-->/g,

  /** Matches `<!-- phren:cite {...} -->` or `<!-- phren:cite {...} -->` on a full line. */
  citation: /^\s*<!--\s*phren:cite\s+\{.*\}\s*-->\s*$/,

  /** Matches the opening marker (not line-anchored) for extracting JSON payload. */
  citationMarker: /<!--\s*phren:cite\s+/,

  /** Matches `<!-- phren:archive:start -->` or `<!-- phren:archive:start -->` */
  archiveStart: new RegExp(`<!--\\s*${PREFIX}:archive:start\\s*-->`),

  /** Matches `<!-- phren:archive:end -->` or `<!-- phren:archive:end -->` */
  archiveEnd: new RegExp(`<!--\\s*${PREFIX}:archive:end\\s*-->`),

  /** Matches `<!-- fid:abcd1234 -->` */
  findingId: /<!--\s*fid:([a-z0-9]{8})\s*-->/i,

  /** Matches `<!-- created: 2025-01-01 -->` */
  createdDate: /<!--\s*created:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\s*-->/i,

  /** Matches any lifecycle annotation: status, status_updated, status_reason, status_ref */
  lifecycleAnnotation: new RegExp(`<!--\\s*${PREFIX}:status(?:_updated|_reason|_ref)?\\b[^>]*-->`, "i"),

  /** Matches `<!-- source:... -->` */
  source: /<!--\s*source:\s*(.*?)\s*-->/,

  /** Matches any HTML comment `<!-- ... -->` (non-greedy). */
  anyComment: /<!--.*?-->/g,

  // Strip patterns (with leading optional whitespace for clean removal)

  /** Strip status comment */
  stripStatus: new RegExp(
    `\\s*<!--\\s*${PREFIX}:status\\s+"?(?:active|superseded|contradicted|stale|invalid_citation|retracted)"?\\s*-->`,
    "gi",
  ),

  /** Strip status_updated comment */
  stripStatusUpdated: new RegExp(`\\s*<!--\\s*${PREFIX}:status_updated\\s+"[^"]+"\\s*-->`, "gi"),

  /** Strip status_reason comment */
  stripStatusReason: new RegExp(`\\s*<!--\\s*${PREFIX}:status_reason\\s+"[^"]+"\\s*-->`, "gi"),

  /** Strip status_ref comment */
  stripStatusRef: new RegExp(`\\s*<!--\\s*${PREFIX}:status_ref\\s+"[^"]+"\\s*-->`, "gi"),

  /** Strip legacy `<!-- superseded_by: "..." -->` */
  stripSupersededByLegacy: /\s*<!--\s*superseded_by:\s*"[^"]+"\s*-->/gi,

  /** Strip `<!-- phren:superseded_by "..." ... -->` */
  stripSupersededBy: new RegExp(
    `\\s*<!--\\s*${PREFIX}:superseded_by\\s+"[^"]+"(?:\\s+[0-9]{4}-[0-9]{2}-[0-9]{2})?\\s*-->`,
    "gi",
  ),

  /** Strip `<!-- phren:supersedes "..." -->` */
  stripSupersedes: new RegExp(`\\s*<!--\\s*${PREFIX}:supersedes\\s+"[^"]+"\\s*-->`, "gi"),

  /** Strip legacy `<!-- conflicts_with: "..." -->` */
  stripConflictsWith: /\s*<!--\s*conflicts_with:\s*"[^"]+"(?:\s*\(from project:\s*[^)]+\))?\s*-->/gi,

  /** Strip `<!-- phren:contradicts "..." -->` */
  stripContradicts: new RegExp(`\\s*<!--\\s*${PREFIX}:contradicts\\s+"[^"]+"\\s*-->`, "gi"),
} as const;

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** Parse `<!-- phren:status "active" -->` from a line. Returns the status string or undefined. */
export function parseStatus(line: string): string | undefined {
  return line.match(METADATA_REGEX.status)?.[1]?.toLowerCase();
}

/** Parse a quoted status field (status_updated, status_reason, status_ref) from a line. */
export function parseStatusField(line: string, field: string): string | undefined {
  const quoted = line.match(METADATA_REGEX.statusField(field))?.[1];
  if (quoted) return quoted.replace(/\s+/g, " ").trim();
  const raw = line.match(METADATA_REGEX.statusFieldRaw(field))?.[1];
  return raw ? raw.replace(/\s+/g, " ").trim() : undefined;
}

/** Parse supersession metadata: returns `{ ref, date }` or null. Checks both prefixed and legacy forms. */
export function parseSupersession(line: string): { ref: string; date?: string } | null {
  const prefixed = line.match(METADATA_REGEX.supersededBy);
  if (prefixed) return { ref: prefixed[1], date: prefixed[2] };
  const legacy = line.match(METADATA_REGEX.supersededByLegacy);
  if (legacy) return { ref: legacy[1] };
  return null;
}

/** Parse `<!-- phren:supersedes "..." -->` from a line. Returns the ref or undefined. */
export function parseSupersedesRef(line: string): string | undefined {
  return line.match(METADATA_REGEX.supersedes)?.[1];
}

/** Parse contradiction metadata. Checks both prefixed `contradicts` and legacy `conflicts_with`. */
export function parseContradiction(line: string): string | null {
  const prefixed = line.match(METADATA_REGEX.contradicts);
  if (prefixed) return prefixed[1];
  const legacy = line.match(METADATA_REGEX.conflictsWith);
  if (legacy) return legacy[1];
  return null;
}

/** Parse all contradiction refs from a line using matchAll. */
export function parseAllContradictions(line: string): string[] {
  return [...line.matchAll(METADATA_REGEX.contradictsAll)].map((m) => m[1]);
}

/** Parse `<!-- fid:XXXXXXXX -->` from a line. Returns the 8-char hex ID or undefined. */
export function parseFindingId(line: string): string | undefined {
  return line.match(METADATA_REGEX.findingId)?.[1];
}

/** Parse `<!-- created: YYYY-MM-DD -->` from a line. Returns the date string or undefined. */
export function parseCreatedDate(line: string): string | undefined {
  return line.match(METADATA_REGEX.createdDate)?.[1];
}

/** Check if a line (or next line) contains a citation comment. */
export function isCitationLine(line: string): boolean {
  return METADATA_REGEX.citation.test(line.trim());
}

/** Check if a line marks the start of an archive block. */
export function isArchiveStart(line: string): boolean {
  return METADATA_REGEX.archiveStart.test(line) || /^<details(?:\s|>)/i.test(line.trim());
}

/** Check if a line marks the end of an archive block. */
export function isArchiveEnd(line: string): boolean {
  return METADATA_REGEX.archiveEnd.test(line) || /^<\/details>/i.test(line.trim());
}

// ---------------------------------------------------------------------------
// Strip helpers — remove metadata comments from a line
// ---------------------------------------------------------------------------

/** Strip all lifecycle status comments (status, status_updated, status_reason, status_ref). */
export function stripLifecycleMetadata(line: string): string {
  return line
    .replace(METADATA_REGEX.stripStatus, "")
    .replace(METADATA_REGEX.stripStatusUpdated, "")
    .replace(METADATA_REGEX.stripStatusReason, "")
    .replace(METADATA_REGEX.stripStatusRef, "");
}

/** Strip all relation comments (superseded_by, supersedes, conflicts_with, contradicts). */
export function stripRelationMetadata(line: string): string {
  return line
    .replace(METADATA_REGEX.stripSupersededByLegacy, "")
    .replace(METADATA_REGEX.stripSupersededBy, "")
    .replace(METADATA_REGEX.stripSupersedes, "")
    .replace(METADATA_REGEX.stripConflictsWith, "")
    .replace(METADATA_REGEX.stripContradicts, "");
}

/** Strip all phren/phren metadata comments from a line. */
export function stripAllMetadata(line: string): string {
  return stripRelationMetadata(stripLifecycleMetadata(line));
}

/** Strip all HTML comments from text. */
export function stripComments(text: string): string {
  return text.replace(METADATA_REGEX.anyComment, "").trim();
}

// ---------------------------------------------------------------------------
// Add helpers — append metadata comments to a line
// ---------------------------------------------------------------------------

/** Build a metadata comment string. */
export function addMetadata(
  type: string,
  value: string,
  extra?: string,
): string {
  const prefix = "phren";
  const escaped = value.replace(/"/g, "'");
  if (extra) {
    return `<!-- ${prefix}:${type} "${escaped}" ${extra} -->`;
  }
  return `<!-- ${prefix}:${type} "${escaped}" -->`;
}

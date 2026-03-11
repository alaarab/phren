// Shared Cortex result types, validation tags, and low-level helpers.

// Default timeout for execFileSync calls (30s for most operations, 10s for quick probes like `which`)
export const EXEC_TIMEOUT_MS = 30_000;
export const EXEC_TIMEOUT_QUICK_MS = 10_000;

// Structured error codes for consistent error handling across data-access and MCP tools
export const CortexError = {
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
  INVALID_PROJECT_NAME: "INVALID_PROJECT_NAME",
  FILE_NOT_FOUND: "FILE_NOT_FOUND",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  MALFORMED_JSON: "MALFORMED_JSON",
  MALFORMED_YAML: "MALFORMED_YAML",
  NOT_FOUND: "NOT_FOUND",
  AMBIGUOUS_MATCH: "AMBIGUOUS_MATCH",
  LOCK_TIMEOUT: "LOCK_TIMEOUT",
  EMPTY_INPUT: "EMPTY_INPUT",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  INDEX_ERROR: "INDEX_ERROR",
  NETWORK_ERROR: "NETWORK_ERROR",
} as const;

export type CortexErrorCode = typeof CortexError[keyof typeof CortexError];

// Discriminated union for typed error returns in the data-access layer.
// Replaces `T | string` patterns so callers can structurally distinguish errors.
export type CortexResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: CortexErrorCode };

export function cortexOk<T>(data: T): CortexResult<T> {
  return { ok: true, data };
}

export function cortexErr<T>(error: string, code?: CortexErrorCode): CortexResult<T> {
  return { ok: false, error, code };
}

// Forward a failed CortexResult to a different result type (re-types the error branch).
// Safe to call after an `if (!result.ok)` guard; extracts error and code from the union.
export function forwardErr<T>(result: CortexResult<unknown>): CortexResult<T> {
  if (!result.ok) return { ok: false, error: result.error, code: result.code };
  return { ok: false, error: "unexpected forward of ok result" };
}

const ERROR_CODES = new Set(Object.values(CortexError));

// Extract the error code from an error string (e.g. "PROJECT_NOT_FOUND: ...").
// Returns the code if the string starts with a known CortexError, or undefined.
export function parseCortexErrorCode(msg: string): CortexErrorCode | undefined {
  const prefix = msg.split(":")[0]?.trim();
  if (prefix && ERROR_CODES.has(prefix as CortexErrorCode)) return prefix as CortexErrorCode;
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Shallow-merge data onto defaults so missing keys get filled in. */
export function withDefaults<T extends object>(data: Partial<T>, defaults: T): T {
  const merged = { ...defaults } as Record<string, unknown>;
  for (const key of Object.keys(data)) {
    const val = data[key as keyof T];
    if (val !== undefined && val !== null) {
      if (typeof val === "object" && !Array.isArray(val) && typeof merged[key] === "object" && !Array.isArray(merged[key])) {
        merged[key] = { ...(merged[key] as Record<string, unknown>), ...(val as Record<string, unknown>) };
      } else {
        merged[key] = val;
      }
    }
  }
  return merged as T;
}

/** All valid finding type tags — used for writes, search filters, and hook extraction */
export const FINDING_TYPES = ["decision", "pitfall", "pattern", "tradeoff", "architecture", "bug"] as const;
export type FindingType = (typeof FINDING_TYPES)[number];

/** Searchable finding tags (same set as FINDING_TYPES) */
export const FINDING_TAGS = FINDING_TYPES;
export type FindingTag = FindingType;

/** Canonical set of known observation tags — derived from FINDING_TYPES */
export const KNOWN_OBSERVATION_TAGS: Set<string> = new Set(FINDING_TYPES);

/** Document types in the FTS index */
export const DOC_TYPES = ["claude", "findings", "reference", "skills", "summary", "task", "changelog", "canonical", "memory-queue", "skill", "other"] as const;
export type DocType = (typeof DOC_TYPES)[number];

// ── Cache eviction helper ────────────────────────────────────────────────────

const CACHE_MAX = 1000;
const CACHE_EVICT = 100;

export function capCache<K, V>(cache: Map<K, V>): void {
  if (cache.size > CACHE_MAX) {
    const it = cache.keys();
    for (let i = 0; i < CACHE_EVICT; i++) {
      const k = it.next();
      if (k.done) break;
      cache.delete(k.value);
    }
  }
}

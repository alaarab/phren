/**
 * Minimal cross-domain starter set for fragment/conflict detection.
 *
 * Kept intentionally small: only terms that are genuinely universal across
 * disciplines (languages, infra primitives, version control). Framework-specific
 * tools (React, Django, Unity, JUCE, Ansible, ...) are learned dynamically from
 * each project's FINDINGS.md via extractDynamicEntities().
 */
export declare const UNIVERSAL_TECH_TERMS_RE: RegExp;
/**
 * Additional fragment patterns beyond CamelCase and acronyms.
 * Each pattern has a named group so callers can identify the fragment type.
 */
export declare const EXTRA_FRAGMENT_PATTERNS: Array<{
    re: RegExp;
    label: string;
}>;
/** Union of all directory names reserved by phren infrastructure — not valid project names. */
export declare const RESERVED_PROJECT_DIR_NAMES: Set<string>;
export declare const EXEC_TIMEOUT_MS = 30000;
export declare const EXEC_TIMEOUT_QUICK_MS = 10000;
export declare const PhrenError: {
    readonly PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND";
    readonly INVALID_PROJECT_NAME: "INVALID_PROJECT_NAME";
    readonly FILE_NOT_FOUND: "FILE_NOT_FOUND";
    readonly PERMISSION_DENIED: "PERMISSION_DENIED";
    readonly MALFORMED_JSON: "MALFORMED_JSON";
    readonly MALFORMED_YAML: "MALFORMED_YAML";
    readonly NOT_FOUND: "NOT_FOUND";
    readonly AMBIGUOUS_MATCH: "AMBIGUOUS_MATCH";
    readonly LOCK_TIMEOUT: "LOCK_TIMEOUT";
    readonly EMPTY_INPUT: "EMPTY_INPUT";
    readonly VALIDATION_ERROR: "VALIDATION_ERROR";
    readonly INDEX_ERROR: "INDEX_ERROR";
    readonly NETWORK_ERROR: "NETWORK_ERROR";
};
export type PhrenErrorCode = typeof PhrenError[keyof typeof PhrenError];
export type PhrenResult<T> = {
    ok: true;
    data: T;
} | {
    ok: false;
    error: string;
    code?: PhrenErrorCode;
};
export declare function phrenOk<T>(data: T): PhrenResult<T>;
export declare function phrenErr<T>(error: string, code?: PhrenErrorCode): PhrenResult<T>;
export declare function forwardErr<T>(result: PhrenResult<unknown>): PhrenResult<T>;
export declare function parsePhrenErrorCode(msg: string): PhrenErrorCode | undefined;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
/**
 * `yaml.load` with js-yaml 4's empty-document behaviour.
 *
 * js-yaml 5 throws YAMLException("expected a document, but the input is empty")
 * for input that is blank, whitespace, or comments only — where 4 returned
 * `undefined`. phren's config files legitimately look like that: a freshly
 * scaffolded `machines.yaml` is a single header comment, and an untouched
 * profile can be empty. Every caller already handles `undefined`, but a throw
 * is read as a parse failure, which would report those files as malformed —
 * and `stores.yaml` refuses to write back over a file it could not parse, so
 * an empty registry would have become unrepairable by the CLI.
 *
 * Only genuinely empty documents are absorbed. `---`, `null` and real syntax
 * errors reach js-yaml exactly as before.
 */
export declare function loadYamlDocument<T = unknown>(source: string, load: (source: string) => unknown): T | undefined;
/** Shallow-merge data onto defaults so missing keys get filled in. */
export declare function withDefaults<T extends object>(data: Partial<T>, defaults: T): T;
/**
 * Finding types offered as an explicit choice: add_finding's findingType
 * param, promote_note --type, and the web/iOS type pickers. Deliberately the
 * intersection of what used to be three disjoint lists (this enum, the decay
 * table, and the auto-detector) — "tradeoff" and "architecture" were offered
 * here but had no decay rule and no max-age, so they never actually worked.
 * Legacy stores may still contain those two tags; reading/searching them as
 * plain text still works, they just aren't offered or decay-tracked anymore.
 */
export declare const FINDING_TYPES: readonly ["decision", "pitfall", "pattern", "bug"];
export type FindingType = (typeof FINDING_TYPES)[number];
/**
 * Every finding tag phren can actually produce or needs to search for: the
 * offered FINDING_TYPES above, plus tags autoDetectFindingType
 * (content/learning.ts) writes on its own initiative — "workaround" and
 * "context" — which aren't offered as an explicit pick but still need a
 * decay rule (finding/lifecycle.ts's FINDING_TYPE_DECAY is typed against
 * this exact set) and need to stay filterable via search_knowledge's `tag`
 * param.
 */
export declare const FINDING_TAGS: readonly ["decision", "pitfall", "pattern", "bug", "workaround", "context"];
export type FindingTag = (typeof FINDING_TAGS)[number];
/** Canonical set of known finding tags for the "unknown tag" write-time warning — derived from FINDING_TAGS (not just FINDING_TYPES) so phren never flags its own auto-written workaround/context tags as unknown. */
export declare const KNOWN_OBSERVATION_TAGS: Set<string>;
/**
 * Document types in the FTS index.
 *
 * "canonical" is `truths.md`'s type (see FILE_TYPE_MAP in shared/index.ts):
 * the file was renamed from `canonical_memories.md` to `truths.md` in the
 * 0.0.5 rename, but the type string was not renamed with it, so it still
 * leaks as the literal `--type canonical` / `type: "canonical"` value across
 * the CLI and API (docs/api-reference.md documents it as-is because that is
 * what the index actually produces). Renaming it requires touching
 * shared/index.ts and shared/retrieval.ts together with this file, since all
 * three must agree on the type string.
 */
export declare const DOC_TYPES: readonly ["claude", "findings", "notes", "reference", "skills", "summary", "task", "changelog", "canonical", "review-queue", "skill", "other"];
export type DocType = (typeof DOC_TYPES)[number];
export declare function capCache<K, V>(cache: Map<K, V>): void;

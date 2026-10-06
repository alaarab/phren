/**
 * Config resolver — turns the 3-level precedence chain (default → global/profile
 * → project) into a uniform, per-field view that every surface renders the same.
 *
 * `buildConfigView` is consumed by the `get_config` MCP tool, `phren config show`,
 * the Web UI settings tab, and the VS Code settings webview, so the "where did
 * this value come from" answer is computed in exactly one place.
 */
import type { ConfigDomainId } from "./schema.js";
/** One field, resolved across the precedence chain. */
export interface ResolvedField {
    key: string;
    value: unknown;
    /** Where the winning value came from. `global` covers both global files and profile defaults. */
    source: "default" | "global" | "project";
    /** The value this field would resolve to if the winning override were removed. */
    inheritedValue: unknown;
    /** File that supplied the winning value, when not a default. */
    sourcePath?: string;
}
/** The resolved view of every field at a given scope. */
export interface ConfigView {
    scope: "global" | "project";
    project?: string;
    /** Resolved fields keyed by dotted field key. */
    fields: Record<string, ResolvedField>;
}
type Tier = "project" | "profile" | "global" | "default";
interface Level {
    tier: Tier;
    value: unknown;
    path?: string;
}
/**
 * Resolve one field from a precedence-ordered list of levels that actually set
 * it. `levels` must be ordered highest-precedence first and must NOT include the
 * default tier — the default is appended here.
 *
 * Redundant levels are collapsed: a level whose value equals the value of the
 * level below it is a no-op (e.g. a global policy file that merely mirrors the
 * defaults), so the source reflects the first level that genuinely changes the
 * value — never a level that just restates what it would already be.
 */
export declare function resolveConfigField(key: string, def: unknown, levels: Level[]): ResolvedField;
/**
 * Build the full resolved config view for a scope. When `project` is given, the
 * view reflects that project's merged config with override provenance; otherwise
 * it reflects the global defaults.
 *
 * Note: the `topic` domain is project-specific and stored separately — it is not
 * included here; use the `get_config` topic branch for that.
 */
export declare function buildConfigView(phrenPath: string, project?: string): ConfigView;
/** Field keys belonging to a domain, in schema order. Excludes `topic`. */
export declare function fieldKeysForDomain(domain: ConfigDomainId): string[];
export {};

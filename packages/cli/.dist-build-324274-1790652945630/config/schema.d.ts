/**
 * Shared config schema — the single source of truth every surface renders from.
 *
 * The CLI (`phren config`), the Web UI settings tab, and the VS Code settings
 * webview all import these descriptors so their labels, help text, option lists,
 * defaults, and ranges can never drift apart.
 *
 * Each field is a {@link ConfigFieldDescriptor}; fields are grouped into the
 * eight {@link CONFIG_DOMAINS}. Nothing here renders UI — descriptors are pure
 * data so every surface can present them in its own idiom.
 */
/** The eight configurable domains, named to match the `get_config`/`set_config` MCP tools. */
export type ConfigDomainId = "proactivity" | "taskMode" | "findingSensitivity" | "retention" | "workflow" | "index" | "topic" | "access";
/** How a field's value is entered. Surfaces pick a widget from this. */
export type ConfigControl = "enum" | "number" | "boolean" | "string-list" | "object";
/** Where a field may be set. `global+project` fields support per-project overrides. */
export type ConfigScope = "global+project" | "global-only" | "project-only";
/** One choice for an `enum` field, with plain-English copy. */
export interface ConfigOption {
    value: string;
    label: string;
    /** One sentence explaining what choosing this does. */
    blurb: string;
    /** True for the safe default most users should keep. */
    recommended?: boolean;
}
/** A single configurable setting. */
export interface ConfigFieldDescriptor {
    /** Dotted, stable identifier — e.g. `retention.ttlDays`, `proactivity.base`. */
    key: string;
    domain: ConfigDomainId;
    /** Short human label. */
    label: string;
    /** One line shown inline next to the control. */
    summary: string;
    /** A paragraph shown on a help disclosure. */
    help: string;
    control: ConfigControl;
    /** Present for `enum` and `string-list` (constrained) fields. */
    options?: ConfigOption[];
    /** Present for `number` fields. */
    range?: {
        min: number;
        max: number;
        step: number;
    };
    /** The value used when nothing is configured at any level. */
    default: unknown;
    scope: ConfigScope;
    /** Plain-English description of what changing this affects. */
    impact: string;
    /** `caution` fields trigger a confirm step before applying. */
    risk: "safe" | "caution";
}
/** A group of related fields. */
export interface ConfigDomainDescriptor {
    id: ConfigDomainId;
    label: string;
    /** A codicon-style icon name (used by VS Code; ignored elsewhere). */
    icon: string;
    summary: string;
    scope: ConfigScope;
    fields: ConfigFieldDescriptor[];
}
export declare const CONFIG_DOMAINS: ConfigDomainDescriptor[];
/** Look up a domain descriptor by id. */
export declare function getConfigDomain(id: ConfigDomainId): ConfigDomainDescriptor | undefined;
/** Look up a field descriptor by its dotted key. */
export declare function getConfigField(key: string): ConfigFieldDescriptor | undefined;
/** Every field across every domain, in domain order. */
export declare function allConfigFields(): ConfigFieldDescriptor[];
/**
 * Aliases mapping the historical hyphenated `phren config` subcommands to the
 * canonical domain ids. Help text and routing are generated from this so the
 * CLI surface can never drift from the schema.
 */
export declare const CONFIG_DOMAIN_ALIASES: Record<string, ConfigDomainId>;
/** Resolve a user-supplied domain/subcommand token to a canonical domain id. */
export declare function resolveConfigDomainAlias(token: string): ConfigDomainId | undefined;

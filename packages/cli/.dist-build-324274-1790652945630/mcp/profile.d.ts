import type { ModuleManifest } from "../modules/manifest.js";
export type McpProfile = "core" | "full";
export declare const MCP_PROFILES: readonly McpProfile[];
/** What an agent gets in the core profile. Order is the order clients list them. */
export declare const CORE_TOOLS: readonly string[];
/** Env wins, then the install preference, then core. */
export declare function resolveMcpProfile(phrenPath: string, env?: NodeJS.ProcessEnv): McpProfile;
export interface ToolConfig {
    title?: string;
    description?: string;
    inputSchema?: unknown;
    [key: string]: unknown;
}
export type ToolHandler = (args: Record<string, unknown>) => unknown;
export interface CatalogEntry {
    name: string;
    config: ToolConfig;
    handler: ToolHandler;
}
export type Catalog = Map<string, CatalogEntry>;
/**
 * Notes fold into add_finding: `kind: "note"` saves a lightweight daily note
 * instead of a durable finding. The note tool keeps its own schema and
 * handler; this only adds the switch and routes through the catalog, so the
 * note module can register before or after the finding module.
 */
export declare function decorateAddFinding(entry: CatalogEntry, catalog: Catalog): CatalogEntry;
export interface ToolGate {
    /** Drop-in for McpServer.registerTool: records every tool, exposes only what the profile allows. */
    registerTool: (name: string, config: ToolConfig, handler: ToolHandler) => void;
    /** Call once every module has registered: adds the composites. */
    finish: () => void;
    readonly catalog: Catalog;
    readonly exposed: Set<string>;
    readonly profile: McpProfile;
}
/**
 * Sits between the tool modules and the real server. Modules keep calling
 * registerTool exactly as before; the gate keeps the catalog, exposes core
 * tools (or everything, in `full`), marks core tools always-loaded for Claude
 * Code, and registers the composites when `finish` is called.
 */
export declare function createToolGate(opts: {
    profile: McpProfile;
    modules?: readonly ModuleManifest[];
    register: (name: string, config: ToolConfig, handler: ToolHandler) => unknown;
    /** Wraps every handler (guards, telemetry) before it is stored or exposed. */
    wrap?: (name: string, handler: ToolHandler) => ToolHandler;
    /** Extra tools to mark always-loaded for Claude Code, on top of the core set. */
    alwaysLoad?: Iterable<string>;
}): ToolGate;
/** Run a catalog tool by name after validating the arguments against its own schema. */
export declare function dispatch(catalog: Catalog, target: string, args: Record<string, unknown>): Promise<unknown>;
export interface BuiltTool {
    name: string;
    config: ToolConfig;
    handler: ToolHandler;
}
/**
 * The composite tools for a catalog. An action that has no registered target
 * (a module not loaded, say) is left out rather than advertised.
 */
export declare function buildCompositeTools(catalog: Catalog): BuiltTool[];

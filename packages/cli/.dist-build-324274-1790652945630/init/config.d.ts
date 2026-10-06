export type McpConfigStatus = "installed" | "already_configured" | "disabled" | "already_disabled";
export type McpRootKey = "mcpServers" | "servers";
export type ToolStatus = McpConfigStatus | "no_settings" | "no_vscode" | "no_cursor" | "no_copilot" | "no_codex";
export interface HookEntry {
    matcher?: string;
    hooks?: Array<{
        type?: string;
        command?: string;
        timeout?: number;
    }>;
}
export type HookEventName = "UserPromptSubmit" | "Stop" | "SessionStart" | "PostToolUse";
export type HookMap = Partial<Record<HookEventName, HookEntry[]>> & Record<string, unknown>;
type JsonObject = Record<string, unknown> & {
    hooks?: HookMap;
    mcpServers?: Record<string, unknown>;
    servers?: Record<string, unknown>;
};
export declare function patchJsonFile(filePath: string, patch: (data: JsonObject) => void): void;
/**
 * True when the running copy of phren lives in npm's npx cache. That cache is
 * npm's to evict, so a path into it is not something to write into anyone's
 * settings: it works until the day it silently does not.
 */
export declare function isEphemeralInstall(entryScript: string): boolean;
export interface McpServerConfig {
    command: string;
    args: string[];
}
/**
 * How Claude (and the other MCP hosts) should start the phren server.
 *
 * A real install points straight at its own `dist/index.js`. An `npx` install
 * does not: the file it would name sits in the npx cache, and the day npm
 * evicts it the MCP server stops starting with no error anyone sees — which
 * is exactly how `npx @phren/cli init` ends up "not working" a week later.
 * That case goes through the CLI wrapper init writes to `~/.local/bin`, which
 * knows how to find or fetch phren. Windows has no shell wrapper to lean on,
 * so it falls back to `npx.cmd` with the real package name.
 */
export declare function buildMcpServerConfig(phrenPath: string, opts?: {
    entryScript?: string;
    platform?: NodeJS.Platform;
    wrapperPath?: string;
}): McpServerConfig;
export declare function removeTomlMcpServer(filePath: string): boolean;
export declare function removeMcpServerAtPath(filePath: string): boolean;
export declare function isPhrenCommand(command: string): boolean;
/**
 * Reconcile the set of pre-prompt custom hook commands in `customHooks` with
 * sibling `UserPromptSubmit` entries in Claude Code's settings.json hooks map.
 *
 * Why: phren's chained `runPrePromptHooks` runs custom hooks sequentially
 * inside its own UserPromptSubmit handler, so a slow custom hook (e.g. one
 * that does an `ls` against a OneDrive-backed WSL mount) eats phren's whole
 * response budget and times out before injecting anything. Registering each
 * pre-prompt custom hook as a peer `UserPromptSubmit` entry lets Claude Code
 * dispatch it in parallel with phren's own hook — they get independent
 * timeout budgets and one cannot block the other.
 *
 * Identification: phren tracks "managed" sibling commands in
 * `prefs.managedPrePromptSiblingCommands`. On each sync we (a) append a new
 * sibling for each pre-prompt command not already in settings.json, (b)
 * remove sibling entries whose command was previously managed but is no
 * longer in `customHooks`, and (c) leave any user-authored hook entries
 * (entries whose command never appeared in the managed list) untouched.
 *
 * Webhook custom hooks are not affected — they're already async/fire-and-
 * forget and don't compete for hook event time.
 *
 * Idempotent.
 */
export declare function upsertCustomPrePromptSiblings(hooksMap: HookMap, phrenPath: string): {
    added: number;
    removed: number;
};
export declare function configureClaude(phrenPath: string, opts?: {
    mcpEnabled?: boolean;
    hooksEnabled?: boolean;
}): McpConfigStatus;
/** Reset the VS Code path probe cache (for testing). */
export declare function resetVSCodeProbeCache(): void;
export declare function configureVSCode(phrenPath: string, opts?: {
    mcpEnabled?: boolean;
    scope?: "user" | "workspace";
}): McpConfigStatus | "no_vscode";
export declare function configureCursorMcp(phrenPath: string, opts?: {
    mcpEnabled?: boolean;
}): ToolStatus;
export declare function configureCopilotMcp(phrenPath: string, opts?: {
    mcpEnabled?: boolean;
}): ToolStatus;
export declare function configureCodexMcp(phrenPath: string, opts?: {
    mcpEnabled?: boolean;
}): ToolStatus;
export declare function logMcpTargetStatus(tool: string, status: string, phase?: "Configured" | "Updated"): void;
export {};

export type PluginSetupReason = "no-store" | "stand-down";
/**
 * True when Claude Code will also load a user-level `phren` server that
 * `phren init` registered. Claude Code reads user MCP servers from
 * `.claude.json` (inside CLAUDE_CONFIG_DIR when set), not from settings.json,
 * so an entry only in settings.json does not count.
 */
export declare function userLevelPhrenMcpConfigured(env?: NodeJS.ProcessEnv): boolean;
/** Why `phren mcp` should not start the full server, or null when it should. */
export declare function pluginSetupReason(env?: NodeJS.ProcessEnv): PluginSetupReason | null;
export declare function setupMessage(): string;
export declare function runInitForPlugin(): {
    ok: boolean;
    output: string;
};
export declare function runPluginSetupServer(reason: PluginSetupReason): Promise<void>;

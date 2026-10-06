export type HookToolName = "claude" | "copilot" | "cursor" | "codex";
export declare const HOOK_TOOL_NAMES: readonly ["claude", "copilot", "cursor", "codex"];
export type McpRootKey = "mcpServers" | "servers";
type CommandExistsFn = (cmd: string) => boolean;
export declare function hookConfigPath(tool: HookToolName, phrenPath?: string | undefined): string;
export declare function hookConfigPaths(phrenPath: string): Record<HookToolName, string>;
export declare function hookConfigRoots(phrenPath: string): string[];
export declare function vscodeMcpCandidates(env?: NodeJS.ProcessEnv): string[];
export declare function probeVsCodeConfig(commandExists: CommandExistsFn, env?: NodeJS.ProcessEnv): {
    targetDir: string | null;
    installed: boolean;
};
export declare function cursorMcpCandidates(env?: NodeJS.ProcessEnv): string[];
export declare function resolveCursorMcpConfig(commandExists: CommandExistsFn, env?: NodeJS.ProcessEnv): {
    installed: boolean;
    existing: string | null;
    target: string;
};
export declare function copilotMcpCandidates(env?: NodeJS.ProcessEnv): string[];
export declare function resolveCopilotMcpConfig(commandExists: CommandExistsFn, env?: NodeJS.ProcessEnv): {
    installed: boolean;
    existing: string | null;
    cliConfig: string;
    hasCliDir: boolean;
};
export declare function codexJsonCandidates(phrenPath: string, env?: NodeJS.ProcessEnv): string[];
export declare function resolveCodexMcpConfig(phrenPath: string, commandExists: CommandExistsFn, env?: NodeJS.ProcessEnv): {
    installed: boolean;
    tomlPath: string;
    existingJson: string | null;
    preferToml: boolean;
    jsonCandidates: string[];
};
export {};

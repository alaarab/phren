/**
 * Git run by phren never asks a human anything. Without this, a store or
 * project with an HTTPS remote and no credential helper makes git read
 * "Username for 'https://github.com':" from the controlling terminal, which
 * inside an agent's pane stalls the agent before its first prompt.
 */
export declare const nonInteractiveGitEnv: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
export declare function runGitOrThrow(cwd: string, args: string[], timeoutMs: number): string;
export declare function runGit(cwd: string, args: string[], timeoutMs: number, debugLogFn?: (msg: string) => void): string | null;
interface ResolvedExecCommand {
    command: string;
    shell: boolean;
}
export declare function normalizeExecCommand(cmd: string, platform?: NodeJS.Platform, whereOutput?: string | null): ResolvedExecCommand;
export declare function resolveExecCommand(cmd: string): ResolvedExecCommand;
export declare function errorMessage(err: unknown): string;
export declare function isFeatureEnabled(envName: string, defaultValue?: boolean): boolean;
export declare function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number;
export declare function clampFloat(raw: string | undefined, fallback: number, min: number, max: number): number;
export declare function getOptionValue(args: string[], name: string): string | undefined;
export declare function getPositionalArgs(args: string[], optionNamesWithValues: string[]): string[];
export {};

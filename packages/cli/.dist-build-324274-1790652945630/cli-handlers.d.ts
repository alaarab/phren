/**
 * Native handler implementations for top-level CLI commands.
 *
 * These were the inline if/else branches inside entrypoint.ts's runTopLevelCommand.
 * They moved here so the command registry can dispatch to them without
 * eagerly pulling init/init.js (which is heavy) into every phren invocation.
 *
 * Loaded only when a native command actually runs, via dynamic import from cli-registry.ts.
 */
export declare function runAddCommand(args: string[]): Promise<number>;
export declare function runInitCommand(args: string[]): Promise<number>;
export declare function runUninstallCommand(args: string[]): Promise<number>;
export declare function runStatusCommand(_args: string[]): Promise<number>;
export declare function runVerifyCommand(_args: string[]): Promise<number>;
export declare function runMcpModeCommand(args: string[]): Promise<number>;
export declare function runHooksModeCommand(args: string[]): Promise<number>;
export declare function runPresetCommand(args: string[]): Promise<number>;
export declare function runSnippetCommand(_args: string[]): Promise<number>;
export declare function runLinkRemovedNotice(args: string[]): Promise<number>;

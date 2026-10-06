export type TopLevelInvocation = {
    kind: "manage";
    argv: string[];
} | {
    kind: "mcp";
    phrenArg: string;
} | {
    kind: "mcp-serve";
} | {
    kind: "help";
} | {
    kind: "version";
};
export declare function resolveTopLevelInvocation(argv: string[]): TopLevelInvocation;
export declare function printIntegratedHelp(): void;
export declare function printIntegratedVersion(): void;
export declare function runTopLevelCommand(argv: string[], opts?: {
    allowDefaultShell?: boolean;
}): Promise<boolean>;

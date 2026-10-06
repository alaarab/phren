export declare function parseProjectArg(args: string[]): {
    project?: string;
    rest: string[];
};
export declare function checkProjectInProfile(phrenPath: string, project: string): string | null;
export declare function warnIfUnregistered(phrenPath: string, project: string): void;

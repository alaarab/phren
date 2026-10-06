export declare function claudeProjectKey(): string;
export declare function writeContextDefault(machine: string, profile: string, mcpStatus: string, projects: string[], phrenPath: string): void;
export declare function writeContextDebugging(machine: string, profile: string, mcpStatus: string, projects: string[], phrenPath: string): void;
export declare function writeContextPlanning(machine: string, profile: string, mcpStatus: string, projects: string[], phrenPath: string): void;
export declare function writeContextClean(machine: string, profile: string, mcpStatus: string, projects: string[]): void;
export declare function readBackNativeMemory(phrenPath: string, projects: string[]): void;
export declare function rebuildMemory(phrenPath: string, projects: string[]): void;

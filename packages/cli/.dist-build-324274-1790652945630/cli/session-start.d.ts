export declare function getUntrackedProjectNotice(phrenPath: string, cwd: string): string | null;
export declare function getSessionStartOnboardingNotice(phrenPath: string, cwd: string, activeProject: string | null): string | null;
export declare function handleHookSessionStart(): Promise<void>;

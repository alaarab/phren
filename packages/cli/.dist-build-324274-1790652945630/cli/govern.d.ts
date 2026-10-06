export interface GovernanceSummary {
    projects: number;
    staleCount: number;
    conflictCount: number;
    reviewCount: number;
}
export declare function handleGovernMemories(projectArg?: string, silent?: boolean, dryRun?: boolean): Promise<GovernanceSummary>;
export declare function handlePruneMemories(args?: string[]): Promise<void>;
export declare function handleConsolidateMemories(args?: string[]): Promise<void>;
export declare function handleMaintain(args: string[]): Promise<void | GovernanceSummary>;
/**
 * `phren maintain summarize [project] [--llm] [--force]`: write the "## Now"
 * block at the top of every topic file and "What phren knows" in summary.md.
 */
export declare function handleSummarize(args: string[]): Promise<void>;
export declare function handleBackgroundMaintenance(projectArg?: string): Promise<void>;

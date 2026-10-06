export type MigrationOutcome = {
    from: string;
    to: string;
    action: "renamed";
} | {
    from: string;
    to: string;
    action: "skipped-collision";
    reason: string;
} | {
    from: string;
    to: string;
    action: "skipped-invalid-slug";
    reason: string;
} | {
    from: string;
    to: string;
    action: "error";
    reason: string;
};
export interface MigrationResult {
    outcomes: MigrationOutcome[];
}
export declare function migrateInvalidProjectNames(phrenPath: string): MigrationResult;
export declare function formatMigrationSummary(result: MigrationResult): string;

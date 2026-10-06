import type { CodeStatus, OutlineEntry, ReferenceResult, SymbolDefinition, SymbolHit, UsageEntry } from "@phren/code";
declare const indexProject: typeof import("@phren/code").indexProject;
import type { ChangedFile } from "./changes.js";
export declare function requireCodePackage(store?: string): Promise<typeof import("@phren/code")>;
/** Resolve only registered stores. Phone IDs are repository names; no client
 * path can select a filesystem location. Omitting the ID supports older phones. */
export declare function resolveCodeStore(base: string, value?: string | null, write?: boolean): Promise<string>;
/** The phone names a project and an optional query; both are validated here. */
export declare class CodeRoutes {
    private readonly store;
    constructor(store: string);
    status(projectValue: string | null): Promise<CodeStatus>;
    search(projectValue: string | null, queryValue: string | null, kindValue: string | null, limitValue: string | null, directoryValue?: string | null): Promise<{
        project: string;
        query: string;
        symbols: SymbolHit[];
    }>;
    tree(projectValue: string | null, directoryValue?: string | null): Promise<{
        project: string;
        directory: string;
        entries: import("@phren/code").CodeTreeEntry[];
    }>;
    usagePage(projectValue: string | null, values?: {
        kind?: string | null;
        file?: string | null;
        directory?: string | null;
        offset?: string | null;
        limit?: string | null;
        end?: string | null;
    }): Promise<{
        entries: SymbolHit[];
        total: number;
        offset: number;
        limit: number;
        maxUses: number;
        project: string;
    }>;
    /** The checkout this computer indexes for `project`, or a 404 naming the project. */
    private checkout;
    private changedIn;
    /**
     * What changed: the functions, types and variables that today's agent
     * sessions edited in this project's checkout, and its last 10 commits,
     * grouped by file, most recent work first. Session edits carry the line
     * numbers they had when made, so a later edit to the same file can shift one.
     */
    whatChanged(projectValue: string | null, now?: Date): Promise<{
        project: string;
        files: {
            path: string;
            items: import("@phren/code").ChangedDeclaration[];
        }[];
    }>;
    /**
     * Per-file counts for the Changes tree's chips: functions and types the
     * working tree changes or adds (variables stay out to keep a chip short).
     * An untracked file is new throughout.
     */
    changeCounts(projectValue: string | null, pathsValue: string | null): Promise<{
        project: string;
        entries: {
            path: string;
            functions: {
                changed: number;
                added: number;
            };
            types: {
                changed: number;
                added: number;
            };
            first?: string | undefined;
        }[];
    }>;
    /** Turns code intelligence off for a project: its index is deleted, and
     * the reindexer follows only projects that have one, so nothing rebuilds it
     * until the phone turns it on again. */
    disable(projectValue: string | null): Promise<{
        project: string;
        disabled: true;
    }>;
    reindex(projectValue: string | null): Promise<CodeStatus>;
    outline(projectValue: string | null, pathValue: string | null): Promise<{
        project: string;
        path: string;
        entries: OutlineEntry[];
    }>;
    /** Resolved uses made from one file, with the declaration each names, so the
     * phone's code viewer can make those identifiers tappable. */
    fileReferences(projectValue: string | null, pathValue: string | null): Promise<{
        project: string;
        path: string;
        references: import("@phren/code").FileReference[];
    }>;
    outlineSummary(projectValue: string | null, pathsValue: string | null): Promise<{
        project: string;
        entries: import("@phren/code").OutlineSummary[];
    }>;
    definition(projectValue: string | null, symbolValue: string | null): Promise<{
        project: string;
        definition: SymbolDefinition & {
            findings: import("@phren/code").CitingFinding[];
        };
    }>;
    references(projectValue: string | null, symbolValue: string | null, limitValue: string | null): Promise<{
        project: string;
        references: ReferenceResult;
    }>;
    usage(projectValue: string | null, topValue: string | null): Promise<{
        project: string;
        usage: {
            hot: UsageEntry[];
            cold: UsageEntry[];
        };
    }>;
}
export interface CodeReindexOptions {
    store: string;
    /** Index function; injectable so tests do not need the real parser. */
    index?: typeof indexProject;
    /** Where the one-line-per-run report goes; defaults to the CLI logger. */
    log?: (line: string) => void;
    /** How long to wait for the writes to settle. */
    debounceMs?: number;
}
/**
 * Re-indexes a project when the git module's change capture records a file
 * event inside it. The Hook only constructs this while the `code` module is on,
 * and only projects that already have an index are followed. A branch switch
 * (the repository's HEAD moved) upgrades the pending run to a full re-index.
 */
export declare class CodeReindexer {
    private readonly store;
    private readonly index;
    private readonly log;
    private readonly debounceMs;
    private readonly timers;
    private readonly pendingFull;
    private readonly running;
    private readonly rerun;
    private readonly heads;
    private closed;
    constructor(options: CodeReindexOptions);
    /** One recorded change event; schedules an incremental re-index of the project it belongs to. */
    record(files: ChangedFile[]): void;
    private recordAsync;
    close(): void;
    private indexedProjects;
    private schedule;
    private run;
}
export {};

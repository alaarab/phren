import type { SqlJsDatabase } from "../shared/index.js";
import { type LookupEvent } from "../governance/activity.js";
export interface EntryScore {
    impressions: number;
    helpful: number;
    repromptPenalty: number;
    regressionPenalty: number;
    lastUsedAt: string;
}
export interface GraphNode {
    id: string;
    label: string;
    fullLabel: string;
    group: string;
    refCount: number;
    project: string;
    store?: string;
    tagged: boolean;
    scoreKey?: string;
    priority?: string;
    section?: string;
    entityType?: string;
    refDocs?: GraphDocRef[];
    scoreKeys?: string[];
    topicSlug?: string;
    topicLabel?: string;
    /** Findings only: the `## YYYY-MM-DD` heading the entry sits under. */
    date?: string;
    /** Project nodes only: real per-project totals for tooltips/labels. */
    findingCount?: number;
    taskCount?: number;
}
export interface GraphDocRef {
    doc: string;
    project: string;
    scoreKey?: string;
}
export interface GraphTopicMeta {
    slug: string;
    label: string;
}
export interface GraphLink {
    source: string;
    target: string;
    /** Absent for the default project→leaf spoke; set for the opt-in enrichment edges. */
    kind?: "fragment" | "supersedes" | "contradicts";
}
export interface BuildGraphOptions {
    /** Fragment↔fragment edges for fragments co-mentioned in the same documents. */
    includeFragmentEdges?: boolean;
    /** Finding→finding edges from `supersedes` / `contradicts` lifecycle annotations. */
    includeLifecycleEdges?: boolean;
}
interface ProjectInfo {
    name: string;
    storePath: string;
    store?: string;
    findingCount: number;
    taskCount: number;
    hasClaudeMd: boolean;
    hasSummary: boolean;
    hasReference: boolean;
    summaryText: string;
    githubUrl?: string;
    sparkline: number[];
}
export declare function readSyncSnapshot(phrenPath: string): {
    autoSaveStatus?: undefined;
    autoSaveDetail?: undefined;
    lastPullAt?: undefined;
    lastPullStatus?: undefined;
    lastPushAt?: undefined;
    lastPushStatus?: undefined;
    unsyncedCommits?: undefined;
    lastPushDetail?: undefined;
} | {
    autoSaveStatus: string;
    autoSaveDetail: string;
    lastPullAt: string;
    lastPullStatus: string;
    lastPushAt: string;
    lastPushStatus: string;
    unsyncedCommits: number;
    lastPushDetail: string;
};
export declare function isAllowedFilePath(filePath: string, phrenPath: string): boolean;
/**
 * Stricter path check for skill endpoints — only allows files under skills/ directories,
 * not the entire phren store.
 */
export declare function isAllowedSkillPath(filePath: string, phrenPath: string): boolean;
/** Allow only the four exact lifecycle-hook config files surfaced by the UI. */
export declare function isAllowedHookConfigPath(filePath: string, phrenPath: string): boolean;
export declare function collectSkillsForUI(phrenPath: string, profile?: string): Array<{
    name: string;
    source: string;
    path: string;
    enabled: boolean;
}>;
export declare function getHooksData(phrenPath: string, profile?: string): {
    globalEnabled: boolean;
    tools: {
        tool: "claude" | "codex" | "copilot" | "cursor";
        enabled: boolean;
        configPath: string;
        exists: boolean;
    }[];
    customHooks: import("../hooks.js").CustomHookEntry[];
    projectOverrides: {
        project: string;
        baseEnabled: boolean | null;
        events: Array<{
            event: string;
            configured: boolean | null;
            enabled: boolean;
        }>;
    }[];
};
export declare function buildGraph(phrenPath: string, profile?: string, focusProject?: string, existingDb?: SqlJsDatabase | null, opts?: BuildGraphOptions): Promise<{
    nodes: GraphNode[];
    links: GraphLink[];
    total: number;
    scores: Record<string, EntryScore>;
    topics: GraphTopicMeta[];
}>;
export declare function recentUsage(phrenPath: string): string[];
export declare function recentLookups(phrenPath: string, limit?: number): LookupEvent[];
export declare function recentAccepted(phrenPath: string): string[];
export declare function collectProjectsForUI(phrenPath: string, profile?: string): ProjectInfo[];
export {};

export declare const NOW_START = "<!-- phren:now:start -->";
export declare const NOW_END = "<!-- phren:now:end -->";
export declare const KNOWS_START = "<!-- phren:knows:start -->";
export declare const KNOWS_END = "<!-- phren:knows:end -->";
/** Bullets a topic file may hold before the oldest sections move to <topic>.older.md. */
export declare const TOPIC_SPLIT_AT = 400;
export interface ArchivedBullet {
    date: string;
    tag: string;
    text: string;
}
export interface TopicDigest {
    slug: string;
    file: string;
    bullets: number;
    tags: Record<string, number>;
    first: string;
    last: string;
    mentioned: string[];
    headlines: string[];
}
/** Every "- " bullet under an "## Archived <date>" heading (or before any heading, for legacy files). */
export declare function parseTopicBullets(content: string): ArchivedBullet[];
/** Names the bullets keep coming back to: backticked identifiers and CamelCase words. ALLCAPS is emphasis, not a name. */
export declare function mostMentioned(bullets: ArchivedBullet[], limit?: number): string[];
export declare function digestTopic(slug: string, file: string, bullets: ArchivedBullet[]): TopicDigest;
/** The paragraph that can always be written, no model required. */
export declare function structuralNow(d: TopicDigest): string;
/**
 * Identifiers a paragraph names that none of the bullets do. A small local
 * model asked to summarise engineering notes will happily invent the stack
 * ("built on argparse" for a TypeScript project); a summary that adds facts
 * is worse than no summary, so any invented identifier fails the paragraph.
 */
export declare function inventedIdentifiers(prose: string, bullets: ArchivedBullet[]): string[];
/**
 * A prose paragraph over the newest bullets, when a model is configured; ""
 * otherwise, and "" when the paragraph names things the bullets do not.
 */
export declare function proseNow(d: TopicDigest, bullets: ArchivedBullet[], signal?: AbortSignal): Promise<string>;
/** Fingerprint of everything in a topic file except its own Now block. */
export declare function contentFingerprint(content: string, start: string, end: string): string;
/** Insert or replace a marked block. Topic files: before the first section; summary: at the end. */
export declare function upsertBlock(content: string, start: string, end: string, rendered: string, where: "top" | "bottom"): string;
/** The stamp and fingerprint inside an existing block, so unchanged files are not rewritten. */
export declare function blockMeta(content: string, start: string): {
    at: string;
    hash: string | null;
} | null;
export interface SummarizeOptions {
    /** Ask a configured model for prose; falls back to structural when none answers. */
    llm?: boolean;
    /** Re-summarize even when the file has not changed since the last block. */
    force?: boolean;
    now?: () => Date;
}
export interface TopicResult {
    slug: string;
    file: string;
    bullets: number;
    updated: boolean;
    split?: string;
    now: string;
}
/**
 * Move whole "## Archived <date>" sections, oldest first, into <topic>.older.md
 * until the file is under the cap. Returns the older file's path if anything moved.
 */
export declare function splitTopicFile(filePath: string, maxBullets?: number): string | null;
export declare function summarizeTopicFile(filePath: string, slug: string, opts?: SummarizeOptions): Promise<TopicResult>;
export interface ProjectSummary {
    project: string;
    topics: TopicResult[];
    summaryPath: string | null;
    summaryUpdated: boolean;
}
export declare function countActiveFindingsIn(findingsPath: string): number;
export declare function countOpenTasks(tasksPath: string): number;
/** What a project holds, counted the same way everywhere a count is shown:
 * live findings, team journal findings, everything archived into topic files
 * (older halves included), and open tasks. Every graph and project list reads
 * this so no surface shows only the slice it happened to draw. */
export interface ProjectMemoryCounts {
    active: number;
    journal: number;
    archived: number;
    findings: number;
    openTasks: number;
}
export declare function projectMemoryCounts(phrenPath: string, project: string): ProjectMemoryCounts;
/** Summarize every topic file of a project and refresh the "What phren knows" block in summary.md. */
export declare function summarizeProject(phrenPath: string, project: string, opts?: SummarizeOptions): Promise<ProjectSummary>;
export interface TopicFile {
    slug: string;
    file: string;
}
/** Every markdown file under a project's reference/topics, minus the .older.md spill-over files. */
export declare function listTopicFiles(phrenPath: string, project: string): TopicFile[];
/** The current Now text of a topic file and whether it is structural or prose. */
export declare function readNowBlock(content: string): {
    text: string;
    structural: boolean;
} | null;
/**
 * Store a paragraph an agent wrote for a topic, under the same rule a model's
 * paragraph gets: every identifier it names must appear in the bullets.
 * Returns the invented names on refusal.
 */
export declare function setTopicSummary(filePath: string, text: string, now?: () => Date): {
    ok: true;
} | {
    ok: false;
    invented: string[];
} | {
    ok: false;
    error: string;
};
/** The "What phren knows" block of a project, for the hook to inject; null when absent. */
export declare function readKnowsBlock(phrenPath: string, project: string): {
    path: string;
    text: string;
} | null;

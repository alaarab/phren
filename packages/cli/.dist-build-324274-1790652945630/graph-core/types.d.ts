/**
 * Shared graph payload contract.
 *
 * This module is consumed by three hosts: the browser 3D viewer (bundled by
 * esbuild from `browser/`), the VS Code webview (via the same bundle), and the
 * terminal graph view in `phren shell` (compiled by tsc). It must therefore
 * stay free of DOM, node builtins, and any import outside `src/graph-core/`.
 */
export type ScoreEntry = {
    impressions?: number;
    helpful?: number;
    repromptPenalty?: number;
    regressionPenalty?: number;
    lastUsedAt?: string;
};
export type RawNode = {
    id: string;
    label: string;
    fullLabel?: string;
    group: string;
    refCount?: number;
    project?: string;
    store?: string;
    tagged?: boolean;
    scoreKey?: string;
    scoreKeys?: string[];
    priority?: string;
    section?: string;
    entityType?: string;
    date?: string;
    refDocs?: Array<{
        doc: string;
        project?: string;
        scoreKey?: string;
    }>;
    connectedProjects?: string[];
    topicSlug?: string;
    topicLabel?: string;
    findingCount?: number;
    taskCount?: number;
    /** The number beside a project's label for the active filter (the phone sets it). */
    labelCount?: number;
};
/**
 * Edge flavour. Absent (or "star") is the default project→leaf spoke the web
 * viewer has always drawn; the typed kinds are opt-in enrichments emitted by
 * `buildGraph` for hosts that want real traversal structure.
 */
export type RawLinkKind = "star" | "fragment" | "supersedes" | "contradicts";
export type RawLink = {
    source: string;
    target: string;
    kind?: RawLinkKind;
};
export type RawTopic = {
    slug: string;
    label: string;
};
export type GraphPayload = {
    nodes?: RawNode[];
    links?: RawLink[];
    scores?: Record<string, ScoreEntry>;
    topics?: RawTopic[];
};
export type NodeKind = "project" | "finding" | "task" | "entity" | "reference" | "topic" | "note" | "other";
export type NodeHealth = "healthy" | "decaying" | "stale";
export type RuntimeNode = RawNode & {
    kind: NodeKind;
    searchText: string;
    health: NodeHealth;
    baseColor: string;
    size: number;
    forceLabel: boolean;
};
export type NodeDetail = RuntimeNode & {
    displayLabel: string;
    tooltipLabel: string;
    text: string;
    docs: string[];
    projectName: string;
    qualityScore: number | null;
    connections: {
        total: number;
        projects: number;
        findings: number;
        tasks: number;
        entities: number;
        references: number;
        topics: number;
        notes: number;
    };
    score?: ScoreEntry;
    /** Values supplied by the project pane's inline editor on save. */
    editedText?: string;
    editedSection?: string;
    editedPriority?: string;
};
/** The void. Every layer sits on this near-black indigo. */
export declare const BG_COLOR = "#05060f";
/** Amber used for selection / focused links — the single warm accent. */
export declare const ACCENT_AMBER = "#ffd166";
/** Cyan used for live pulses, HUD borders and hover accents. */
export declare const ACCENT_CYAN = "#67e8f9";
export declare const TOPIC_COLORS: Record<string, string>;
export declare const KIND_COLORS: {
    project: string;
    entity: string;
    reference: string;
    note: string;
    "task-active": string;
    "task-queue": string;
    "task-done": string;
    other: string;
};
export declare const STORE_COLORS: string[];

export interface ProjectTopic {
    slug: string;
    label: string;
    description: string;
    keywords: string[];
}
export interface BuiltinTopic {
    name: string;
    description: string;
    keywords: string[];
}
export type ProjectTopicSource = "default" | "custom";
export interface ProjectTopicDocInfo {
    slug: string;
    label: string;
    file: string;
    path: string;
    exists: boolean;
    autoManaged: boolean;
    entryCount: number;
    lastModified: string;
}
export interface ProjectReferenceDocInfo {
    file: string;
    path: string;
    title: string;
    autoManaged: boolean;
    entryCount: number;
    lastModified: string;
}
export interface LegacyTopicDocInfo extends ProjectReferenceDocInfo {
    slug: string;
    eligible: boolean;
    reason?: string;
}
export interface ProjectTopicSuggestion {
    slug: string;
    label: string;
    description: string;
    keywords: string[];
    source: "builtin" | "heuristic" | "pinned";
    reason: string;
    confidence: number;
}
export interface ProjectTopicsResponse {
    source: ProjectTopicSource;
    topics: ProjectTopic[];
    suggestions: ProjectTopicSuggestion[];
    pinnedTopics: ProjectTopic[];
    legacyDocs: LegacyTopicDocInfo[];
    topicDocs: ProjectTopicDocInfo[];
}
export interface ReferenceListResponse {
    topicDocs: ProjectTopicDocInfo[];
    otherDocs: ProjectReferenceDocInfo[];
}
export interface ReclassifyTopicsResult {
    movedFiles: number;
    movedEntries: number;
    skipped: Array<{
        file: string;
        reason: string;
    }>;
}
declare const DOMAIN_TOPICS: Record<string, ProjectTopic[]>;
export declare function topicReferencePath(phrenPath: string, project: string, slug: string): string | null;
export declare function normalizeBuiltinTopicDomain(domain?: string): keyof typeof DOMAIN_TOPICS;
export declare function getBuiltinTopicConfig(domain?: string): BuiltinTopic[];
export declare function getBuiltinTopics(phrenPath?: string, project?: string): ProjectTopic[];
export declare function readProjectTopics(phrenPath: string, project: string): {
    source: ProjectTopicSource;
    topics: ProjectTopic[];
    domain?: string;
    error?: string;
};
export declare function pinProjectTopicSuggestion(phrenPath: string, project: string, topic: ProjectTopic): {
    ok: true;
    pinnedTopics: ProjectTopic[];
} | {
    ok: false;
    error: string;
};
export declare function unpinProjectTopicSuggestion(phrenPath: string, project: string, slug: string): {
    ok: true;
    pinnedTopics: ProjectTopic[];
} | {
    ok: false;
    error: string;
};
export declare function writeProjectTopics(phrenPath: string, project: string, topics: ProjectTopic[]): {
    ok: true;
    topics: ProjectTopic[];
} | {
    ok: false;
    error: string;
};
export declare function classifyTopicForText(text: string, topics: ProjectTopic[]): ProjectTopic;
export declare function appendArchivedEntriesToTopicDoc(filePath: string, project: string, topic: ProjectTopic, entries: Array<{
    date: string;
    bullet: string;
    citation?: string;
}>): void;
export declare function ensureTopicReferenceDoc(phrenPath: string, project: string, topic: ProjectTopic): {
    ok: true;
    path: string;
} | {
    ok: false;
    error: string;
};
export declare function listProjectReferenceDocs(phrenPath: string, project: string, topics?: ProjectTopic[]): ReferenceListResponse;
export declare function suggestTopics(phrenPath: string, project: string, topics?: ProjectTopic[]): ProjectTopicSuggestion[];
/** @internal Exported for tests. */
export declare const suggestProjectTopics: typeof suggestTopics;
export declare function getProjectTopicsResponse(phrenPath: string, project: string): ProjectTopicsResponse;
export declare function readReferenceContent(phrenPath: string, project: string, file: string): {
    ok: true;
    content: string;
} | {
    ok: false;
    error: string;
};
export declare function reclassifyLegacyTopicDocs(phrenPath: string, project: string): ReclassifyTopicsResult;
export {};

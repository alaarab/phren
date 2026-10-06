/**
 * Returns a <script> block with shared browser helpers used across all UI IIFEs:
 *   window._phrenEsc(s)          — HTML-escape a value
 *   window._phrenAuthToken       — the current auth token
 *   window._phrenAuthUrl(base)   — append _auth param to a URL
 *   window._phrenAuthBody(body)  — append _auth param to a form body
 *   window._phrenFetchCsrfToken(cb) — fetch the CSRF token and call cb(token)
 */
export declare function renderSharedWebUiHelpers(authToken: string): string;
export declare function renderProfileSwitcherScript(_authToken: string): string;
export declare function renderFindingCaptureEnhancementScript(): string;
export declare function renderNotesEnhancementScript(): string;
export declare function renderSkillUiEnhancementScript(_authToken: string): string;
export declare function renderProjectReferenceEnhancementScript(_authToken: string): string;
export declare function renderTasksAndSettingsScript(authToken: string): string;
export declare function renderSearchScript(authToken: string): string;
export declare function renderEventWiringScript(): string;
export declare function renderGraphHostScript(): string;
export declare function renderReviewQueueKeyboardScript(_authToken: string): string;
/**
 * Live "Activity" tab: streams memory lookups from /api/lookups/stream (SSE)
 * and prepends them to #activity-feed in real time, so you can watch phren land
 * on memories as it searches. Falls back gracefully if EventSource is missing.
 */
export declare function renderActivityStreamScript(_authToken: string): string;
/**
 * Drives the graph mascot from the live lookup feed: each 'phren:lookup' event
 * (dispatched by the activity stream) maps to a graph node and sends phren
 * walking to it, so you can watch phren traverse the knowledge graph in real
 * time. No-ops gracefully until the graph is mounted (Graph tab opened).
 */
export declare function renderGraphWalkScript(): string;

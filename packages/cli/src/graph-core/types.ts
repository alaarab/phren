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
  refDocs?: Array<{ doc: string; project?: string; scoreKey?: string }>;
  connectedProjects?: string[];
  topicSlug?: string;
  topicLabel?: string;
  findingCount?: number;
  taskCount?: number;
};

/**
 * Edge flavour. Absent (or "star") is the default project→leaf spoke the web
 * viewer has always drawn; the typed kinds are opt-in enrichments emitted by
 * `buildGraph` for hosts that want real traversal structure.
 */
export type RawLinkKind = "star" | "fragment" | "supersedes" | "contradicts";

export type RawLink = { source: string; target: string; kind?: RawLinkKind };

export type RawTopic = { slug: string; label: string };

export type GraphPayload = {
  nodes?: RawNode[];
  links?: RawLink[];
  scores?: Record<string, ScoreEntry>;
  topics?: RawTopic[];
};

export type NodeKind = "project" | "finding" | "task" | "entity" | "reference" | "other";
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
  };
  score?: ScoreEntry;
  /** Values supplied by the project pane's inline editor on save. */
  editedText?: string;
  editedSection?: string;
  editedPriority?: string;
};

// ── Holographic-archive palette ─────────────────────────────────────────

/** The void. Every layer sits on this near-black indigo. */
export const BG_COLOR = "#05060f";

/** Amber used for selection / focused links — the single warm accent. */
export const ACCENT_AMBER = "#ffd166";

/** Cyan used for live pulses, HUD borders and hover accents. */
export const ACCENT_CYAN = "#67e8f9";

export const TOPIC_COLORS: Record<string, string> = {
  architecture: "#46c8ff",
  debugging: "#ff5470",
  security: "#ff7847",
  performance: "#ffb648",
  testing: "#3ce8a4",
  devops: "#2ee6c8",
  tooling: "#6d8dff",
  api: "#4f7dff",
  database: "#38b6ff",
  frontend: "#b48bff",
  auth: "#ff9346",
  data: "#2ed3e8",
  mobile: "#43e0a8",
  ai_ml: "#9d7bff",
  general: "#7f8db3",
};

export const KIND_COLORS = {
  project: "#f5b342",
  entity: "#38e1ff",
  reference: "#42e099",
  "task-active": "#3ae374",
  "task-queue": "#48b2ff",
  "task-done": "#5c6b8a",
  other: "#7f8db3",
};

// Distinct colors per store — up to 6 stores, then cycles
export const STORE_COLORS = ["#f5b342", "#9d7bff", "#2ed3e8", "#ff5470", "#43e0a8", "#f472b6"];

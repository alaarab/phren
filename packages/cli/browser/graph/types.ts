import type * as THREE from "three";
import type { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

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

export type RawLink = { source: string; target: string };

export type RawTopic = { slug: string; label: string };

export type GraphPayload = {
  nodes?: RawNode[];
  links?: RawLink[];
  scores?: Record<string, ScoreEntry>;
  topics?: RawTopic[];
};

export type RuntimeNode = RawNode & {
  kind: "project" | "finding" | "task" | "entity" | "reference" | "other";
  searchText: string;
  health: "healthy" | "decaying" | "stale";
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
};

/** A node object handed to 3d-force-graph. Force layout mutates x/y/z/vx/vy/vz onto it. */
export type FGNode = {
  id: string;
  raw: RuntimeNode;
  x?: number;
  y?: number;
  z?: number;
  fx?: number;
  fy?: number;
  fz?: number;
  __group?: THREE.Group;
  __dot?: THREE.Sprite;
  __core?: THREE.Mesh;
  __shell?: THREE.Mesh;
  __wire?: THREE.Mesh;
  __ring?: THREE.Mesh;
  __halo?: THREE.Sprite;
  __labelObj?: CSS2DObject;
  __labelEl?: HTMLDivElement;
  __focusScale?: number;
  __phase?: number;
  /** Current dim intensity 0..1 applied to materials. */
  __int?: number;
  /** Target dim intensity the ambient loop lerps toward. */
  __intTarget?: number;
  /** Extra per-node stagger delay (seconds) used by the intro fade. */
  __introDelay?: number;
};

/** A link object handed to 3d-force-graph. Force layout swaps source/target to node refs. */
export type FGLink = { source: string | FGNode; target: string | FGNode };

export type SelectCallback = (node: NodeDetail, x: number, y: number) => void;
export type ClearCallback = () => void;

export type PhrenGraphApi = {
  __renderer: string;
  mount: (payload: GraphPayload) => void;
  onNodeSelect: (callback: SelectCallback) => void;
  onSelectionClear: (callback: ClearCallback) => void;
  onRightClick: (callback: (node: NodeDetail, x: number, y: number) => void) => void;
  onItemAction: (callback: (node: NodeDetail, action: string) => void) => void;
  clearSelection: () => void;
  selectNode: (nodeId: string) => boolean;
  focusNode: (nodeId: string) => boolean;
  walkTo: (nodeId: string) => boolean;
  getNodeAt: (x: number, y: number) => NodeDetail | null;
  getNodeDetail: (nodeId: string) => NodeDetail | null;
  getData: () => { nodes: NodeDetail[]; links: RawLink[]; topics: RawTopic[]; total: number };
  removeNode: (nodeId: string, opts?: { animate?: boolean }) => boolean;
  updateNode: (
    nodeId: string,
    changes: {
      label?: string;
      fullLabel?: string;
      text?: string;
      section?: string;
      priority?: string;
      topicSlug?: string;
      topicLabel?: string;
      color?: string;
    },
  ) => boolean;
  destroy: () => void;
};

export const ROOT = window as unknown as {
  phrenGraph?: PhrenGraphApi;
  graphZoom?: (factor: number) => void;
  graphReset?: () => void;
  graphResetLayout?: () => void;
  graphClearSelection?: () => void;
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

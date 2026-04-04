import Graph from "graphology";
import Sigma from "sigma";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { PHREN_SPRITE_B64 } from "./phren-sprite.js";

type ScoreEntry = {
  impressions?: number;
  helpful?: number;
  repromptPenalty?: number;
  regressionPenalty?: number;
  lastUsedAt?: string;
};

type RawNode = {
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
};

type RawLink = { source: string; target: string };

type RawTopic = { slug: string; label: string };

type GraphPayload = {
  nodes?: RawNode[];
  links?: RawLink[];
  scores?: Record<string, ScoreEntry>;
  topics?: RawTopic[];
};

type RuntimeNode = RawNode & {
  kind: "project" | "finding" | "task" | "entity" | "reference" | "other";
  searchText: string;
  health: "healthy" | "decaying" | "stale";
  baseColor: string;
  size: number;
  forceLabel: boolean;
};

type NodeDetail = RuntimeNode & {
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

type SelectCallback = (node: NodeDetail, x: number, y: number) => void;
type ClearCallback = () => void;

type PhrenGraphApi = {
  __renderer: string;
  mount: (payload: GraphPayload) => void;
  onNodeSelect: (callback: SelectCallback) => void;
  onSelectionClear: (callback: ClearCallback) => void;
  onRightClick: (callback: (node: NodeDetail, x: number, y: number) => void) => void;
  clearSelection: () => void;
  selectNode: (nodeId: string) => boolean;
  focusNode: (nodeId: string) => boolean;
  getNodeAt: (x: number, y: number) => NodeDetail | null;
  getNodeDetail: (nodeId: string) => NodeDetail | null;
  getData: () => { nodes: NodeDetail[]; links: RawLink[]; topics: RawTopic[]; total: number };
  destroy: () => void;
};

const ROOT = window as unknown as {
  phrenGraph?: PhrenGraphApi;
  graphZoom?: (factor: number) => void;
  graphReset?: () => void;
  graphClearSelection?: () => void;
};

const TOPIC_COLORS: Record<string, string> = {
  architecture: "#00d4ff",
  debugging: "#ff4466",
  security: "#ff6b2b",
  performance: "#ffb020",
  testing: "#00e87b",
  devops: "#00e5d0",
  tooling: "#4d8cff",
  api: "#3b82f6",
  database: "#0ea5e9",
  frontend: "#a855f7",
  auth: "#f97316",
  data: "#06b6d4",
  mobile: "#10b981",
  ai_ml: "#8b5cf6",
  general: "#94a3b8",
};

const KIND_COLORS = {
  project: "#f59e0b",
  entity: "#22d3ee",
  reference: "#34d399",
  "task-active": "#22c55e",
  "task-queue": "#38bdf8",
  "task-done": "#64748b",
  other: "#94a3b8",
};

// Distinct colors per store — up to 6 stores, then cycles
const STORE_COLORS = ["#f59e0b", "#8b5cf6", "#06b6d4", "#ef4444", "#10b981", "#ec4899"];
let _storeColorMap: Map<string, string> | null = null;
function storeColor(storeName?: string): string | null {
  if (!storeName || storeName === "primary") return null; // primary keeps default orange
  if (!_storeColorMap) _storeColorMap = new Map();
  if (_storeColorMap.has(storeName)) return _storeColorMap.get(storeName)!;
  const idx = (_storeColorMap.size + 1) % STORE_COLORS.length;
  _storeColorMap.set(storeName, STORE_COLORS[idx]);
  return STORE_COLORS[idx];
}

function drawCustomLabel(
  context: CanvasRenderingContext2D,
  data: { label: string; x: number; y: number; size: number; color: string },
  settings: { labelSize: number; labelFont: string; labelWeight: string; labelColor: { color: string } },
): void {
  if (!data.label) return;
  const fontSize = settings.labelSize;
  const font = `${settings.labelWeight} ${fontSize}px ${settings.labelFont}`;
  context.font = font;
  const textWidth = context.measureText(data.label).width;
  const padX = 6;
  const padY = 3;
  const pillX = data.x + data.size + 4;
  const pillY = data.y - fontSize / 2 - padY;
  const pillW = textWidth + padX * 2;
  const pillH = fontSize + padY * 2;
  const radius = pillH / 2;

  context.beginPath();
  context.roundRect(pillX, pillY, pillW, pillH, radius);
  context.fillStyle = "rgba(10, 12, 16, 0.72)";
  context.fill();

  context.fillStyle = settings.labelColor.color;
  context.font = font;
  context.fillText(data.label, pillX + padX, data.y + fontSize / 3);
}

function drawCustomHover(
  context: CanvasRenderingContext2D,
  data: { label: string; x: number; y: number; size: number; color: string },
  settings: { labelSize: number; labelFont: string; labelWeight: string; labelColor: { color: string } },
): void {
  const glowRadius = data.size * 3;
  const gradient = context.createRadialGradient(data.x, data.y, data.size * 0.5, data.x, data.y, glowRadius);
  gradient.addColorStop(0, hexToRgba(data.color, 0.4));
  gradient.addColorStop(0.5, hexToRgba(data.color, 0.12));
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  context.beginPath();
  context.arc(data.x, data.y, glowRadius, 0, Math.PI * 2);
  context.fillStyle = gradient;
  context.fill();

  context.beginPath();
  context.arc(data.x, data.y, data.size + 2, 0, Math.PI * 2);
  context.strokeStyle = hexToRgba(data.color, 0.8);
  context.lineWidth = 2;
  context.stroke();

  drawCustomLabel(context, data, settings);
}

const state = {
  payload: null as GraphPayload | null,
  rawNodes: [] as RuntimeNode[],
  rawLinks: [] as RawLink[],
  topics: [] as RawTopic[],
  nodeById: new Map<string, RuntimeNode>(),
  fullAdjacency: new Map<string, Set<string>>(),
  visibleAdjacency: new Map<string, Set<string>>(),
  visibleNodes: [] as RuntimeNode[],
  visibleLinks: [] as RawLink[],
  hostNodes: [] as NodeDetail[],
  graph: null as Graph | null,
  renderer: null as Sigma | null,
  container: null as HTMLElement | null,
  tooltip: null as HTMLElement | null,
  selectedNodeId: null as string | null,
  hoveredNodeId: null as string | null,
  focusedProjectId: null as string | null,
  cameraRatio: 1 as number,
  nodeSelectCallbacks: [] as SelectCallback[],
  selectionClearCallbacks: [] as ClearCallback[],
  rightClickCallbacks: [] as Array<(node: NodeDetail, x: number, y: number) => void>,
  filterTypes: {
    project: true,
    finding: true,
    task: true,
    entity: true,
    reference: true,
  },
  filterTopics: {} as Record<string, boolean>,
  filterHealth: "all",
  filterProject: "all",
  filterStore: "all",
  searchQuery: "",
  nodeLimit: 2000,
  theme: "dark" as "dark" | "light",
  draggedNode: null as string | null,
  isDragging: false,
  neighborPositions: new Map<string, { x: number; y: number }>(),
  mascotRafId: 0,
  mascotCanvas: null as HTMLCanvasElement | null,
  themeObserver: null as MutationObserver | null,
  cleanupFns: [] as Array<() => void>,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function currentTheme(): "dark" | "light" {
  const theme = document.documentElement.getAttribute("data-theme");
  return theme === "light" ? "light" : "dark";
}

function baseBackground(theme: "dark" | "light"): string {
  if (theme === "light") {
    return "radial-gradient(circle at 18% 16%, rgba(212,137,46,0.10), transparent 28%), radial-gradient(circle at 82% 14%, rgba(58,123,174,0.10), transparent 26%), linear-gradient(180deg, #f7f4ed 0%, #f2eee4 52%, #ebe6db 100%)";
  }
  return "radial-gradient(circle at 18% 16%, rgba(212,137,46,0.16), transparent 28%), radial-gradient(circle at 82% 14%, rgba(58,123,174,0.18), transparent 26%), linear-gradient(180deg, #090d10 0%, #0c1013 52%, #12161a 100%)";
}

function hexToRgba(color: string, alpha: number): string {
  if (/^rgba?\(/.test(color)) {
    const numbers = color.match(/[\d.]+/g) || [];
    const r = numbers[0] || "0";
    const g = numbers[1] || "0";
    const b = numbers[2] || "0";
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  const hex = color.replace("#", "");
  const normalized = hex.length === 3
    ? `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
    : hex.padEnd(6, "0").slice(0, 6);
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seeded(value: string, salt: string): number {
  return (hashString(`${salt}:${value}`) % 10000) / 10000;
}

function deriveKind(node: RawNode): RuntimeNode["kind"] {
  if (node.group === "project") return "project";
  if (node.group === "entity") return "entity";
  if (node.group === "reference") return "reference";
  if (node.group.startsWith("task-")) return "task";
  if (node.group.startsWith("topic:")) return "finding";
  return "other";
}

function topicColor(slug?: string): string {
  if (!slug) return KIND_COLORS.other;
  return TOPIC_COLORS[slug] || TOPIC_COLORS.general;
}

function scoreForNode(node: RawNode): ScoreEntry | undefined {
  const scores = state.payload?.scores || {};
  if (node.scoreKey && scores[node.scoreKey]) return scores[node.scoreKey];
  if (node.scoreKeys) {
    for (const key of node.scoreKeys) {
      if (scores[key]) return scores[key];
    }
  }
  if (node.refDocs) {
    for (const ref of node.refDocs) {
      if (ref.scoreKey && scores[ref.scoreKey]) return scores[ref.scoreKey];
    }
  }
  return undefined;
}

function inferHealth(score?: ScoreEntry): RuntimeNode["health"] {
  if (!score || !score.lastUsedAt) return "healthy";

  const ageMs = Date.now() - new Date(score.lastUsedAt).getTime();
  const ageDays = Number.isFinite(ageMs) ? ageMs / 86400000 : 0;
  const penalties = (score.repromptPenalty || 0) + (score.regressionPenalty || 0) * 2;

  if (ageDays > 150 || penalties >= 4) return "stale";
  if (ageDays > 60 || penalties >= 2) return "decaying";
  return "healthy";
}

function qualityScore(node: RawNode): number | null {
  const score = scoreForNode(node);
  if (!score) return null;
  const helpful = score.helpful || 0;
  const impressions = score.impressions || 0;
  const penalties = (score.repromptPenalty || 0) + (score.regressionPenalty || 0) * 2;
  const raw = 0.55 + helpful * 0.1 + Math.min(0.2, impressions * 0.02) - penalties * 0.08;
  return clamp(raw, 0.1, 1);
}

function baseColorForNode(node: RawNode): string {
  const kind = deriveKind(node);
  if (kind === "finding") return topicColor(node.topicSlug || node.group.slice(6));
  if (kind === "task") {
    if (node.section === "Done" || node.group === "task-done") return KIND_COLORS["task-done"];
    if (node.section === "Active" || node.group === "task-active") return KIND_COLORS["task-active"];
    return KIND_COLORS["task-queue"];
  }
  if (kind === "project") return storeColor(node.store) || KIND_COLORS.project;
  if (kind === "entity") return KIND_COLORS.entity;
  if (kind === "reference") return KIND_COLORS.reference;
  return KIND_COLORS.other;
}

function sizeForNode(node: RawNode): number {
  const kind = deriveKind(node);
  const refCount = Math.max(0, node.refCount || 0);
  const score = scoreForNode(node);
  const helpful = Math.max(0, score?.helpful || 0);

  if (kind === "project") return clamp(20 + Math.sqrt(refCount + 4) * 4, 24, 38);
  if (kind === "entity") return clamp(8 + Math.sqrt(refCount + 1) * 2.3, 10, 22);
  if (kind === "finding") return clamp(7.5 + Math.sqrt(helpful + 1) * 1.8 + (node.tagged ? 1.4 : 0), 9, 18);
  if (kind === "task") return clamp(8 + (node.section === "Active" ? 2 : 0) + (node.priority === "high" ? 1 : 0), 8, 15);
  if (kind === "reference") return clamp(7 + Math.sqrt(refCount + 1) * 1.2, 7, 12);
  return 9;
}

function searchTextForNode(node: RawNode): string {
  return [
    node.label,
    node.fullLabel,
    node.project,
    node.entityType,
    node.section,
    node.priority,
    node.topicSlug,
    node.topicLabel,
    ...(node.connectedProjects || []),
    ...(node.refDocs || []).map((ref) => ref.doc),
  ].join(" ").toLowerCase();
}

function normalizeNode(node: RawNode): RuntimeNode {
  const score = scoreForNode(node);
  return {
    ...node,
    kind: deriveKind(node),
    searchText: searchTextForNode(node),
    health: inferHealth(score),
    baseColor: baseColorForNode(node),
    size: sizeForNode(node),
    forceLabel: deriveKind(node) === "project" || (deriveKind(node) === "entity" && (node.refCount || 0) >= 12),
  };
}

function ensureTopicFilters(): void {
  const next: Record<string, boolean> = {};
  for (const topic of state.topics) next[topic.slug] = state.filterTopics[topic.slug] !== false;
  state.filterTopics = next;
}

function buildFullAdjacency(): void {
  state.fullAdjacency = new Map();
  for (const node of state.rawNodes) {
    state.fullAdjacency.set(node.id, new Set());
  }
  for (const link of state.rawLinks) {
    if (!state.fullAdjacency.has(link.source) || !state.fullAdjacency.has(link.target)) continue;
    state.fullAdjacency.get(link.source)!.add(link.target);
    state.fullAdjacency.get(link.target)!.add(link.source);
  }
}

function connectionCounts(nodeId: string): NodeDetail["connections"] {
  const counts = {
    total: 0,
    projects: 0,
    findings: 0,
    tasks: 0,
    entities: 0,
    references: 0,
  };

  const adjacency = state.fullAdjacency.get(nodeId);
  if (!adjacency) return counts;

  counts.total = adjacency.size;
  adjacency.forEach((neighborId) => {
    const neighbor = state.nodeById.get(neighborId);
    if (!neighbor) return;
    if (neighbor.kind === "project") counts.projects++;
    else if (neighbor.kind === "finding") counts.findings++;
    else if (neighbor.kind === "task") counts.tasks++;
    else if (neighbor.kind === "entity") counts.entities++;
    else if (neighbor.kind === "reference") counts.references++;
  });
  return counts;
}

/** Check if a node is in a project's direct network (1-hop neighbors). */
function isInProjectNetwork(nodeId: string, projectId: string): boolean {
  if (nodeId === projectId) return true;
  const neighbors = state.visibleAdjacency.get(projectId);
  if (neighbors?.has(nodeId)) return true;
  // Also include nodes that share an edge with any direct neighbor (cross-project links)
  const nodeNeighbors = state.visibleAdjacency.get(nodeId);
  if (nodeNeighbors) {
    for (const nn of nodeNeighbors) {
      if (neighbors?.has(nn)) return true;
    }
  }
  return false;
}

function nodeDetail(nodeId: string): NodeDetail | null {
  const node = state.nodeById.get(nodeId);
  if (!node) return null;
  return {
    ...node,
    displayLabel: node.label,
    tooltipLabel: node.fullLabel || node.label,
    text: node.fullLabel || node.label,
    docs: (node.refDocs || []).map((ref) => ref.doc),
    projectName: node.project || "",
    qualityScore: qualityScore(node),
    connections: connectionCounts(nodeId),
    score: scoreForNode(node),
  };
}

function nodeMatchesFilters(node: RuntimeNode): boolean {
  if (!state.filterTypes[node.kind]) return false;
  if (node.kind === "finding" && node.topicSlug && state.filterTopics[node.topicSlug] === false) return false;
  if (state.filterHealth !== "all" && node.health !== state.filterHealth) return false;

  if (state.filterStore !== "all" && node.store && node.store !== state.filterStore) return false;

  if (state.filterProject !== "all") {
    const project = state.filterProject;
    const connectedProjects = new Set<string>();
    if (node.project) connectedProjects.add(node.project);
    (node.connectedProjects || []).forEach((name) => connectedProjects.add(name));
    (node.refDocs || []).forEach((ref) => {
      if (ref.project) connectedProjects.add(ref.project);
      else if (ref.doc.includes("/")) connectedProjects.add(ref.doc.slice(0, ref.doc.indexOf("/")));
    });
    if (node.kind === "project") {
      if (node.id !== project) return false;
    } else if (!connectedProjects.has(project)) {
      return false;
    }
  }

  if (state.searchQuery) {
    const query = state.searchQuery.toLowerCase();
    if (!node.searchText.includes(query)) return false;
  }

  return true;
}

function nodeRank(node: RuntimeNode): number {
  let rank = 0;
  if (node.kind === "project") rank += 2000;
  if (node.kind === "entity") rank += 800 + (node.refCount || 0) * 8;
  if (node.kind === "finding") rank += 600 + (scoreForNode(node)?.helpful || 0) * 14 + (node.tagged ? 45 : 0);
  if (node.kind === "task") rank += node.section === "Active" ? 540 : 470;
  if (node.kind === "reference") rank += 180 + (node.refCount || 0) * 3;
  if (node.priority === "high") rank += 60;
  if (node.health === "healthy") rank += 24;
  if (node.health === "decaying") rank -= 12;
  if (node.health === "stale") rank -= 25;
  if (state.filterProject !== "all" && node.project === state.filterProject) rank += 80;
  if (state.filterStore !== "all" && node.store === state.filterStore) rank += 40;
  if (state.searchQuery && node.searchText.includes(state.searchQuery.toLowerCase())) rank += 120;
  return rank;
}

function buildVisibleData(): { nodes: RuntimeNode[]; links: RawLink[] } {
  const filteredNodes = state.rawNodes.filter(nodeMatchesFilters);

  const selectedId = state.selectedNodeId;
  let limitedNodes = filteredNodes.slice();
  if (limitedNodes.length > state.nodeLimit) {
    const sorted = limitedNodes
      .slice()
      .sort((a, b) => nodeRank(b) - nodeRank(a));
    const keepIds = new Set<string>();
    for (const node of sorted) {
      if (keepIds.size >= state.nodeLimit) break;
      keepIds.add(node.id);
    }
    state.rawNodes.forEach((node) => {
      if (node.kind === "project") keepIds.add(node.id);
    });
    if (selectedId) keepIds.add(selectedId);
    limitedNodes = filteredNodes.filter((node) => keepIds.has(node.id));
  }

  const visibleIds = new Set(limitedNodes.map((node) => node.id));
  const visibleLinks = state.rawLinks.filter((link) => visibleIds.has(link.source) && visibleIds.has(link.target));

  state.visibleAdjacency = new Map();
  limitedNodes.forEach((node) => state.visibleAdjacency.set(node.id, new Set()));
  visibleLinks.forEach((link) => {
    state.visibleAdjacency.get(link.source)!.add(link.target);
    state.visibleAdjacency.get(link.target)!.add(link.source);
  });

  const connectedIds = new Set<string>();
  visibleLinks.forEach((link) => {
    connectedIds.add(link.source);
    connectedIds.add(link.target);
  });
  // Keep nodes if: not a project, OR has visible connections, OR is the selected project, OR project type is filtered but has no connections
  const prunedNodes = limitedNodes.filter((node) =>
    node.kind !== "project" || connectedIds.has(node.id) || node.id === state.filterProject || state.filterTypes.project
  );
  return { nodes: prunedNodes, links: visibleLinks };
}

function rebuildHostNodes(): void {
  state.hostNodes = state.visibleNodes
    .map((node) => nodeDetail(node.id))
    .filter((node): node is NodeDetail => Boolean(node));
}

function projectAnchors(nodes: RuntimeNode[]): Map<string, { x: number; y: number }> {
  const projects = nodes.filter((node) => node.kind === "project");
  const anchors = new Map<string, { x: number; y: number }>();

  // Shuffle projects using deterministic seeded hash so layout is stable
  const shuffled = [...projects].sort(
    (a, b) => seeded(a.id, "shuffle") - seeded(b.id, "shuffle"),
  );

  const totalNodes = nodes.length;
  const cols = Math.max(1, Math.ceil(Math.sqrt(shuffled.length)));
  const rows = Math.max(1, Math.ceil(shuffled.length / cols));
  // Scale cell size based on total node count for appropriate density
  const cellSize = Math.max(180, Math.sqrt(totalNodes) * 28);

  shuffled.forEach((node, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    // Center the grid around origin
    const baseX = (col - (cols - 1) / 2) * cellSize;
    const baseY = (row - (rows - 1) / 2) * cellSize;
    // Add ±30% jitter so it doesn't look like a perfect grid
    const jitterX = (seeded(node.id, "jitterX") - 0.5) * cellSize * 0.6;
    const jitterY = (seeded(node.id, "jitterY") - 0.5) * cellSize * 0.6;
    anchors.set(node.id, { x: baseX + jitterX, y: baseY + jitterY });
  });

  return anchors;
}

function linkedProjects(node: RuntimeNode): string[] {
  const projects = new Set<string>();
  if (node.project) projects.add(node.project);
  (node.connectedProjects || []).forEach((project) => projects.add(project));
  const neighbors = state.fullAdjacency.get(node.id);
  neighbors?.forEach((neighborId) => {
    const neighbor = state.nodeById.get(neighborId);
    if (neighbor?.kind === "project") projects.add(neighbor.id);
  });
  return [...projects];
}

function seedNodeCoordinates(nodes: RuntimeNode[]): Map<string, { x: number; y: number }> {
  const anchors = projectAnchors(nodes);
  const positions = new Map<string, { x: number; y: number }>();

  nodes.forEach((node, index) => {
    if (node.kind === "project") {
      positions.set(node.id, anchors.get(node.id) || { x: index * 20, y: 0 });
      return;
    }

    const projectIds = linkedProjects(node);
    let anchor = { x: 0, y: 0 };
    if (projectIds.length) {
      projectIds.forEach((projectId) => {
        const projectAnchor = anchors.get(projectId) || { x: 0, y: 0 };
        anchor.x += projectAnchor.x;
        anchor.y += projectAnchor.y;
      });
      anchor.x /= projectIds.length;
      anchor.y /= projectIds.length;
    }

    const kindRadius = node.kind === "finding"
      ? 60
      : node.kind === "task"
        ? 80
        : node.kind === "entity"
          ? 190
          : 50;
    const radius = kindRadius + seeded(node.id, "radius") * 120 + (node.refCount || 0) * 1.2;
    const angle = seeded(node.id, "angle") * Math.PI * 2;

    positions.set(node.id, {
      x: anchor.x + Math.cos(angle) * radius + (seeded(node.id, "jx") - 0.5) * 28,
      y: anchor.y + Math.sin(angle) * radius + (seeded(node.id, "jy") - 0.5) * 28,
    });
  });

  return positions;
}

function normalizeGraphPositions(graph: Graph): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  graph.forEachNode((nodeId, attributes: { x: number; y: number }) => {
    minX = Math.min(minX, attributes.x);
    minY = Math.min(minY, attributes.y);
    maxX = Math.max(maxX, attributes.x);
    maxY = Math.max(maxY, attributes.y);
  });

  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const centerX = minX + spanX / 2;
  const centerY = minY + spanY / 2;
  const scale = 2.8 / Math.max(spanX, spanY);

  graph.forEachNode((nodeId, attributes: { x: number; y: number }) => {
    graph.mergeNodeAttributes(nodeId, {
      x: (attributes.x - centerX) * scale,
      y: (attributes.y - centerY) * scale,
    });
  });
}

function buildGraph(nodes: RuntimeNode[], links: RawLink[]): Graph {
  const graph = new Graph();
  const positions = seedNodeCoordinates(nodes);

  nodes.forEach((node, index) => {
    if (graph.hasNode(node.id)) return; // guard against duplicate IDs across stores
    const position = positions.get(node.id) || { x: index * 0.01, y: index * 0.01 };
    graph.addNode(node.id, {
      x: position.x,
      y: position.y,
      size: node.size,
      label: node.label,
      color: node.baseColor,
      forceLabel: node.forceLabel,
      highlighted: false,
      hidden: false,
      zIndex: node.kind === "project" ? 10 : node.kind === "entity" ? 6 : 3,
      type: "circle",
      raw: node,
    });
  });

  links.forEach((link, index) => {
    if (!graph.hasNode(link.source) || !graph.hasNode(link.target)) return;
    const source = state.nodeById.get(link.source);
    const target = state.nodeById.get(link.target);
    if (!source || !target) return;
    const weight = source.kind === "project" || target.kind === "project"
      ? 2.2
      : source.kind === "entity" || target.kind === "entity"
        ? 1.5
        : 1.1;
    graph.addEdgeWithKey(`edge:${index}:${link.source}:${link.target}`, link.source, link.target, {
      label: null,
      size: weight,
      weight,
      color: hexToRgba(currentTheme() === "dark" ? "#8ca0b6" : "#64748b", currentTheme() === "dark" ? 0.25 : 0.18),
      zIndex: 1,
    });
  });

  // Add weak inter-project edges for entities shared across projects
  const projectPairsSeen = new Set<string>();
  nodes.forEach((node) => {
    if (node.kind !== "entity") return;
    const projects = linkedProjects(node).filter((p) => graph.hasNode(p));
    for (let i = 0; i < projects.length; i++) {
      for (let j = i + 1; j < projects.length; j++) {
        const key = [projects[i], projects[j]].sort().join("|");
        if (projectPairsSeen.has(key)) continue;
        projectPairsSeen.add(key);
        if (!graph.hasEdge(projects[i], projects[j]) && !graph.hasEdge(projects[j], projects[i])) {
          graph.addEdgeWithKey(`shared:${key}`, projects[i], projects[j], {
            label: null,
            size: 0.3,
            weight: 0.3,
            color: hexToRgba(currentTheme() === "dark" ? "#8ca0b6" : "#64748b", currentTheme() === "dark" ? 0.08 : 0.05),
            zIndex: 0,
          });
        }
      }
    }
  });

  if (graph.order > 1) {
    const settings = forceAtlas2.inferSettings(graph);
    forceAtlas2.assign(graph, {
      iterations: graph.order < 80 ? 200 : graph.order < 240 ? 160 : 130,
      settings: {
        ...settings,
        linLogMode: true,
        adjustSizes: true,
        gravity: 0.3,
        scalingRatio: Math.max(4, settings.scalingRatio || 0, 7.5),
        slowDown: graph.order > 240 ? 8 : 5,
        barnesHutOptimize: graph.order > 120,
      },
    });
  }

  normalizeGraphPositions(graph);
  return graph;
}

function positionForNode(nodeId: string): { x: number; y: number } | null {
  if (!state.renderer || !state.graph?.hasNode(nodeId)) return null;
  const attrs = state.graph.getNodeAttributes(nodeId);
  if (attrs.x == null || attrs.y == null) return null;
  return state.renderer.graphToViewport({ x: attrs.x as number, y: attrs.y as number });
}

function hideTooltip(): void {
  if (!state.tooltip) return;
  state.tooltip.style.opacity = "0";
  state.tooltip.innerHTML = "";
}

function showTooltip(nodeId: string, event: { x: number; y: number }): void {
  if (!state.tooltip) return;

  const node = state.nodeById.get(nodeId);
  if (!node) return;

  let preview = "";

  if (node.kind === "finding") {
    // Show first 100 chars of the finding + date
    const text = node.fullLabel || node.label || "";
    const truncated = text.length > 100 ? text.slice(0, 97) + "..." : text;
    preview = truncated;
    const score = scoreForNode(node);
    const rawDate = node.date && node.date !== "unknown" ? node.date : "";
    const dateStr = rawDate || score?.lastUsedAt || "";
    if (dateStr) {
      try {
        const d = new Date(dateStr);
        if (!isNaN(d.getTime())) {
          const days = Math.floor((Date.now() - d.getTime()) / 86400000);
          const rel = days < 1 ? "today" : days === 1 ? "yesterday" : days < 30 ? `${days}d ago` : days < 365 ? `${Math.floor(days / 30)}mo ago` : `${Math.floor(days / 365)}y ago`;
          preview += `\n${node.date ? rel : "seen " + rel}`;
        }
      } catch { /* skip */ }
    }
  } else if (node.kind === "task") {
    // Show task line + section + priority
    const line = node.fullLabel || node.label || "";
    const section = node.section ? `[${node.section}]` : "";
    const priority = node.priority ? `${node.priority}◆` : "";
    preview = `${line}\n${[section, priority].filter(Boolean).join(" ")}`;
  } else if (node.kind === "entity") {
    // Show type + ref count + connected projects
    const refCount = node.refCount || 0;
    const projects = node.connectedProjects?.length || 0;
    preview = `${node.label}\n${refCount} refs • ${projects} projects`;
  } else if (node.kind === "project") {
    // Show finding count + task count
    const findingCount = node.findingCount || 0;
    const taskCount = node.taskCount || 0;
    preview = `${node.label}\n${findingCount} findings • ${taskCount} tasks`;
  } else {
    // Default: just show the label
    preview = node.label || node.id;
  }

  if (preview) {
    state.tooltip.textContent = preview;
    state.tooltip.style.left = event.x + 12 + "px";
    state.tooltip.style.top = event.y + 12 + "px";
    state.tooltip.style.opacity = "1";
  }
}

function notifySelection(nodeId: string): void {
  const detail = nodeDetail(nodeId);
  const position = positionForNode(nodeId);
  if (!detail || !position) return;
  state.nodeSelectCallbacks.forEach((callback) => callback(detail, position.x, position.y));
}

function notifyClear(): void {
  state.selectionClearCallbacks.forEach((callback) => callback());
}

function refreshRenderer(resetCamera: boolean): void {
  if (!state.container) return;

  state.theme = currentTheme();
  state.container.style.background = baseBackground(state.theme);
  state.container.style.position = "relative";

  if (!state.renderer) {
    if (!state.graph) return;
    state.renderer = new Sigma(state.graph, state.container, {
      allowInvalidContainer: true,
      hideEdgesOnMove: false,
      hideLabelsOnMove: false,
      labelFont: "Inter, system-ui, sans-serif",
      labelSize: 13,
      labelWeight: "500",
      labelColor: { color: state.theme === "dark" ? "#f3eadd" : "#1e1c18" },
      labelDensity: 0.7,
      labelRenderedSizeThreshold: 12,
      labelGridCellSize: 200,
      defaultDrawNodeLabel: drawCustomLabel as unknown as Sigma["settings"]["defaultDrawNodeLabel"],
      defaultDrawNodeHover: drawCustomHover as unknown as Sigma["settings"]["defaultDrawNodeHover"],
      minCameraRatio: 0.06,
      maxCameraRatio: 4,
      zIndex: true,
      nodeReducer(nodeId, data) {
        const next: Record<string, unknown> = { ...data };
        const node = state.nodeById.get(nodeId);
        const kind = node?.kind ?? "finding";
        const ratio = state.cameraRatio;

        // Semantic zoom: fade nodes based on zoom level
        // Skip semantic zoom if user has actively filtered types (explicit choice overrides zoom)
        const allTypesOn = state.filterTypes.project && state.filterTypes.finding && state.filterTypes.task && state.filterTypes.entity && state.filterTypes.reference;
        if (allTypesOn && !state.focusedProjectId && !state.hoveredNodeId && !state.selectedNodeId) {
          if (ratio > 0.65 && kind !== "project") {
            const fade = kind === "finding" || kind === "task" ? 0.12 : 0.04;
            next.color = hexToRgba(String(data.color), fade);
            next.label = null;
            next.zIndex = 1;
            return next;
          }
          if (ratio > 0.35 && (kind === "entity" || kind === "reference")) {
            next.color = hexToRgba(String(data.color), state.theme === "dark" ? 0.10 : 0.12);
            next.label = null;
            next.zIndex = 1;
            return next;
          }
        }

        // Entities/fragments always render smaller (ambient, not dominant)
        if (kind === "entity") {
          next.size = Math.min(data.size, 5);
        }

        // Focus mode: project is focused — fade everything outside its network
        if (state.focusedProjectId) {
          if (nodeId === state.focusedProjectId) {
            next.highlighted = true;
            next.forceLabel = true;
            next.zIndex = 20;
          } else if (isInProjectNetwork(nodeId, state.focusedProjectId)) {
            next.zIndex = 10;
            next.forceLabel = data.size >= 10;
          } else {
            next.color = hexToRgba(String(data.color), state.theme === "dark" ? 0.08 : 0.10);
            next.label = null;
            next.zIndex = 1;
          }
          return next;
        }

        // Normal selection/hover
        const focus = state.hoveredNodeId || state.selectedNodeId;
        if (nodeId === state.selectedNodeId) {
          next.size = Math.max(data.size * 1.18, data.size + 2);
          next.highlighted = true;
          next.forceLabel = true;
          next.zIndex = 20;
        } else if (nodeId === state.hoveredNodeId) {
          next.size = data.size * 1.08;
          next.forceLabel = true;
          next.zIndex = 16;
        } else if (focus) {
          const neighbors = state.visibleAdjacency.get(focus);
          if (neighbors?.has(nodeId)) {
            const focusNode = state.nodeById.get(focus);
            next.zIndex = 10;
            next.forceLabel = focusNode?.kind === "project" || data.size >= 12;
          } else {
            next.color = hexToRgba(String(data.color), state.theme === "dark" ? 0.22 : 0.25);
            next.label = null;
          }
        }
        return next;
      },
      edgeReducer(edgeId, data) {
        const next: Record<string, unknown> = { ...data };
        const ratio = state.cameraRatio;

        // Semantic zoom for edges: at high zoom levels, only show project-to-project edges
        if (!state.focusedProjectId && !state.hoveredNodeId && !state.selectedNodeId && ratio > 0.65) {
          const extremities = state.graph?.extremities(edgeId);
          if (extremities) {
            const srcKind = state.nodeById.get(extremities[0])?.kind;
            const tgtKind = state.nodeById.get(extremities[1])?.kind;
            if (srcKind !== "project" || tgtKind !== "project") {
              next.color = hexToRgba("#888", 0.02);
              next.size = 0.3;
              return next;
            }
          }
        }

        // Focus mode: only edges within the focused project's network stay visible
        if (state.focusedProjectId) {
          const extremities = state.graph?.extremities(edgeId);
          if (!extremities) return next;
          const srcIn = isInProjectNetwork(extremities[0], state.focusedProjectId);
          const tgtIn = isInProjectNetwork(extremities[1], state.focusedProjectId);
          if (srcIn && tgtIn) {
            next.color = hexToRgba(String(data.color || "#888"), state.theme === "dark" ? 0.6 : 0.5);
            next.size = Math.max(1.5, data.size);
          } else {
            next.color = hexToRgba("#888", state.theme === "dark" ? 0.03 : 0.04);
            next.size = 0.5;
          }
          return next;
        }

        // Distance-based edge fading — long stretched edges fade out
        const extremitiesForDist = state.graph?.extremities(edgeId);
        if (extremitiesForDist && state.graph) {
          const srcA = state.graph.getNodeAttributes(extremitiesForDist[0]);
          const tgtA = state.graph.getNodeAttributes(extremitiesForDist[1]);
          const dx = srcA.x - tgtA.x;
          const dy = srcA.y - tgtA.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > 300) {
            const fade = Math.max(0.03, 1 - (dist - 300) / 400);
            next.color = hexToRgba(String(data.color || "#888"), fade * 0.3);
            next.size = Math.max(0.3, (data.size || 1) * fade);
          }
        }

        // Normal selection/hover
        const focus = state.hoveredNodeId || state.selectedNodeId;
        if (!focus) return next;
        const extremities = state.graph?.extremities(edgeId);
        const isFocused = extremities ? extremities[0] === focus || extremities[1] === focus : false;
        if (isFocused) {
          next.color = hexToRgba("#ffd966", state.theme === "dark" ? 0.82 : 0.7);
          next.size = Math.max(2.4, data.size * 1.35);
          next.zIndex = 8;
        } else {
          next.color = hexToRgba(state.theme === "dark" ? "#94a3b8" : "#64748b", state.theme === "dark" ? 0.06 : 0.05);
        }
        return next;
      },
    });

    state.renderer.on("enterNode", (payload) => {
      state.hoveredNodeId = payload.node;
      showTooltip(payload.node, payload.event);
      state.renderer?.refresh();
    });

    state.renderer.on("leaveNode", () => {
      state.hoveredNodeId = null;
      hideTooltip();
      state.renderer?.refresh();
    });

    state.renderer.on("clickNode", (payload) => {
      payload.preventSigmaDefault();
      if (state.isDragging) return;
      state.selectedNodeId = payload.node;
      state.hoveredNodeId = payload.node;
      hideTooltip();
      state.renderer?.refresh();
      const detail = nodeDetail(payload.node);
      let animating = false;
      if (detail && detail.kind !== "project" && state.renderer) {
        const graphPosition = state.renderer.getNodeDisplayData(payload.node);
        if (graphPosition) {
          animating = true;
          state.renderer.getCamera().animate({
            x: graphPosition.x,
            y: graphPosition.y,
            ratio: Math.max(state.renderer.getCamera().ratio * 0.85, 0.16),
          }, { duration: 220 });
        }
      }
      // Delay notification until after camera animation so popover lands next to the node
      if (animating) {
        setTimeout(() => notifySelection(payload.node), 240);
      } else {
        notifySelection(payload.node);
      }
      // Send phren mascot to the clicked node
      if (mascot.initialized && payload.node !== mascot.currentNodeId) {
        mascotMoveTo(payload.node);
      }
    });

    state.renderer.on("rightClickNode", (payload) => {
      payload.preventSigmaDefault();
      (payload.event.original as Event).preventDefault();
      const detail = nodeDetail(payload.node);
      if (!detail) return;
      state.rightClickCallbacks.forEach((cb) => cb(detail, payload.event.x, payload.event.y));
    });

    state.renderer.on("clickStage", () => {
      if (!state.selectedNodeId && !state.focusedProjectId) return;
      clearSelection();
    });

    const onKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!state.selectedNodeId && !state.focusedProjectId) return;
      clearSelection();
    };

    // Track camera ratio for semantic zoom
    state.renderer.getCamera().on("updated", () => {
      const ratio = state.renderer?.getCamera().ratio ?? 1;
      if (Math.abs(ratio - state.cameraRatio) > 0.02) {
        state.cameraRatio = ratio;
        state.renderer?.refresh();
      }
    });
    document.addEventListener("keydown", onKeydown);
    state.cleanupFns.push(() => document.removeEventListener("keydown", onKeydown));

    // --- Node dragging ---
    state.renderer.on("downNode", (payload) => {
      state.draggedNode = payload.node;
      state.isDragging = false;
      state.renderer?.setSettings({ enableCameraPanning: false });
      if (state.container) state.container.style.cursor = "grabbing";
      // Capture relative positions of all neighbors (offsets from project center)
      state.neighborPositions.clear();
      if (state.graph) {
        const projAttrs = state.graph.getNodeAttributes(payload.node);
        state.neighborPositions.set(payload.node, { x: projAttrs.x, y: projAttrs.y });
        const neighbors = state.visibleAdjacency.get(payload.node);
        if (neighbors) {
          neighbors.forEach((neighborId) => {
            const n = state.nodeById.get(neighborId);
            if (!n || n.kind === "project") return;
            try {
              const nAttrs = state.graph!.getNodeAttributes(neighborId);
              // Store offset FROM project, not absolute position
              state.neighborPositions.set(neighborId, { x: nAttrs.x - projAttrs.x, y: nAttrs.y - projAttrs.y });
            } catch { /* skip */ }
          });
        }
      }
    });

    state.renderer.on("enterNode", () => {
      if (!state.draggedNode && state.container) state.container.style.cursor = "grab";
    });

    state.renderer.on("leaveNode", () => {
      if (!state.draggedNode && state.container) state.container.style.cursor = "default";
    });

    const onMouseMove = (event: MouseEvent) => {
      if (!state.draggedNode || !state.renderer || !state.graph) return;
      state.isDragging = true;
      const graphCoords = state.renderer.viewportToGraph({ x: event.offsetX, y: event.offsetY });
      state.graph.mergeNodeAttributes(state.draggedNode, { x: graphCoords.x, y: graphCoords.y });
      // Gentle gravitational pull — neighbors drift toward the project during drag
      const curPos = state.graph.getNodeAttributes(state.draggedNode);
      state.neighborPositions.forEach((offset, neighborId) => {
        if (neighborId === state.draggedNode) return;
        try {
          const nAttrs = state.graph!.getNodeAttributes(neighborId);
          // Target: orbital position around new project location
          const targetX = curPos.x + offset.x;
          const targetY = curPos.y + offset.y;
          // Ease toward target (gravitational drift, not rigid lock)
          state.graph!.setNodeAttribute(neighborId, "x", nAttrs.x + (targetX - nAttrs.x) * 0.08);
          state.graph!.setNodeAttribute(neighborId, "y", nAttrs.y + (targetY - nAttrs.y) * 0.08);
        } catch { /* skip */ }
      });
    };
    const endDrag = () => {
      if (state.draggedNode) {
        state.renderer?.setSettings({ enableCameraPanning: true });
        if (state.container) state.container.style.cursor = "default";

        // Continue gravitational drift — animate neighbors to orbital positions around new location
        const projPos = state.graph?.getNodeAttributes(state.draggedNode);
        if (projPos && state.graph) {
          const positions = new Map(state.neighborPositions);
          positions.delete(state.draggedNode);
          let frame = 0;
          const maxFrames = 30;
          const drift = () => {
            if (frame >= maxFrames || !state.graph) return;
            frame++;
            let settled = true;
            positions.forEach((offset, neighborId) => {
              try {
                const cur = state.graph!.getNodeAttributes(neighborId);
                const targetX = projPos.x + offset.x;
                const targetY = projPos.y + offset.y;
                const dx = targetX - cur.x;
                const dy = targetY - cur.y;
                if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) settled = false;
                state.graph!.setNodeAttribute(neighborId, "x", cur.x + dx * 0.15);
                state.graph!.setNodeAttribute(neighborId, "y", cur.y + dy * 0.15);
              } catch { /* skip */ }
            });
            if (!settled) requestAnimationFrame(drift);
          };
          requestAnimationFrame(drift);
        }

        state.draggedNode = null;
        state.neighborPositions.clear();
        setTimeout(() => { state.isDragging = false; }, 0);
      }
    };
    state.container.addEventListener("mousemove", onMouseMove);
    state.container.addEventListener("mouseup", endDrag);
    state.container.addEventListener("mouseleave", endDrag);
    state.cleanupFns.push(() => {
      state.container?.removeEventListener("mousemove", onMouseMove);
      state.container?.removeEventListener("mouseup", endDrag);
      state.container?.removeEventListener("mouseleave", endDrag);
    });

    // --- CSS glow filter on sigma WebGL canvas ---
    const sigmaCanvases = state.container.querySelectorAll<HTMLCanvasElement>("canvas");
    sigmaCanvases.forEach((canvas) => {
      canvas.style.filter = "brightness(1.08) saturate(1.15)";
    });

    const observer = new MutationObserver(() => {
      const nextTheme = currentTheme();
      if (nextTheme === state.theme) return;
      state.theme = nextTheme;
      applyFilters({ resetCamera: false, emitSelection: Boolean(state.selectedNodeId) });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    state.themeObserver = observer;
  } else if (state.graph) {
    state.renderer.setGraph(state.graph);
    state.renderer.setSettings({
      labelColor: { color: state.theme === "dark" ? "#f3eadd" : "#1e1c18" },
    });
    state.renderer.refresh();
  }

  if (state.renderer && resetCamera) {
    setTimeout(() => {
      state.renderer?.getCamera().animatedReset({ duration: 220 });
    }, 0);
  }
}

function buildFilterBar(): void {
  const filterEl = document.getElementById("graph-filter");
  const projectFilterEl = document.getElementById("graph-project-filter");
  const limitRow = document.getElementById("graph-limit-row");
  if (!filterEl) return;

  const projectNames = state.rawNodes
    .filter((node) => node.kind === "project")
    .map((node) => node.id)
    .sort((a, b) => a.localeCompare(b));

  const storeNames = Array.from(new Set(
    state.rawNodes
      .map((node) => node.store)
      .filter((store): store is string => Boolean(store))
  )).sort((a, b) => a.localeCompare(b));

  const typeDefs = [
    { key: "project", label: "Projects", color: KIND_COLORS.project },
    { key: "finding", label: "Findings", color: TOPIC_COLORS.general },
    { key: "task", label: "Tasks", color: KIND_COLORS["task-active"] },
    { key: "entity", label: "Fragments", color: KIND_COLORS.entity },
    { key: "reference", label: "Refs", color: KIND_COLORS.reference },
  ];

  const typeSection = typeDefs.map((typeDef) => (
    `<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--ink);cursor:pointer">
      <input type="checkbox" data-filter-type-check="${typeDef.key}"${state.filterTypes[typeDef.key as keyof typeof state.filterTypes] ? " checked" : ""} />
      <span style="display:inline-block;width:9px;height:9px;border-radius:999px;background:${typeDef.color}"></span>
      <span>${esc(typeDef.label)}</span>
    </label>`
  )).join("");

  const topicSection = state.topics.map((topic) => (
    `<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--ink);cursor:pointer">
      <input type="checkbox" data-filter-topic-check="${esc(topic.slug)}"${state.filterTopics[topic.slug] !== false ? " checked" : ""} />
      <span style="display:inline-block;width:9px;height:9px;border-radius:999px;background:${topicColor(topic.slug)}"></span>
      <span>${esc(topic.label)}</span>
    </label>`
  )).join("");

  const healthSection = [
    { key: "all", label: "All" },
    { key: "healthy", label: "Healthy" },
    { key: "decaying", label: "Decaying" },
    { key: "stale", label: "Stale" },
  ].map((entry) => (
    `<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--ink);cursor:pointer">
      <input type="radio" name="graph-health-filter" value="${entry.key}"${state.filterHealth === entry.key ? " checked" : ""} />
      <span>${entry.label}</span>
    </label>`
  )).join("");

  filterEl.innerHTML = [
    '<div style="display:flex;align-items:center;gap:10px;flex-wrap:nowrap;width:100%">',
    `<input type="text" data-search-filter placeholder="Search nodes..." value="${esc(state.searchQuery)}" style="flex:1 1 auto;min-width:180px;padding:8px 12px;border-radius:10px;background:var(--surface);color:var(--ink);border:1px solid var(--border);font-size:12px" />`,
    '<div data-filter-menu style="position:relative;flex:0 0 auto">',
    '<button data-filter-toggle style="cursor:pointer;padding:8px 12px;border-radius:10px;border:1px solid var(--border);background:var(--surface);font-size:12px;font-weight:650;color:var(--ink);user-select:none">Filters</button>',
    '<div data-filter-panel style="display:none;position:absolute;right:0;top:calc(100% + 8px);z-index:30;min-width:320px;max-height:420px;overflow:auto;padding:12px;border:1px solid var(--border);border-radius:12px;background:var(--surface-raised,var(--surface));box-shadow:var(--shadow-lg)">',
    '<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px">Project</div>',
    `<select data-project-filter style="width:100%;padding:7px 9px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--ink);font-size:12px;margin-bottom:12px">
      <option value="all"${state.filterProject === "all" ? " selected" : ""}>All projects</option>
      ${projectNames.map((project) => `<option value="${esc(project)}"${state.filterProject === project ? " selected" : ""}>${esc(project)}</option>`).join("")}
    </select>`,
    storeNames.length > 1 ? '<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;margin:8px 0 6px">Store</div>' : "",
    storeNames.length > 1 ? `<select data-store-filter style="width:100%;padding:7px 9px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--ink);font-size:12px;margin-bottom:12px">
      <option value="all"${state.filterStore === "all" ? " selected" : ""}>All stores</option>
      ${storeNames.map((store) => `<option value="${esc(store)}"${state.filterStore === store ? " selected" : ""}>${esc(store)}</option>`).join("")}
    </select>` : "",
    '<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;margin:8px 0 6px">Type</div>',
    `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 10px;margin-bottom:12px">${typeSection}</div>`,
    topicSection ? '<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;margin:8px 0 6px">Topics</div>' : "",
    topicSection ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 10px;margin-bottom:12px">${topicSection}</div>` : "",
    '<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;margin:8px 0 6px">Health</div>',
    `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 10px;margin-bottom:12px">${healthSection}</div>`,
    '<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;margin:8px 0 6px">Node limit</div>',
    `<input type="number" data-limit-input min="50" max="50000" value="${state.nodeLimit}" style="width:120px;padding:7px 9px;border-radius:8px;background:var(--surface);color:var(--ink);border:1px solid var(--border);font-size:12px" />`,
    '</div>',
    '</div>',
    `<span data-filter-counter style="flex:0 0 auto;font-size:11px;color:var(--muted);white-space:nowrap">${state.visibleNodes.length} / ${state.rawNodes.length}</span>`,
    "</div>",
  ].join("");

  if (projectFilterEl) {
    projectFilterEl.style.display = "none";
    projectFilterEl.innerHTML = "";
  }
  if (limitRow) {
    limitRow.style.display = "none";
    limitRow.innerHTML = "";
  }

  const searchInput = filterEl.querySelector<HTMLInputElement>("[data-search-filter]");
  searchInput?.addEventListener("input", () => {
    state.searchQuery = searchInput.value;
    applyFilters({ resetCamera: false, emitSelection: Boolean(state.selectedNodeId) });
  });

  filterEl.querySelectorAll<HTMLInputElement>("[data-filter-type-check]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const key = checkbox.getAttribute("data-filter-type-check") as keyof typeof state.filterTypes;
      state.filterTypes[key] = checkbox.checked;
      applyFilters({ resetCamera: true, emitSelection: Boolean(state.selectedNodeId) });
    });
  });

  filterEl.querySelectorAll<HTMLInputElement>("[data-filter-topic-check]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const slug = checkbox.getAttribute("data-filter-topic-check") || "";
      state.filterTopics[slug] = checkbox.checked;
      applyFilters({ resetCamera: true, emitSelection: Boolean(state.selectedNodeId) });
    });
  });

  filterEl.querySelectorAll<HTMLInputElement>('input[name="graph-health-filter"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      state.filterHealth = radio.value;
      applyFilters({ resetCamera: false, emitSelection: Boolean(state.selectedNodeId) });
    });
  });

  const projectSelect = filterEl.querySelector<HTMLSelectElement>("[data-project-filter]");
  projectSelect?.addEventListener("change", () => {
    state.filterProject = projectSelect.value || "all";
    applyFilters({ resetCamera: true, emitSelection: Boolean(state.selectedNodeId) });
  });

  const storeSelect = filterEl.querySelector<HTMLSelectElement>("[data-store-filter]");
  storeSelect?.addEventListener("change", () => {
    state.filterStore = storeSelect.value || "all";
    applyFilters({ resetCamera: true, emitSelection: Boolean(state.selectedNodeId) });
  });

  const limitInput = filterEl.querySelector<HTMLInputElement>("[data-limit-input]");
  limitInput?.addEventListener("change", () => {
    const nextLimit = Number.parseInt(limitInput.value, 10);
    if (!Number.isFinite(nextLimit)) return;
    state.nodeLimit = clamp(nextLimit, 50, 50000);
    limitInput.value = String(state.nodeLimit);
    applyFilters({ resetCamera: false, emitSelection: Boolean(state.selectedNodeId) });
  });

  const filterToggle = filterEl.querySelector<HTMLElement>("[data-filter-toggle]");
  const filterPanel = filterEl.querySelector<HTMLElement>("[data-filter-panel]");
  if (filterToggle && filterPanel) {
    filterToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      filterPanel.style.display = filterPanel.style.display === "block" ? "none" : "block";
    });
    filterPanel.addEventListener("click", (event) => event.stopPropagation());
    const closePanel = () => { filterPanel.style.display = "none"; };
    document.addEventListener("click", closePanel);
    state.cleanupFns.push(() => document.removeEventListener("click", closePanel));
  }
}

function updateFilterBarCounter(): void {
  const filterEl = document.getElementById("graph-filter");
  if (!filterEl) return;
  const counter = filterEl.querySelector<HTMLElement>("[data-filter-counter]");
  if (counter) counter.textContent = `${state.visibleNodes.length} / ${state.rawNodes.length}`;
}

function applyFilters(options: { resetCamera?: boolean; emitSelection?: boolean } = {}): void {
  const visibleData = buildVisibleData();
  state.visibleNodes = visibleData.nodes;
  state.visibleLinks = visibleData.links;
  rebuildHostNodes();
  state.graph = buildGraph(visibleData.nodes, visibleData.links);
  refreshRenderer(Boolean(options.resetCamera));
  updateFilterBarCounter();

  if (state.selectedNodeId && !state.graph.hasNode(state.selectedNodeId)) {
    state.selectedNodeId = null;
    notifyClear();
  } else if (options.emitSelection && state.selectedNodeId) {
    setTimeout(() => notifySelection(state.selectedNodeId!), 0);
  }
}

function mount(payload: GraphPayload): void {
  state.container = document.getElementById("graph-canvas");
  state.tooltip = document.getElementById("graph-tooltip");
  if (!state.container) {
    console.error("[phrenGraph] #graph-canvas not found");
    return;
  }

  // Style tooltip
  if (state.tooltip) {
    state.tooltip.style.position = "absolute";
    state.tooltip.style.pointerEvents = "none";
    state.tooltip.style.zIndex = "1000";
    state.tooltip.style.maxWidth = "300px";
    state.tooltip.style.padding = "8px 12px";
    state.tooltip.style.borderRadius = "6px";
    state.tooltip.style.fontSize = "13px";
    state.tooltip.style.backgroundColor = "rgba(0, 0, 0, 0.85)";
    state.tooltip.style.color = "#fff";
    state.tooltip.style.boxShadow = "0 4px 12px rgba(0, 0, 0, 0.3)";
    state.tooltip.style.opacity = "0";
    state.tooltip.style.transition = "opacity 150ms ease-in-out";
    state.tooltip.style.whiteSpace = "pre-wrap";
    state.tooltip.style.wordBreak = "break-word";
    state.tooltip.style.lineHeight = "1.4";
    state.tooltip.classList.add("graph-tooltip");
  }

  state.payload = payload || {};
  state.rawNodes = (payload.nodes || []).map(normalizeNode);
  state.rawLinks = (payload.links || []).slice();
  state.topics = (payload.topics && payload.topics.length
    ? payload.topics
    : Array.from(new Map(
      state.rawNodes
        .filter((node) => node.kind === "finding" && node.topicSlug)
        .map((node) => [node.topicSlug!, { slug: node.topicSlug!, label: node.topicLabel || node.topicSlug! }]),
    ).values())
  ).sort((a, b) => a.label.localeCompare(b.label));
  ensureTopicFilters();

  state.nodeById = new Map();
  state.rawNodes.forEach((node) => state.nodeById.set(node.id, node));
  buildFullAdjacency();
  buildFilterBar();
  applyFilters({ resetCamera: true, emitSelection: Boolean(state.selectedNodeId) });
  startPhrenMascot();
}

function clearSelection(): void {
  if (!state.selectedNodeId && !state.focusedProjectId) return;
  state.selectedNodeId = null;
  state.focusedProjectId = null;
  state.hoveredNodeId = null;
  hideTooltip();
  state.renderer?.refresh();
  notifyClear();
}

function selectNode(nodeId: string): boolean {
  if (!state.graph?.hasNode(nodeId)) return false;

  // Project click → toggle focus mode
  const node = state.nodeById.get(nodeId);
  if (node?.kind === "project") {
    if (state.focusedProjectId === nodeId) {
      // Already focused on this project — unfocus
      clearSelection();
      return true;
    }
    state.focusedProjectId = nodeId;
    state.selectedNodeId = null;
    state.hoveredNodeId = null;
    state.renderer?.refresh();
    const display = state.renderer?.getNodeDisplayData(nodeId);
    if (display && state.renderer) {
      state.renderer.getCamera().animate({
        x: display.x,
        y: display.y,
        ratio: Math.max(state.renderer.getCamera().ratio * 0.8, 0.12),
      }, { duration: 280 });
    }
    // Delay so popover lands at post-animation position
    setTimeout(() => notifySelection(nodeId), 300);
    if (mascot.initialized && nodeId !== mascot.currentNodeId) {
      mascotMoveTo(nodeId);
    }
    return true;
  }

  // Non-project click → normal selection (clear focus mode)
  state.focusedProjectId = null;
  state.selectedNodeId = nodeId;
  state.hoveredNodeId = nodeId;
  state.renderer?.refresh();
  let hasAnim = false;
  const display = state.renderer?.getNodeDisplayData(nodeId);
  if (display && state.renderer) {
    hasAnim = true;
    state.renderer.getCamera().animate({
      x: display.x,
      y: display.y,
      ratio: Math.max(state.renderer.getCamera().ratio * 0.9, 0.16),
    }, { duration: 220 });
  }
  if (hasAnim) {
    setTimeout(() => notifySelection(nodeId), 240);
  } else {
    notifySelection(nodeId);
  }
  if (mascot.initialized && nodeId !== mascot.currentNodeId) {
    mascotMoveTo(nodeId);
  }
  return true;
}

function getNodeAt(x: number, y: number): NodeDetail | null {
  const renderer = state.renderer as Sigma & { getNodeAtPosition?: (position: { x: number; y: number }) => string | null };
  const nodeId = renderer?.getNodeAtPosition ? renderer.getNodeAtPosition({ x, y }) : null;
  return nodeId ? nodeDetail(nodeId) : null;
}

function destroy(): void {
  stopPhrenMascot();
  hideTooltip();
  state.themeObserver?.disconnect();
  state.themeObserver = null;
  state.cleanupFns.forEach((fn) => fn());
  state.cleanupFns = [];
  state.renderer?.kill();
  state.renderer = null;
  state.graph = null;
  state.container = null;
  state.tooltip = null;
}

// ── Phren mascot (sprite-based, ported from pre-sigma version) ──────────

const phrenImg = new Image();
let phrenImgReady = false;
phrenImg.onload = () => { phrenImgReady = true; };
phrenImg.src = PHREN_SPRITE_B64;

const mascot = {
  // Graph-space coordinates (camera-independent)
  gx: 0,
  gy: 0,
  targetGx: 0,
  targetGy: 0,
  moving: false,
  arriving: false,
  arriveTimer: 0,
  idlePhase: 0,
  trailPoints: [] as Array<{ gx: number; gy: number; age: number }>,
  initialized: false,
  tripDist: 0,
  tripProgress: 0,
  targetNodeId: null as string | null,
  currentNodeId: null as string | null,
  lastVisited: null as string | null,
  idleTimer: 0,
  idlePause: 30.0,
  userTarget: false,
};

function mascotGraphPos(nodeId: string): { x: number; y: number } | null {
  if (!state.graph?.hasNode(nodeId)) return null;
  const attrs = state.graph.getNodeAttributes(nodeId);
  if (attrs.x == null || attrs.y == null) return null;
  return { x: attrs.x as number, y: attrs.y as number };
}

function mascotToViewport(gx: number, gy: number): { x: number; y: number } | null {
  if (!state.renderer) return null;
  return state.renderer.graphToViewport({ x: gx, y: gy });
}

function mascotPickTarget(): string | null {
  if (!mascot.currentNodeId) return null;
  const neighbors = state.visibleAdjacency.get(mascot.currentNodeId);
  if (!neighbors || neighbors.size === 0) return null;
  const candidates = [...neighbors].filter((id) => id !== mascot.lastVisited);
  if (candidates.length === 0) return [...neighbors][Math.floor(Math.random() * neighbors.size)];
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function mascotMoveTo(targetId: string, userTriggered = false): void {
  // Don't let auto-wander override a user-triggered walk
  if (mascot.moving && mascot.userTarget && !userTriggered) return;
  const targetPos = mascotGraphPos(targetId);
  if (!targetPos) return;
  // Snap to current node's graph position before starting
  if (mascot.currentNodeId && !mascot.moving) {
    const curPos = mascotGraphPos(mascot.currentNodeId);
    if (curPos) {
      mascot.gx = curPos.x;
      mascot.gy = curPos.y;
    }
  }
  mascot.targetGx = targetPos.x;
  mascot.targetGy = targetPos.y;
  mascot.moving = true;
  mascot.arriving = false;
  mascot.userTarget = userTriggered;
  mascot.trailPoints = [{ gx: mascot.gx, gy: mascot.gy, age: 0 }];
  const dx = targetPos.x - mascot.gx;
  const dy = targetPos.y - mascot.gy;
  mascot.tripDist = Math.sqrt(dx * dx + dy * dy);
  mascot.tripProgress = 0;
  mascot.targetNodeId = targetId;
}

function mascotUpdate(dt: number): void {
  mascot.idlePhase += dt;

  if (mascot.moving) {
    // Re-resolve target graph position (node may have been dragged)
    if (mascot.targetNodeId) {
      const pos = mascotGraphPos(mascot.targetNodeId);
      if (pos) {
        mascot.targetGx = pos.x;
        mascot.targetGy = pos.y;
      }
    }

    const dx = mascot.targetGx - mascot.gx;
    const dy = mascot.targetGy - mascot.gy;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 0.008) {
      mascot.gx = mascot.targetGx;
      mascot.gy = mascot.targetGy;
      mascot.moving = false;
      mascot.arriving = true;
      mascot.arriveTimer = 0;
      mascot.trailPoints = [];
      if (mascot.targetNodeId) {
        mascot.lastVisited = mascot.currentNodeId;
        mascot.currentNodeId = mascot.targetNodeId;
      }
      mascot.idleTimer = 0;
      mascot.idlePause = mascot.userTarget ? 30.0 + Math.random() * 5.0 : 30.0 + Math.random() * 10.0;
    } else {
      // User clicks: ~0.4s to cross. Auto-wander: ~0.7s brisk walk.
      const divisor = mascot.userTarget ? 20 : 35;
      const t = mascot.tripDist > 0 ? Math.min(1, mascot.tripProgress / mascot.tripDist) : 1;
      const easeInOut = 0.5 - 0.5 * Math.cos(Math.PI * t);
      const baseSpeed = Math.max(mascot.userTarget ? 0.020 : 0.008, mascot.tripDist / divisor);
      const speed = Math.min(dist, Math.max(0.005, baseSpeed * (0.25 + 0.75 * easeInOut)));
      mascot.gx += (dx / dist) * speed;
      mascot.gy += (dy / dist) * speed;
      mascot.tripProgress += speed;
      mascot.trailPoints.push({ gx: mascot.gx, gy: mascot.gy, age: 0 });
      if (mascot.trailPoints.length > 50) mascot.trailPoints.shift();
    }
  }

  if (mascot.arriving) {
    mascot.arriveTimer += dt;
    if (mascot.arriveTimer > 1.0) mascot.arriving = false;
  }

  // Auto-wander: when idle long enough, pick a neighbor
  if (!mascot.moving && !mascot.arriving && mascot.initialized) {
    // If current node was deleted, relocate to a random visible node
    if (mascot.currentNodeId && !state.graph?.hasNode(mascot.currentNodeId)) {
      if (state.visibleNodes.length > 0) {
        const fallback = state.visibleNodes[Math.floor(Math.random() * state.visibleNodes.length)];
        const pos = mascotGraphPos(fallback.id);
        if (pos) { mascot.gx = pos.x; mascot.gy = pos.y; mascot.currentNodeId = fallback.id; }
      }
    }
    mascot.idleTimer += dt;
    if (mascot.idleTimer >= mascot.idlePause) {
      const next = mascotPickTarget();
      if (next) mascotMoveTo(next);
      mascot.idleTimer = 0;
    }
  }

  // Snap to current node graph position when idle (tracks dragged nodes)
  if (!mascot.moving && mascot.currentNodeId) {
    const pos = mascotGraphPos(mascot.currentNodeId);
    if (pos) {
      mascot.gx = pos.x;
      mascot.gy = pos.y;
    }
  }

  // Age trail
  for (let i = mascot.trailPoints.length - 1; i >= 0; i--) {
    mascot.trailPoints[i].age += dt;
    if (mascot.trailPoints[i].age > 2.0) mascot.trailPoints.splice(i, 1);
  }
}

function mascotDraw(ctx: CanvasRenderingContext2D): void {
  if (!mascot.initialized) return;
  // Convert graph coords to viewport coords at draw time
  const vp = mascotToViewport(mascot.gx, mascot.gy);
  if (!vp) return;
  const px = vp.x;
  const py = vp.y;

  // Trail (convert each point from graph to viewport)
  if (mascot.trailPoints.length > 1) {
    for (let i = 1; i < mascot.trailPoints.length; i++) {
      const ptVp = mascotToViewport(mascot.trailPoints[i].gx, mascot.trailPoints[i].gy);
      const prevVp = mascotToViewport(mascot.trailPoints[i - 1].gx, mascot.trailPoints[i - 1].gy);
      if (!ptVp || !prevVp) continue;
      const fadeT = 1 - mascot.trailPoints[i].age / 2.0;
      const alpha = Math.max(0, 0.38 * fadeT * fadeT);
      ctx.beginPath();
      ctx.strokeStyle = `rgba(123,104,174,${alpha})`;
      ctx.lineWidth = 3.0 * fadeT;
      ctx.moveTo(prevVp.x, prevVp.y);
      ctx.lineTo(ptVp.x, ptVp.y);
      ctx.stroke();
    }
  }

  // Sprite
  if (phrenImgReady) {
    ctx.save();
    let spriteSize = 36;
    if (mascot.arriving && mascot.arriveTimer < 0.4) {
      spriteSize += 6 * (1 - mascot.arriveTimer / 0.4);
    }
    const walkPhase = mascot.tripDist > 0
      ? (mascot.tripProgress / mascot.tripDist) * Math.PI * 6
      : mascot.idlePhase * 8;
    const bobOffset = mascot.moving ? Math.sin(walkPhase) * 2.5 : 0;
    const bounceOffset = (mascot.arriving && mascot.arriveTimer < 0.55)
      ? -3 * Math.sin(mascot.arriveTimer * Math.PI * 4.5) * Math.exp(-mascot.arriveTimer * 8)
      : 0;
    const idleScale = (!mascot.moving && !mascot.arriving)
      ? 1.0 + 0.02 * Math.sin(mascot.idlePhase * (2 * Math.PI / 3))
      : 1.0;
    const totalYOffset = bobOffset + bounceOffset;

    ctx.imageSmoothingEnabled = false;
    if (idleScale !== 1.0) {
      ctx.translate(px, py);
      ctx.scale(idleScale, idleScale);
      ctx.translate(-px, -py);
    }
    // Draw offset from node center so mascot sits beside, not on top
    const offsetX = spriteSize * 0.6;
    const offsetY = -spriteSize * 0.3;
    ctx.drawImage(
      phrenImg,
      px - spriteSize / 2 + offsetX,
      py - spriteSize / 2 + totalYOffset + offsetY,
      spriteSize,
      spriteSize,
    );
    ctx.restore();
  }
}

function startPhrenMascot(): void {
  if (!state.container || !state.renderer) return;
  // Clean up previous mascot if mount() called without destroy()
  stopPhrenMascot();

  // Create overlay canvas
  const canvas = document.createElement("canvas");
  canvas.style.position = "absolute";
  canvas.style.top = "0";
  canvas.style.left = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.pointerEvents = "none";
  canvas.style.zIndex = "5";
  state.container.appendChild(canvas);
  state.mascotCanvas = canvas;

  // Initialize mascot at a random visible node (graph coordinates)
  if (state.visibleNodes.length > 0) {
    const startIdx = Math.floor(Math.random() * state.visibleNodes.length);
    const startNode = state.visibleNodes[startIdx];
    const pos = mascotGraphPos(startNode.id);
    if (pos) {
      mascot.gx = pos.x;
      mascot.gy = pos.y;
      mascot.targetGx = pos.x;
      mascot.targetGy = pos.y;
      mascot.currentNodeId = startNode.id;
      mascot.initialized = true;
    }
  }

  let lastTime = 0;
  function mascotTick(timestamp: number): void {
    if (!state.mascotCanvas) return;
    const dt = lastTime > 0 ? Math.min(0.05, (timestamp - lastTime) / 1000) : 0.016;
    lastTime = timestamp;

    // Sync canvas size (CSS pixels — graphToViewport returns CSS coords)
    const container = state.container;
    if (container) {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, w, h);
        mascotUpdate(dt);
        mascotDraw(ctx);
      }
    }

    state.mascotRafId = requestAnimationFrame(mascotTick);
  }

  state.mascotRafId = requestAnimationFrame(mascotTick);
}

function stopPhrenMascot(): void {
  if (state.mascotRafId) {
    cancelAnimationFrame(state.mascotRafId);
    state.mascotRafId = 0;
  }
  if (state.mascotCanvas) {
    state.mascotCanvas.remove();
    state.mascotCanvas = null;
  }
  mascot.initialized = false;
}

ROOT.graphZoom = function graphZoom(factor: number): void {
  const renderer = state.renderer;
  if (!renderer) return;
  const camera = renderer.getCamera();
  if (factor >= 1) {
    void camera.animatedZoom({ factor, duration: 140 });
  } else {
    void camera.animatedUnzoom({ factor: 1 / Math.max(factor, 0.001), duration: 140 });
  }
};

ROOT.graphReset = function graphReset(): void {
  state.renderer?.getCamera().animatedReset({ duration: 180 });
};

ROOT.graphResetLayout = function graphResetLayout(): void {
  if (!state.graph || state.graph.order <= 1) return;
  const settings = forceAtlas2.inferSettings(state.graph);
  forceAtlas2.assign(state.graph, {
    iterations: state.graph.order < 80 ? 200 : state.graph.order < 240 ? 160 : 130,
    settings: {
      ...settings,
      linLogMode: true,
      adjustSizes: true,
      gravity: 0.3,
      scalingRatio: Math.max(4, settings.scalingRatio || 0, 7.5),
      slowDown: state.graph.order > 240 ? 8 : 5,
      barnesHutOptimize: state.graph.order > 120,
    },
  });
  state.renderer?.refresh();
  state.renderer?.getCamera().animatedReset({ duration: 220 });
};

ROOT.graphClearSelection = function graphClearSelection(): void {
  clearSelection();
};

ROOT.phrenGraph = {
  __renderer: "sigma",
  mount,
  onNodeSelect(callback: SelectCallback) {
    state.nodeSelectCallbacks.push(callback);
  },
  onSelectionClear(callback: ClearCallback) {
    state.selectionClearCallbacks.push(callback);
  },
  onRightClick(callback: (node: NodeDetail, x: number, y: number) => void) {
    state.rightClickCallbacks.push(callback);
  },
  clearSelection,
  selectNode,
  focusNode: selectNode,
  getNodeAt,
  getNodeDetail: nodeDetail,
  getData() {
    return {
      nodes: state.hostNodes.slice(),
      links: state.visibleLinks.slice(),
      topics: state.topics.slice(),
      total: state.rawNodes.length,
    };
  },
  destroy,
};

import ForceGraph3D from "3d-force-graph";
import * as THREE from "three";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
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
  findingCount?: number;
  taskCount?: number;
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

/** A node object handed to 3d-force-graph. Force layout mutates x/y/z/vx/vy/vz onto it. */
type FGNode = {
  id: string;
  raw: RuntimeNode;
  x?: number;
  y?: number;
  z?: number;
  fx?: number;
  fy?: number;
  fz?: number;
  __group?: THREE.Group;
  __core?: THREE.Mesh;
  __shell?: THREE.Mesh;
  __wire?: THREE.Mesh;
  __halo?: THREE.Sprite;
  __label?: THREE.Sprite;
  __focusScale?: number;
  __phase?: number;
};

/** A link object handed to 3d-force-graph. Force layout swaps source/target to node refs. */
type FGLink = { source: string | FGNode; target: string | FGNode };

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

const ROOT = window as unknown as {
  phrenGraph?: PhrenGraphApi;
  graphZoom?: (factor: number) => void;
  graphReset?: () => void;
  graphResetLayout?: () => void;
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
  if (!storeName || storeName === "primary") return null;
  if (!_storeColorMap) _storeColorMap = new Map();
  if (_storeColorMap.has(storeName)) return _storeColorMap.get(storeName)!;
  const idx = (_storeColorMap.size + 1) % STORE_COLORS.length;
  _storeColorMap.set(storeName, STORE_COLORS[idx]);
  return STORE_COLORS[idx];
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
  fg: null as any,
  fgNodeById: new Map<string, FGNode>(),
  container: null as HTMLElement | null,
  tooltip: null as HTMLElement | null,
  selectedNodeId: null as string | null,
  hoveredNodeId: null as string | null,
  focusedProjectId: null as string | null,
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
  lastMouse: { x: 0, y: 0 },
  firstSettle: true,
  bloomPass: null as UnrealBloomPass | null,
  starfield: null as THREE.Points | null,
  nebula: null as THREE.Group | null,
  ringSprite: null as THREE.Sprite | null,
  ringPhase: 0,
  vignetteEl: null as HTMLElement | null,
  ambientRafId: 0,
  themeObserver: null as MutationObserver | null,
  resizeObserver: null as ResizeObserver | null,
  cleanupFns: [] as Array<() => void>,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function currentTheme(): "dark" | "light" {
  const theme = document.documentElement.getAttribute("data-theme");
  return theme === "light" ? "light" : "dark";
}

function spaceBackground(theme: "dark" | "light"): string {
  return theme === "light" ? "#eceef3" : "#04050b";
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
  const kind = deriveKind(node);
  return {
    ...node,
    kind,
    searchText: searchTextForNode(node),
    health: inferHealth(score),
    baseColor: baseColorForNode(node),
    size: sizeForNode(node),
    forceLabel: kind === "project" || (kind === "entity" && (node.refCount || 0) >= 12),
  };
}

function ensureTopicFilters(): void {
  const next: Record<string, boolean> = {};
  for (const topic of state.topics) next[topic.slug] = state.filterTopics[topic.slug] !== false;
  state.filterTopics = next;
}

function buildFullAdjacency(): void {
  state.fullAdjacency = new Map();
  for (const node of state.rawNodes) state.fullAdjacency.set(node.id, new Set());
  for (const link of state.rawLinks) {
    if (!state.fullAdjacency.has(link.source) || !state.fullAdjacency.has(link.target)) continue;
    state.fullAdjacency.get(link.source)!.add(link.target);
    state.fullAdjacency.get(link.target)!.add(link.source);
  }
}

function connectionCounts(nodeId: string): NodeDetail["connections"] {
  const counts = { total: 0, projects: 0, findings: 0, tasks: 0, entities: 0, references: 0 };
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
      if ((node.project || "") !== project) return false;
    } else if (!connectedProjects.has(project)) {
      return false;
    }
  }

  if (state.searchQuery) {
    if (!node.searchText.includes(state.searchQuery.toLowerCase())) return false;
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
    const sorted = limitedNodes.slice().sort((a, b) => nodeRank(b) - nodeRank(a));
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
  const prunedNodes = limitedNodes.filter((node) =>
    node.kind !== "project" || connectedIds.has(node.id) || (node.project || "") === state.filterProject || state.filterTypes.project
  );
  return { nodes: prunedNodes, links: visibleLinks };
}

function rebuildHostNodes(): void {
  state.hostNodes = state.visibleNodes
    .map((node) => nodeDetail(node.id))
    .filter((node): node is NodeDetail => Boolean(node));
}

// ── 3D rendering layer ──────────────────────────────────────────────────

const NODE_GEOM = new THREE.SphereGeometry(1, 18, 18);
const PROJECT_GEOM = new THREE.IcosahedronGeometry(1, 1);

let _glowTexture: THREE.Texture | null = null;
function glowTexture(): THREE.Texture {
  if (_glowTexture) return _glowTexture;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, "rgba(255,255,255,0.95)");
  gradient.addColorStop(0.35, "rgba(255,255,255,0.55)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  _glowTexture = new THREE.CanvasTexture(canvas);
  return _glowTexture;
}

let _ringTexture: THREE.Texture | null = null;
function ringTexture(): THREE.Texture {
  if (_ringTexture) return _ringTexture;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(64, 64, 54, 0, Math.PI * 2);
  ctx.stroke();
  _ringTexture = new THREE.CanvasTexture(canvas);
  return _ringTexture;
}

/** Fresnel rim-glow shell — node silhouettes glow brighter than their centers. */
function makeShellMaterial(color: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: 1 },
      uRimPower: { value: 2.4 },
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uRimPower;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        float fres = pow(1.0 - max(dot(vNormal, vView), 0.0), uRimPower);
        vec3 col = uColor * (0.35 + fres * 1.7);
        gl_FragColor = vec4(col, uOpacity * (0.22 + fres * 0.9));
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

function makeLabelSprite(text: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  const fontSize = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.font = `600 ${fontSize}px Inter, system-ui, sans-serif`;
  const padding = 28;
  const textWidth = ctx.measureText(text).width;
  canvas.width = Math.ceil(textWidth + padding * 2);
  canvas.height = fontSize + padding;
  const ctx2 = canvas.getContext("2d")!;
  ctx2.font = `600 ${fontSize}px Inter, system-ui, sans-serif`;
  ctx2.fillStyle = "rgba(8,10,14,0.74)";
  const radius = canvas.height / 2;
  ctx2.beginPath();
  ctx2.roundRect(0, 0, canvas.width, canvas.height, radius);
  ctx2.fill();
  ctx2.fillStyle = "#f3eadd";
  ctx2.textBaseline = "middle";
  ctx2.fillText(text, padding, canvas.height / 2 + 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  const scale = 0.16;
  sprite.scale.set(canvas.width * scale, canvas.height * scale, 1);
  return sprite;
}

function nodeRadius(node: RuntimeNode): number {
  return clamp(node.size * 0.42, 2.6, 16);
}

function buildNodeObject(fgNode: FGNode): THREE.Group {
  if (fgNode.__group) return fgNode.__group;
  const node = fgNode.raw;
  const group = new THREE.Group();
  group.userData.phrenNodeId = node.id;
  const radius = nodeRadius(node);
  const color = new THREE.Color(node.baseColor);
  const shellGeom = node.kind === "project" ? PROJECT_GEOM : NODE_GEOM;

  // Bright inner core — blooms hot.
  const core = new THREE.Mesh(NODE_GEOM, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 }));
  core.scale.setScalar(radius * 0.55);
  group.add(core);

  // Fresnel shell — rim-lit translucent orb of light.
  const shell = new THREE.Mesh(shellGeom, makeShellMaterial(node.baseColor));
  shell.scale.setScalar(radius);
  group.add(shell);

  // Project hubs get a slowly rotating wireframe cage.
  if (node.kind === "project") {
    const wire = new THREE.Mesh(PROJECT_GEOM, new THREE.MeshBasicMaterial({
      color,
      wireframe: true,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
    }));
    wire.scale.setScalar(radius * 1.5);
    group.add(wire);
    fgNode.__wire = wire;
  }

  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(),
    color,
    transparent: true,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }));
  halo.scale.setScalar(radius * (node.kind === "project" ? 7 : 5.2));
  group.add(halo);

  if (node.forceLabel) {
    const label = makeLabelSprite(node.label);
    label.position.set(0, radius + 6, 0);
    label.material.opacity = 0.92;
    group.add(label);
    fgNode.__label = label;
  }

  fgNode.__group = group;
  fgNode.__core = core;
  fgNode.__shell = shell;
  fgNode.__halo = halo;
  fgNode.__focusScale = 1;
  return group;
}

/** Apply hover / selection / focus dimming directly to node materials. */
function applyHighlight(): void {
  const focus = state.hoveredNodeId || state.selectedNodeId;
  const focusProject = state.focusedProjectId;
  const neighbors = focus ? state.visibleAdjacency.get(focus) : null;

  state.fgNodeById.forEach((fgNode, id) => {
    if (!fgNode.__core || !fgNode.__shell) return;
    let lit = true;
    if (focusProject) {
      lit = isInProjectNetwork(id, focusProject);
    } else if (focus) {
      lit = id === focus || Boolean(neighbors?.has(id));
    }
    const isSelected = id === state.selectedNodeId || id === focusProject;
    const isHovered = id === state.hoveredNodeId;
    const coreMat = fgNode.__core.material as THREE.MeshBasicMaterial;
    const shellMat = fgNode.__shell.material as THREE.ShaderMaterial;
    const haloMat = fgNode.__halo!.material as THREE.SpriteMaterial;
    coreMat.opacity = lit ? 1 : 0.08;
    shellMat.uniforms.uOpacity.value = lit ? 1 : 0.05;
    haloMat.opacity = lit ? (isSelected || isHovered ? 0.95 : 0.5) : 0.03;
    if (fgNode.__wire) {
      (fgNode.__wire.material as THREE.MeshBasicMaterial).opacity = lit ? 0.34 : 0.04;
    }
    if (fgNode.__label) {
      (fgNode.__label.material as THREE.SpriteMaterial).opacity = lit ? 0.92 : 0.06;
    }
    // Breathing applies this each frame; here we only set the target.
    fgNode.__focusScale = isSelected ? 1.4 : isHovered ? 1.22 : 1;
  });

  if (state.fg) {
    // Re-evaluate link styling accessors.
    state.fg
      .linkColor(state.fg.linkColor())
      .linkWidth(state.fg.linkWidth())
      .linkDirectionalParticles(state.fg.linkDirectionalParticles());
  }
}

function linkEndpointId(end: string | FGNode): string {
  return typeof end === "string" ? end : end.id;
}

function linkIsFocused(link: FGLink): boolean {
  const focus = state.hoveredNodeId || state.selectedNodeId;
  const s = linkEndpointId(link.source);
  const t = linkEndpointId(link.target);
  if (focus) return s === focus || t === focus;
  if (state.focusedProjectId) {
    return isInProjectNetwork(s, state.focusedProjectId) && isInProjectNetwork(t, state.focusedProjectId);
  }
  return false;
}

function linkTouchesProject(link: FGLink): boolean {
  const s = state.nodeById.get(linkEndpointId(link.source));
  const t = state.nodeById.get(linkEndpointId(link.target));
  return s?.kind === "project" || t?.kind === "project";
}

function linkColor(link: FGLink): string {
  if (linkIsFocused(link)) return "rgba(255,217,102,0.9)";
  const focus = state.hoveredNodeId || state.selectedNodeId || state.focusedProjectId;
  if (focus) return state.theme === "dark" ? "rgba(120,140,170,0.04)" : "rgba(90,105,130,0.04)";
  // Tint each edge by a blend of its two endpoint colours so links read as relationships.
  const s = state.nodeById.get(linkEndpointId(link.source));
  const t = state.nodeById.get(linkEndpointId(link.target));
  if (s && t) {
    const c = new THREE.Color(s.baseColor).lerp(new THREE.Color(t.baseColor), 0.5);
    const r = Math.round(c.r * 255);
    const g = Math.round(c.g * 255);
    const b = Math.round(c.b * 255);
    return `rgba(${r},${g},${b},${state.theme === "dark" ? 0.34 : 0.3})`;
  }
  return state.theme === "dark" ? "rgba(120,150,200,0.22)" : "rgba(70,90,130,0.22)";
}

function linkWidth(link: FGLink): number {
  return linkIsFocused(link) ? 1.6 : 0.4;
}

function linkParticles(link: FGLink): number {
  if (linkIsFocused(link)) return 4;
  const focus = state.hoveredNodeId || state.selectedNodeId || state.focusedProjectId;
  if (focus) return 0;
  return linkTouchesProject(link) ? 1 : 0;
}

function buildStarfield(): THREE.Points {
  const count = 2200;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const radius = 2600 + Math.random() * 3200;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = radius * Math.cos(phi);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: 0xaab6ff,
    size: 5,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    fog: false,
  });
  return new THREE.Points(geometry, material);
}

/** Soft coloured nebula blooms parked far behind the graph. */
function buildNebula(): THREE.Group {
  const group = new THREE.Group();
  const blooms: Array<{ color: number; pos: [number, number, number]; scale: number }> = [
    { color: 0x7c3aed, pos: [-1000, 320, -1500], scale: 1700 },
    { color: 0x28d3f2, pos: [1150, -240, -1400], scale: 2000 },
    { color: 0x9c8ff8, pos: [240, 640, -1800], scale: 2300 },
  ];
  for (const bloom of blooms) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(),
      color: bloom.color,
      transparent: true,
      opacity: 0.2,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    }));
    sprite.scale.setScalar(bloom.scale);
    sprite.position.set(...bloom.pos);
    group.add(sprite);
  }
  return group;
}

const GRAIN_SVG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E";

/** A pointer-transparent DOM layer over the canvas: vignette + animated film grain. */
function buildCinematicOverlay(): HTMLElement {
  if (!document.getElementById("graph-grain-keyframes")) {
    const style = document.createElement("style");
    style.id = "graph-grain-keyframes";
    style.textContent =
      "@keyframes graphGrain {0%{transform:translate(0,0)}25%{transform:translate(-6%,4%)}" +
      "50%{transform:translate(5%,-5%)}75%{transform:translate(-4%,6%)}100%{transform:translate(0,0)}}";
    document.head.appendChild(style);
  }
  const overlay = document.createElement("div");
  overlay.className = "graph-cinematic";
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:4;overflow:hidden;";

  const vignette = document.createElement("div");
  vignette.className = "graph-vignette";
  vignette.style.cssText =
    "position:absolute;inset:0;background:radial-gradient(ellipse at 50% 50%, transparent 50%, rgba(0,0,0,0.6) 100%);";

  const grain = document.createElement("div");
  grain.style.cssText =
    `position:absolute;inset:-20%;opacity:0.05;mix-blend-mode:overlay;` +
    `background-image:url("${GRAIN_SVG}");background-size:180px 180px;` +
    `animation:graphGrain 0.6s steps(2) infinite;will-change:transform;`;

  overlay.appendChild(vignette);
  overlay.appendChild(grain);
  state.vignetteEl = vignette;
  return overlay;
}

function applyTheme(): void {
  state.theme = currentTheme();
  if (!state.fg) return;
  const dark = state.theme === "dark";
  state.fg.backgroundColor(spaceBackground(state.theme));
  if (state.bloomPass) state.bloomPass.strength = dark ? 1.15 : 0.4;
  if (state.starfield) {
    (state.starfield.material as THREE.PointsMaterial).opacity = dark ? 0.85 : 0.25;
  }
  const fog = state.fg.scene().fog as THREE.FogExp2 | null;
  if (fog) fog.color.set(spaceBackground(state.theme));
  if (state.nebula) state.nebula.visible = dark;
  if (state.vignetteEl) {
    state.vignetteEl.style.background = dark
      ? "radial-gradient(ellipse at 50% 50%, transparent 50%, rgba(0,0,0,0.6) 100%)"
      : "radial-gradient(ellipse at 50% 50%, transparent 58%, rgba(20,22,30,0.26) 100%)";
  }
  state.fg.linkColor(state.fg.linkColor());
}

function fgNodeFor(node: RuntimeNode): FGNode {
  let fgNode = state.fgNodeById.get(node.id);
  if (!fgNode) {
    fgNode = { id: node.id, raw: node };
    // Deterministic seed so layout is stable across reloads.
    const spread = 600;
    fgNode.x = (seeded(node.id, "x") - 0.5) * spread;
    fgNode.y = (seeded(node.id, "y") - 0.5) * spread;
    fgNode.z = (seeded(node.id, "z") - 0.5) * spread;
    state.fgNodeById.set(node.id, fgNode);
  } else {
    fgNode.raw = node;
  }
  return fgNode;
}

function pushGraphData(): void {
  const nodes = state.visibleNodes.map(fgNodeFor);
  const visibleIds = new Set(nodes.map((n) => n.id));
  const links: FGLink[] = state.visibleLinks
    .filter((link) => visibleIds.has(link.source) && visibleIds.has(link.target))
    .map((link) => ({ source: link.source, target: link.target }));
  state.fg.graphData({ nodes, links });
  applyHighlight();
}

function setupForceGraph(): void {
  if (!state.container || state.fg) return;
  state.theme = currentTheme();
  state.container.style.position = "relative";

  const fg = new ForceGraph3D(state.container, { controlType: "orbit" })
    .backgroundColor(spaceBackground(state.theme))
    .showNavInfo(false)
    .nodeId("id")
    .nodeThreeObject((node: FGNode) => buildNodeObject(node))
    .nodeThreeObjectExtend(false)
    .linkColor((link: FGLink) => linkColor(link))
    .linkWidth((link: FGLink) => linkWidth(link))
    .linkCurvature(0.28)
    .linkOpacity(1)
    .linkDirectionalParticles((link: FGLink) => linkParticles(link))
    .linkDirectionalParticleSpeed(0.012)
    .linkDirectionalParticleWidth(1.6)
    .linkDirectionalParticleColor(() => "#ffd966")
    .enableNodeDrag(true)
    .warmupTicks(24)
    .cooldownTicks(220)
    .onNodeHover((node: FGNode | null) => onHover(node))
    .onNodeClick((node: FGNode) => onNodeClick(node))
    .onNodeRightClick((node: FGNode, event: MouseEvent) => onNodeRightClick(node, event))
    .onNodeDragEnd((node: FGNode) => {
      node.fx = node.x;
      node.fy = node.y;
      node.fz = node.z;
    })
    .onBackgroundClick(() => {
      if (state.selectedNodeId || state.focusedProjectId) clearSelection();
    });

  state.fg = fg;

  // Orbit controls with gentle idle auto-rotate.
  fg.controls().autoRotate = true;
  fg.controls().autoRotateSpeed = 0.35;
  const pauseRotate = () => {
    fg.controls().autoRotate = false;
  };
  state.container.addEventListener("pointerdown", pauseRotate);
  state.container.addEventListener("wheel", pauseRotate, { passive: true });
  state.cleanupFns.push(() => {
    state.container?.removeEventListener("pointerdown", pauseRotate);
    state.container?.removeEventListener("wheel", pauseRotate);
  });

  // Force tuning for an airy 3D spread.
  const charge = fg.d3Force("charge");
  if (charge) charge.strength(-170);
  const linkForce = fg.d3Force("link");
  if (linkForce) {
    linkForce.distance((link: FGLink) => {
      const s = state.nodeById.get(linkEndpointId(link.source))?.kind;
      const t = state.nodeById.get(linkEndpointId(link.target))?.kind;
      if (s === "project" || t === "project") return 70;
      if (s === "entity" || t === "entity") return 48;
      return 34;
    });
  }

  // Bloom post-processing for the glow.
  const size = containerSize();
  state.bloomPass = new UnrealBloomPass(new THREE.Vector2(size.w, size.h), 1.15, 0.7, 0);
  fg.postProcessingComposer().addPass(state.bloomPass);

  // Gentle exponential fog so depth reads — far nodes melt into the background.
  fg.scene().fog = new THREE.FogExp2(spaceBackground(state.theme), 0.001);

  // Starfield + nebula backdrop.
  state.starfield = buildStarfield();
  fg.scene().add(state.starfield);
  state.nebula = buildNebula();
  fg.scene().add(state.nebula);

  // Expanding pulse ring shown around the selected node.
  state.ringSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: ringTexture(),
    color: 0xffd966,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    fog: false,
  }));
  state.ringSprite.visible = false;
  state.ringSprite.renderOrder = 998;
  fg.scene().add(state.ringSprite);

  // Cinematic vignette + film-grain overlay.
  const overlay = buildCinematicOverlay();
  state.container.appendChild(overlay);
  state.cleanupFns.push(() => overlay.remove());

  applyTheme();

  // Mouse tracking for tooltip placement.
  const onMouseMove = (event: MouseEvent) => {
    const rect = state.container!.getBoundingClientRect();
    state.lastMouse = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    if (state.tooltip && state.tooltip.style.opacity === "1") {
      state.tooltip.style.left = state.lastMouse.x + 14 + "px";
      state.tooltip.style.top = state.lastMouse.y + 14 + "px";
    }
  };
  state.container.addEventListener("mousemove", onMouseMove);
  state.cleanupFns.push(() => state.container?.removeEventListener("mousemove", onMouseMove));

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    if (!state.selectedNodeId && !state.focusedProjectId) return;
    clearSelection();
  };
  document.addEventListener("keydown", onKeydown);
  state.cleanupFns.push(() => document.removeEventListener("keydown", onKeydown));

  // Resize handling.
  const onResize = () => {
    const next = containerSize();
    state.fg?.width(next.w).height(next.h);
  };
  if (typeof ResizeObserver === "function") {
    state.resizeObserver = new ResizeObserver(onResize);
    state.resizeObserver.observe(state.container);
  } else {
    window.addEventListener("resize", onResize);
    state.cleanupFns.push(() => window.removeEventListener("resize", onResize));
  }
  onResize();

  fg.onEngineStop(() => {
    if (state.firstSettle) {
      state.firstSettle = false;
      fg.zoomToFit(700, 90);
    }
  });

  // Theme observer.
  const observer = new MutationObserver(() => {
    if (currentTheme() === state.theme) return;
    applyTheme();
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  state.themeObserver = observer;

  // Ambient loop: drift the starfield + animate the mascot.
  let lastTime = 0;
  const ambientTick = (timestamp: number) => {
    const dt = lastTime > 0 ? Math.min(0.05, (timestamp - lastTime) / 1000) : 0.016;
    lastTime = timestamp;
    const now = timestamp * 0.001;
    if (state.starfield) {
      state.starfield.rotation.y += dt * 0.012;
      state.starfield.rotation.x += dt * 0.004;
    }
    if (state.nebula) {
      state.nebula.rotation.z += dt * 0.006;
    }
    // Per-node breathing + project wireframe spin.
    state.fgNodeById.forEach((fgNode) => {
      if (!fgNode.__group) return;
      if (fgNode.__phase === undefined) fgNode.__phase = seeded(fgNode.id, "breathe") * 6.283;
      const breathe = 1 + 0.04 * Math.sin(now * 1.5 + fgNode.__phase);
      fgNode.__group.scale.setScalar((fgNode.__focusScale ?? 1) * breathe);
      if (fgNode.__wire) {
        fgNode.__wire.rotation.y += dt * 0.4;
        fgNode.__wire.rotation.x += dt * 0.15;
      }
    });
    // Expanding pulse ring around the active node.
    if (state.ringSprite) {
      const activeId = state.selectedNodeId || state.focusedProjectId;
      const pos = activeId ? nodeWorldPos(activeId) : null;
      if (pos) {
        state.ringSprite.visible = true;
        state.ringSprite.position.copy(pos);
        state.ringPhase = (state.ringPhase + dt * 0.85) % 1;
        const baseR = nodeRadius(state.nodeById.get(activeId!)!) || 8;
        state.ringSprite.scale.setScalar(baseR * (2 + state.ringPhase * 5.5));
        (state.ringSprite.material as THREE.SpriteMaterial).opacity = (1 - state.ringPhase) * 0.7;
      } else {
        state.ringSprite.visible = false;
      }
    }
    mascotUpdate(dt);
    state.ambientRafId = requestAnimationFrame(ambientTick);
  };
  state.ambientRafId = requestAnimationFrame(ambientTick);
}

function containerSize(): { w: number; h: number } {
  const w = state.container?.clientWidth || 800;
  const h = state.container?.clientHeight || 600;
  return { w: Math.max(1, w), h: Math.max(1, h) };
}

// ── Interaction ─────────────────────────────────────────────────────────

function hideTooltip(): void {
  if (!state.tooltip) return;
  state.tooltip.style.opacity = "0";
  state.tooltip.innerHTML = "";
}

function tooltipText(node: RuntimeNode): string {
  if (node.kind === "finding") {
    const text = node.fullLabel || node.label || "";
    let preview = text.length > 100 ? text.slice(0, 97) + "..." : text;
    const score = scoreForNode(node);
    const rawDate = node.date && node.date !== "unknown" ? node.date : "";
    const dateStr = rawDate || score?.lastUsedAt || "";
    if (dateStr) {
      const d = new Date(dateStr);
      if (!isNaN(d.getTime())) {
        const days = Math.floor((Date.now() - d.getTime()) / 86400000);
        const rel = days < 1 ? "today" : days === 1 ? "yesterday" : days < 30 ? `${days}d ago` : days < 365 ? `${Math.floor(days / 30)}mo ago` : `${Math.floor(days / 365)}y ago`;
        preview += `\n${node.date ? rel : "seen " + rel}`;
      }
    }
    return preview;
  }
  if (node.kind === "task") {
    const line = node.fullLabel || node.label || "";
    const section = node.section ? `[${node.section}]` : "";
    const priority = node.priority ? `${node.priority}◆` : "";
    return `${line}\n${[section, priority].filter(Boolean).join(" ")}`;
  }
  if (node.kind === "entity") {
    return `${node.label}\n${node.refCount || 0} refs • ${node.connectedProjects?.length || 0} projects`;
  }
  if (node.kind === "project") {
    return `${node.label}\n${node.findingCount || 0} findings • ${node.taskCount || 0} tasks`;
  }
  return node.label || node.id;
}

function onHover(fgNode: FGNode | null): void {
  state.hoveredNodeId = fgNode ? fgNode.id : null;
  if (state.container) state.container.style.cursor = fgNode ? "pointer" : "default";
  if (fgNode && state.tooltip) {
    const text = tooltipText(fgNode.raw);
    if (text) {
      state.tooltip.textContent = text;
      state.tooltip.style.left = state.lastMouse.x + 14 + "px";
      state.tooltip.style.top = state.lastMouse.y + 14 + "px";
      state.tooltip.style.opacity = "1";
    }
  } else {
    hideTooltip();
  }
  applyHighlight();
}

function flyToNode(fgNode: FGNode, duration: number): void {
  if (!state.fg || fgNode.x == null) return;
  const distance = 90 + nodeRadius(fgNode.raw) * 7;
  const len = Math.hypot(fgNode.x, fgNode.y || 0, fgNode.z || 0) || 1;
  const ratio = 1 + distance / len;
  state.fg.cameraPosition(
    { x: (fgNode.x || 0) * ratio, y: (fgNode.y || 0) * ratio, z: (fgNode.z || 0) * ratio },
    { x: fgNode.x || 0, y: fgNode.y || 0, z: fgNode.z || 0 },
    duration,
  );
}

function screenPosFor(nodeId: string): { x: number; y: number } | null {
  const fgNode = state.fgNodeById.get(nodeId);
  if (!fgNode || !state.fg || fgNode.x == null) return null;
  try {
    const coords = state.fg.graph2ScreenCoords(fgNode.x, fgNode.y || 0, fgNode.z || 0);
    return { x: coords.x, y: coords.y };
  } catch {
    return null;
  }
}

function notifySelection(nodeId: string): void {
  const detail = nodeDetail(nodeId);
  const position = screenPosFor(nodeId) || { x: state.lastMouse.x, y: state.lastMouse.y };
  if (!detail) return;
  state.nodeSelectCallbacks.forEach((callback) => callback(detail, position.x, position.y));
}

function notifyClear(): void {
  state.selectionClearCallbacks.forEach((callback) => callback());
}

function onNodeClick(fgNode: FGNode): void {
  selectNode(fgNode.id);
}

function onNodeRightClick(fgNode: FGNode, event: MouseEvent): void {
  event.preventDefault();
  const detail = nodeDetail(fgNode.id);
  if (!detail) return;
  const rect = state.container?.getBoundingClientRect();
  const x = rect ? event.clientX - rect.left : event.clientX;
  const y = rect ? event.clientY - rect.top : event.clientY;
  state.rightClickCallbacks.forEach((cb) => cb(detail, x, y));
}

function clearSelection(): void {
  if (!state.selectedNodeId && !state.focusedProjectId) return;
  state.selectedNodeId = null;
  state.focusedProjectId = null;
  state.hoveredNodeId = null;
  hideTooltip();
  applyHighlight();
  notifyClear();
}

function selectNode(nodeId: string): boolean {
  const fgNode = state.fgNodeById.get(nodeId);
  if (!fgNode) return false;
  const node = state.nodeById.get(nodeId);

  if (node?.kind === "project") {
    if (state.focusedProjectId === nodeId) {
      clearSelection();
      return true;
    }
    state.focusedProjectId = nodeId;
    state.selectedNodeId = null;
    state.hoveredNodeId = null;
    applyHighlight();
    flyToNode(fgNode, 900);
    setTimeout(() => notifySelection(nodeId), 950);
    mascotMoveTo(nodeId, true);
    return true;
  }

  state.focusedProjectId = null;
  state.selectedNodeId = nodeId;
  state.hoveredNodeId = nodeId;
  hideTooltip();
  applyHighlight();
  flyToNode(fgNode, 800);
  setTimeout(() => notifySelection(nodeId), 850);
  mascotMoveTo(nodeId, true);
  return true;
}

function getNodeAt(x: number, y: number): NodeDetail | null {
  if (!state.fg) return null;
  const size = containerSize();
  const ndc = new THREE.Vector2((x / size.w) * 2 - 1, -(y / size.h) * 2 + 1);
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, state.fg.camera());
  const hits = raycaster.intersectObjects(state.fg.scene().children, true);
  for (const hit of hits) {
    let obj: THREE.Object3D | null = hit.object;
    while (obj) {
      const id = obj.userData?.phrenNodeId;
      if (typeof id === "string") return nodeDetail(id);
      obj = obj.parent;
    }
  }
  return null;
}

function applyFilters(options: { resetCamera?: boolean; emitSelection?: boolean } = {}): void {
  const visibleData = buildVisibleData();
  state.visibleNodes = visibleData.nodes;
  state.visibleLinks = visibleData.links;
  rebuildHostNodes();
  if (state.fg) pushGraphData();
  updateFilterBarCounter();

  if (state.selectedNodeId && !state.visibleAdjacency.has(state.selectedNodeId)) {
    state.selectedNodeId = null;
    notifyClear();
  } else if (options.emitSelection && state.selectedNodeId) {
    setTimeout(() => notifySelection(state.selectedNodeId!), 0);
  }
  if (options.resetCamera && state.fg) {
    // onEngineStop fits the camera once the layout settles.
    state.firstSettle = true;
  }
}

// ── Filter bar ──────────────────────────────────────────────────────────

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildFilterBar(): void {
  const filterEl = document.getElementById("graph-filter");
  const projectFilterEl = document.getElementById("graph-project-filter");
  const limitRow = document.getElementById("graph-limit-row");
  if (!filterEl) return;

  const projectNames = Array.from(new Set(
    state.rawNodes.filter((node) => node.kind === "project").map((node) => node.project || node.id)
  )).sort((a, b) => a.localeCompare(b));

  const storeNames = Array.from(new Set(
    state.rawNodes.map((node) => node.store).filter((store): store is string => Boolean(store))
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

// ── Public lifecycle ────────────────────────────────────────────────────

function mount(payload: GraphPayload): void {
  state.container = document.getElementById("graph-canvas");
  state.tooltip = document.getElementById("graph-tooltip");
  if (!state.container) {
    console.error("[phrenGraph] #graph-canvas not found");
    return;
  }

  if (state.tooltip) {
    Object.assign(state.tooltip.style, {
      position: "absolute",
      pointerEvents: "none",
      zIndex: "1000",
      maxWidth: "300px",
      padding: "8px 12px",
      borderRadius: "6px",
      fontSize: "13px",
      backgroundColor: "rgba(0, 0, 0, 0.85)",
      color: "#fff",
      boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
      opacity: "0",
      transition: "opacity 150ms ease-in-out",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      lineHeight: "1.4",
    });
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

  // Rebuild from scratch so node meshes reflect the fresh payload — three-forcegraph
  // keys its cached objects off the node reference, so new payloads need new objects.
  state.fgNodeById.forEach(disposeNodeObject);
  state.fgNodeById.clear();

  buildFullAdjacency();
  buildFilterBar();
  setupForceGraph();
  state.firstSettle = true;
  applyFilters({ resetCamera: true, emitSelection: Boolean(state.selectedNodeId) });
  startMascot();
}

function disposeNodeObject(fgNode: FGNode): void {
  if (fgNode.__core) (fgNode.__core.material as THREE.Material).dispose();
  if (fgNode.__shell) (fgNode.__shell.material as THREE.Material).dispose();
  if (fgNode.__wire) (fgNode.__wire.material as THREE.Material).dispose();
  if (fgNode.__halo) (fgNode.__halo.material as THREE.SpriteMaterial).dispose();
  if (fgNode.__label) {
    const mat = fgNode.__label.material as THREE.SpriteMaterial;
    mat.map?.dispose();
    mat.dispose();
  }
  fgNode.__group = undefined;
  fgNode.__core = undefined;
  fgNode.__shell = undefined;
  fgNode.__wire = undefined;
  fgNode.__halo = undefined;
  fgNode.__label = undefined;
}

function updateNode(
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
): boolean {
  const node = state.nodeById.get(nodeId);
  if (!node) return false;

  if (typeof changes.section === "string") node.section = changes.section;
  if (typeof changes.priority === "string") node.priority = changes.priority;
  if (typeof changes.topicSlug === "string") node.topicSlug = changes.topicSlug;
  if (typeof changes.topicLabel === "string") node.topicLabel = changes.topicLabel;
  if (typeof changes.text === "string") {
    node.fullLabel = changes.text;
    if (!changes.label) node.label = changes.text.slice(0, 40) + (changes.text.length > 40 ? "…" : "");
  }
  if (typeof changes.fullLabel === "string") node.fullLabel = changes.fullLabel;
  if (typeof changes.label === "string") node.label = changes.label;

  node.baseColor = changes.color || baseColorForNode(node);
  node.searchText = searchTextForNode(node);

  const hostEntry = state.hostNodes.find((host) => host.id === nodeId);
  if (hostEntry) {
    Object.assign(hostEntry, {
      section: node.section,
      priority: node.priority,
      topicSlug: node.topicSlug,
      topicLabel: node.topicLabel,
      label: node.label,
      fullLabel: node.fullLabel,
      baseColor: node.baseColor,
    });
  }

  const fgNode = state.fgNodeById.get(nodeId);
  if (fgNode?.__core) {
    (fgNode.__core.material as THREE.MeshBasicMaterial).color.set(node.baseColor);
    (fgNode.__halo!.material as THREE.SpriteMaterial).color.set(node.baseColor);
    if (fgNode.__shell) {
      (fgNode.__shell.material as THREE.ShaderMaterial).uniforms.uColor.value.set(node.baseColor);
    }
    if (fgNode.__wire) {
      (fgNode.__wire.material as THREE.MeshBasicMaterial).color.set(node.baseColor);
    }
  }
  return true;
}

function removeNode(nodeId: string, opts?: { animate?: boolean }): boolean {
  const fgNode = state.fgNodeById.get(nodeId);
  if (!state.nodeById.has(nodeId) && !fgNode) return false;

  const wasSelected = state.selectedNodeId === nodeId;
  const reducedMotion = typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const animate = opts?.animate !== false && !reducedMotion && Boolean(fgNode?.__group);

  const finalize = () => {
    state.rawNodes = state.rawNodes.filter((node) => node.id !== nodeId);
    state.rawLinks = state.rawLinks.filter((link) => link.source !== nodeId && link.target !== nodeId);
    state.nodeById.delete(nodeId);
    if (state.selectedNodeId === nodeId) state.selectedNodeId = null;
    if (state.hoveredNodeId === nodeId) state.hoveredNodeId = null;
    if (state.focusedProjectId === nodeId) state.focusedProjectId = null;
    if (fgNode) {
      disposeNodeObject(fgNode);
      state.fgNodeById.delete(nodeId);
    }
    if (mascot.currentNodeId === nodeId) mascot.currentNodeId = null;
    if (mascot.targetNodeId === nodeId) mascot.targetNodeId = null;
    buildFullAdjacency();
    hideTooltip();
    applyFilters({ resetCamera: false, emitSelection: false });
    if (wasSelected) notifyClear();
  };

  if (!animate || !fgNode?.__group) {
    finalize();
    return true;
  }

  if (wasSelected) clearSelection();
  hideTooltip();
  const duration = 280;
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    const scale = (1 - t) * (1 - t) * (1 - t);
    // Breathing renders __focusScale each frame, so shrink via that.
    fgNode.__focusScale = Math.max(0.01, scale);
    if (t < 1) requestAnimationFrame(step);
    else finalize();
  };
  requestAnimationFrame(step);
  return true;
}

function destroy(): void {
  stopMascot();
  hideTooltip();
  if (state.ambientRafId) cancelAnimationFrame(state.ambientRafId);
  state.ambientRafId = 0;
  state.themeObserver?.disconnect();
  state.themeObserver = null;
  state.resizeObserver?.disconnect();
  state.resizeObserver = null;
  state.cleanupFns.forEach((fn) => fn());
  state.cleanupFns = [];
  state.fgNodeById.forEach(disposeNodeObject);
  state.fgNodeById.clear();
  if (state.starfield) {
    state.starfield.geometry.dispose();
    (state.starfield.material as THREE.Material).dispose();
  }
  state.nebula?.children.forEach((child) => {
    ((child as THREE.Sprite).material as THREE.SpriteMaterial).dispose();
  });
  if (state.ringSprite) (state.ringSprite.material as THREE.SpriteMaterial).dispose();
  if (state.fg) {
    try { state.fg._destructor?.(); } catch { /* ignore */ }
  }
  state.fg = null;
  state.starfield = null;
  state.nebula = null;
  state.ringSprite = null;
  state.vignetteEl = null;
  state.bloomPass = null;
  state.container = null;
  state.tooltip = null;
}

// ── Phren mascot — a sprite that flies the 3D graph ─────────────────────

const mascot = {
  sprite: null as THREE.Sprite | null,
  glow: null as THREE.Sprite | null,
  pos: new THREE.Vector3(),
  target: new THREE.Vector3(),
  moving: false,
  initialized: false,
  bobPhase: 0,
  idleTimer: 0,
  idlePause: 6,
  tripT: 0,
  currentNodeId: null as string | null,
  targetNodeId: null as string | null,
  lastVisited: null as string | null,
  userTarget: false,
};

function nodeWorldPos(nodeId: string): THREE.Vector3 | null {
  const fgNode = state.fgNodeById.get(nodeId);
  if (!fgNode || fgNode.x == null) return null;
  return new THREE.Vector3(fgNode.x, fgNode.y || 0, fgNode.z || 0);
}

function startMascot(): void {
  stopMascot();
  if (!state.fg) return;
  const texture = new THREE.TextureLoader().load(PHREN_SPRITE_B64);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  }));
  sprite.scale.setScalar(26);
  sprite.renderOrder = 999;
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(),
    color: 0x9c8ff8,
    transparent: true,
    opacity: 0.6,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }));
  glow.scale.setScalar(72);
  state.fg.scene().add(glow);
  state.fg.scene().add(sprite);
  mascot.sprite = sprite;
  mascot.glow = glow;

  if (state.visibleNodes.length) {
    const start = state.visibleNodes[Math.floor(Math.random() * state.visibleNodes.length)];
    const pos = nodeWorldPos(start.id);
    if (pos) {
      mascot.pos.copy(pos);
      mascot.target.copy(pos);
      mascot.currentNodeId = start.id;
      mascot.initialized = true;
    }
  }
}

function stopMascot(): void {
  if (mascot.sprite) {
    state.fg?.scene().remove(mascot.sprite);
    const mat = mascot.sprite.material as THREE.SpriteMaterial;
    mat.map?.dispose();
    mat.dispose();
  }
  if (mascot.glow) {
    state.fg?.scene().remove(mascot.glow);
    (mascot.glow.material as THREE.SpriteMaterial).dispose();
  }
  mascot.sprite = null;
  mascot.glow = null;
  mascot.initialized = false;
  mascot.moving = false;
  mascot.currentNodeId = null;
  mascot.targetNodeId = null;
}

function mascotPickTarget(): string | null {
  if (!mascot.currentNodeId) return null;
  const neighbors = state.visibleAdjacency.get(mascot.currentNodeId);
  if (!neighbors || neighbors.size === 0) return null;
  const candidates = [...neighbors].filter((id) => id !== mascot.lastVisited && state.fgNodeById.has(id));
  const pool = candidates.length ? candidates : [...neighbors].filter((id) => state.fgNodeById.has(id));
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

function mascotMoveTo(targetId: string, userTriggered = false): void {
  if (!mascot.initialized) return;
  if (mascot.moving && mascot.userTarget && !userTriggered) return;
  const pos = nodeWorldPos(targetId);
  if (!pos) return;
  mascot.target.copy(pos);
  mascot.targetNodeId = targetId;
  mascot.moving = true;
  mascot.tripT = 0;
  mascot.userTarget = userTriggered;
}

function mascotUpdate(dt: number): void {
  if (!mascot.initialized || !mascot.sprite || !mascot.glow) return;
  mascot.bobPhase += dt;

  if (mascot.moving) {
    if (mascot.targetNodeId) {
      const pos = nodeWorldPos(mascot.targetNodeId);
      if (pos) mascot.target.copy(pos);
    }
    mascot.tripT = Math.min(1, mascot.tripT + dt / (mascot.userTarget ? 0.7 : 1.3));
    const eased = 0.5 - 0.5 * Math.cos(Math.PI * mascot.tripT);
    mascot.pos.lerpVectors(mascot.pos.clone(), mascot.target, eased * 0.5 + dt * 2);
    if (mascot.tripT >= 1 || mascot.pos.distanceTo(mascot.target) < 0.6) {
      mascot.pos.copy(mascot.target);
      mascot.moving = false;
      mascot.lastVisited = mascot.currentNodeId;
      mascot.currentNodeId = mascot.targetNodeId;
      mascot.idleTimer = 0;
      mascot.idlePause = 5 + Math.random() * 6;
    }
  } else {
    if (mascot.currentNodeId) {
      const pos = nodeWorldPos(mascot.currentNodeId);
      if (pos) mascot.pos.lerp(pos, Math.min(1, dt * 4));
    }
    mascot.idleTimer += dt;
    if (mascot.idleTimer >= mascot.idlePause) {
      const next = mascotPickTarget();
      if (next) mascotMoveTo(next);
      mascot.idleTimer = 0;
    }
  }

  const bob = Math.sin(mascot.bobPhase * 2.2) * 3;
  mascot.sprite.position.set(mascot.pos.x + 14, mascot.pos.y + 14 + bob, mascot.pos.z);
  mascot.glow.position.copy(mascot.sprite.position);
  const pulse = 0.5 + 0.18 * Math.sin(mascot.bobPhase * 3);
  (mascot.glow.material as THREE.SpriteMaterial).opacity = mascot.moving ? pulse + 0.2 : pulse;
}

// ── Window globals ──────────────────────────────────────────────────────

ROOT.graphZoom = function graphZoom(factor: number): void {
  if (!state.fg) return;
  const camera = state.fg.camera();
  const target = state.fg.controls()?.target || new THREE.Vector3();
  const dir = new THREE.Vector3().subVectors(camera.position, target);
  dir.multiplyScalar(1 / Math.max(factor, 0.05));
  const next = new THREE.Vector3().addVectors(target, dir);
  state.fg.cameraPosition({ x: next.x, y: next.y, z: next.z }, undefined, 160);
};

ROOT.graphReset = function graphReset(): void {
  state.fg?.zoomToFit(500, 90);
};

ROOT.graphResetLayout = function graphResetLayout(): void {
  if (!state.fg) return;
  state.fgNodeById.forEach((fgNode) => {
    fgNode.fx = undefined;
    fgNode.fy = undefined;
    fgNode.fz = undefined;
  });
  state.firstSettle = true;
  state.fg.d3ReheatSimulation();
};

ROOT.graphClearSelection = function graphClearSelection(): void {
  clearSelection();
};

ROOT.phrenGraph = {
  __renderer: "three",
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
  removeNode,
  updateNode,
  destroy,
};

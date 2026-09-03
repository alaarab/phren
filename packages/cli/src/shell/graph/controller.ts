/**
 * State + interaction for the terminal graph view.
 *
 * The controller is the terminal-side analogue of the browser's
 * `browser/graph/state.ts` + `interactions.ts`: it owns the payload built by
 * `buildGraph`, the normalized model from `graph-core`, the force layout, a 2D
 * camera, selection/search/focus, and the key map. Rendering lives in
 * `graph-view.ts`; this module never writes to the terminal.
 */

import { computePhrenLiveStateToken } from "../../phren-paths.js";
import { buildGraph } from "../../ui/data.js";
import {
  StoreColorAssigner,
  bestSearchMatch,
  buildFullAdjacency,
  buildVisibleData,
  nodeDetail,
  nodeRank,
  normalizeNode,
  recomputeSearchMatches,
} from "../../graph-core/model.js";
import type { GraphFilters, GraphModel, VisibleData } from "../../graph-core/model.js";
import type { GraphPayload, NodeDetail, NodeKind, RawLink, RuntimeNode } from "../../graph-core/types.js";
import { errorMessage } from "../../utils.js";
import { logger } from "../../logger.js";
import { style } from "../render.js";
import { ForceSim, bounds, type LayoutNode, type Point } from "./layout.js";
import { GraphWatch, type ActivityItem } from "./watch.js";
import { GraphAgents } from "./agents.js";
import { GraphMascot } from "./mascot.js";

/** Nodes drawn at once. Terminals have far fewer pixels than a browser tab. */
export const TUI_NODE_LIMIT = 350;

export type GraphStatus = "idle" | "loading" | "ready" | "empty" | "error";

export interface FilterPreset {
  name: string;
  types: Partial<Record<NodeKind, boolean>>;
  health: string;
}

const ALL_TYPES: Partial<Record<NodeKind, boolean>> = { project: true, finding: true, task: true, entity: true, reference: true };

export const FILTER_PRESETS: FilterPreset[] = [
  { name: "all", types: ALL_TYPES, health: "all" },
  { name: "findings", types: { project: true, finding: true }, health: "all" },
  { name: "tasks", types: { project: true, task: true }, health: "all" },
  { name: "fragments", types: { project: true, entity: true, reference: true }, health: "all" },
  { name: "aging", types: ALL_TYPES, health: "aging" },
];

export interface Camera {
  /** World coordinates at the centre of the viewport. */
  cx: number;
  cy: number;
  /**
   * Braille dots per world unit, per axis. A terminal canvas is much wider
   * than it is tall, so fitting a roughly round graph to the shorter axis
   * would waste most of the width. The two scales are allowed to diverge up
   * to MAX_STRETCH, which fills the screen while keeping the shape readable.
   */
  scaleX: number;
  scaleY: number;
}

/** How far the x and y scales may diverge when filling the canvas. */
const MAX_STRETCH = 2.2;

export interface SearchState {
  query: string;
  matchIds: Set<string>;
  results: RuntimeNode[];
  /** Cursor into results; -1 when nothing is active. */
  index: number;
}

/** What the controller needs from the shell when a key lands. */
export interface GraphKeyHost {
  setMessage(msg: string): void;
  startInput(ctx: string, initial: string): void;
}

/** Injected so tests can feed a fixture instead of scanning a store. */
export type GraphBuilder = (phrenPath: string, profile: string) => Promise<GraphPayload>;

export interface GraphControllerOptions {
  builder?: GraphBuilder;
  tokenOf?: (phrenPath: string) => string;
  /** Animation frame period; the tests shrink it. */
  frameMs?: number;
  /** Injected watch, so tests can feed events without a log file or timers. */
  watch?: GraphWatch;
  /** Injected agents poller, so tests never shell out. */
  agents?: GraphAgents;
  /** Start with watch mode off (`--no-live`). */
  watchEnabled?: boolean;
}

const DIRECTIONS: Record<string, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

function normalizeArrow(rawKey: string): string {
  return /^\x1bO[A-D]$/.test(rawKey) ? `\x1b[${rawKey[2]}` : rawKey;
}

const ARROW_DIRECTION: Record<string, keyof typeof DIRECTIONS> = {
  "\x1b[A": "up",
  "\x1b[B": "down",
  "\x1b[D": "left",
  "\x1b[C": "right",
};

/** Shift+arrow in the CSI 1;2 form most terminals emit. */
const SHIFT_ARROW_DIRECTION: Record<string, keyof typeof DIRECTIONS> = {
  "\x1b[1;2A": "up",
  "\x1b[1;2B": "down",
  "\x1b[1;2D": "left",
  "\x1b[1;2C": "right",
};

const PAN_LETTER_DIRECTION: Record<string, keyof typeof DIRECTIONS> = { K: "up", J: "down", H: "left", L: "right" };

export class GraphController {
  status: GraphStatus = "idle";
  errorText = "";
  /** A rebuild is running while the previous picture stays on screen. */
  get refreshing(): boolean { return this.building !== null && this.payload !== null; }

  payload: GraphPayload | null = null;
  model: GraphModel = { rawNodes: [], rawLinks: [], nodeById: new Map(), fullAdjacency: new Map(), visibleAdjacency: new Map(), scores: {} };
  filters: GraphFilters = {
    filterTypes: { ...ALL_TYPES },
    filterTopics: {},
    filterHealth: "all",
    filterProject: "all",
    filterStore: "all",
    searchQuery: "",
    nodeLimit: TUI_NODE_LIMIT,
  };
  visible: VisibleData = { nodes: [], links: [], visibleAdjacency: new Map() };
  /** Project nodes in display order for `[`/`]`. */
  projects: RuntimeNode[] = [];
  presetIndex = 0;
  selectedId: string | null = null;
  search: SearchState = { query: "", matchIds: new Set(), results: [], index: -1 };
  camera: Camera = { cx: 0, cy: 0, scaleX: 2, scaleY: 2 };

  private sim: ForceSim | null = null;
  private lastPositions: Map<string, Point> = new Map();
  private viewport = { width: 160, height: 80 };
  private dataToken = "";
  private building: Promise<void> | null = null;
  private repaintHook: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private cameraTarget: Point | null = null;
  /** Re-frame once the intro settle finishes so the whole map is in view. */
  private fitOnSettle = false;
  /** Set by pan/zoom; until then a resize re-fits the whole map. */
  private userMoved = false;
  private readonly builder: GraphBuilder;
  private readonly tokenOf: (phrenPath: string) => string;
  private readonly frameMs: number;

  /** Live tail of what phren is landing on, in this or any other terminal. */
  readonly watch: GraphWatch;
  /** Coding agents running on this machine, joined onto their projects. */
  readonly agents: GraphAgents;
  /** phren himself, who walks to whatever the store just touched. */
  readonly mascot = new GraphMascot();
  watchEnabled: boolean;
  /**
   * Wall-clock ms of the last navigation keypress. While the user is driving,
   * incoming events still pulse and feed but do not steal the camera.
   */
  private lastUserInputAt = 0;

  constructor(readonly phrenPath: string, readonly profile: string, opts: GraphControllerOptions = {}) {
    this.builder = opts.builder ?? ((p, prof) => buildGraph(p, prof, undefined, null, { includeFragmentEdges: true, includeLifecycleEdges: true }));
    this.tokenOf = opts.tokenOf ?? computePhrenLiveStateToken;
    this.frameMs = opts.frameMs ?? 50;
    this.watch = opts.watch ?? new GraphWatch(phrenPath);
    this.watchEnabled = opts.watchEnabled !== false;
    this.agents = opts.agents ?? new GraphAgents(phrenPath, profile);
  }

  // ── Watch mode ──────────────────────────────────────────────────────────

  /** Idempotent; called every render so the tail starts with the view. */
  startWatch(): void {
    if (!this.watchEnabled || this.watch.running) return;
    this.watch.start((items) => this.onWatchEvents(items));
  }

  stopWatch(): void {
    this.watch.stop();
  }

  // ── Agents ──────────────────────────────────────────────────────────────

  /** Idempotent; the poller only runs while the Graph view is open. */
  startAgents(): void {
    if (!this.agents.enabled || this.agents.running) return;
    this.agents.start(() => this.repaintHook?.());
  }

  /**
   * Offer the overlay once per session when agents are actually running but it
   * is switched off. Shipping a feature off by default and never mentioning it
   * is the same as not shipping it.
   */
  agentHint(): string | null {
    if (this.offeredAgents || this.agents.enabled || this.status !== "ready") return null;
    this.offeredAgents = true;
    return this.agents.hasSomethingToShow() ? "agents are running on this machine" : null;
  }
  private offeredAgents = false;

  toggleAgents(): boolean {
    if (this.agents.enabled) {
      this.agents.toggle();
      return false;
    }
    this.agents.enabled = true;
    this.agents.start(() => this.repaintHook?.());
    return true;
  }

  toggleWatch(): boolean {
    this.watchEnabled = !this.watchEnabled;
    if (this.watchEnabled) this.startWatch();
    else this.stopWatch();
    return this.watchEnabled;
  }

  /** True while the user is actively driving, so the camera is left alone. */
  private get userDriving(): boolean {
    return Date.now() - this.lastUserInputAt < 4000;
  }

  /**
   * New events landed. Light every node they touch, then follow the newest
   * one that is actually on screen — unless the user is mid-navigation.
   */
  private onWatchEvents(items: ActivityItem[]): void {
    let followed = false;
    for (let i = items.length - 1; i >= 0 && !followed; i--) {
      const nodeId = items[i].nodeId;
      if (!nodeId || !this.model.nodeById.has(nodeId)) continue;
      this.mascot.walkTo(nodeId, this.positions);
      if (!this.userDriving) {
        this.selectedId = nodeId;
        this.flyTo(nodeId);
      }
      followed = true;
    }
    // Heat decays over several seconds, so keep painting even without a fly.
    this.startAnimation();
    this.repaintHook?.();
  }

  // ── Data ────────────────────────────────────────────────────────────────

  /**
   * Let the shell trigger a repaint on its own (settle animation, fly-to,
   * a build finishing). Without it the controller blocks the first render on
   * the build and snaps every camera move.
   */
  setRepaintHook(hook: (() => void) | null): void {
    this.repaintHook = hook;
  }

  get positions(): Map<string, Point> {
    return this.sim ? this.sim.positions : this.lastPositions;
  }

  private lastToken = "";
  private lastTokenAt = 0;

  /** The store token, re-read at most every 2s: animation repaints must not stat the whole store. */
  private currentToken(): string {
    const now = Date.now();
    if (now - this.lastTokenAt < 2000 && this.lastToken) return this.lastToken;
    try { this.lastToken = this.tokenOf(this.phrenPath); } catch { this.lastToken = `err:${now}`; }
    this.lastTokenAt = now;
    return this.lastToken;
  }

  /**
   * Make sure a payload matching the store is loaded, or on its way. Blocks
   * only on the very first build when there is no repaint hook to come back
   * through; otherwise the old picture stays up with a refreshing badge.
   */
  async ensureData(): Promise<void> {
    this.startWatch();
    this.startAgents();
    const token = this.currentToken();
    if (this.payload && token === this.dataToken) return;
    if (!this.building) {
      if (!this.payload) this.status = "loading";
      this.building = this.build(token).finally(() => { this.building = null; });
    }
    if (!this.payload && !this.repaintHook) await this.building;
  }

  private async build(token: string): Promise<void> {
    try {
      const payload = await this.builder(this.phrenPath, this.profile);
      this.dataToken = token;
      this.adopt(payload);
    } catch (err: unknown) {
      this.errorText = errorMessage(err);
      this.status = "error";
      logger.debug("shell", `graph build failed: ${this.errorText}`);
    } finally {
      this.repaintHook?.();
    }
  }

  /** Load a payload directly (tests, or a host that already has one). */
  adopt(payload: GraphPayload): void {
    this.payload = payload;
    const scores = payload.scores ?? {};
    const storeColors = new StoreColorAssigner();
    const rawNodes = (payload.nodes ?? []).map((node) => normalizeNode(node, scores, (s) => storeColors.color(s)));
    const rawLinks = payload.links ?? [];
    this.model = {
      rawNodes,
      rawLinks,
      nodeById: new Map(rawNodes.map((node) => [node.id, node] as const)),
      fullAdjacency: buildFullAdjacency(rawNodes, rawLinks),
      visibleAdjacency: new Map(),
      scores,
    };
    this.projects = rawNodes.filter((node) => node.kind === "project").sort((a, b) => a.label.localeCompare(b.label));
    if (this.filters.filterProject !== "all" && !this.projects.some((p) => (p.project || p.id) === this.filters.filterProject)) {
      this.filters.filterProject = "all";
    }
    if (this.selectedId && !this.model.nodeById.has(this.selectedId)) this.selectedId = null;
    this.status = rawNodes.length ? "ready" : "empty";
    this.applyFilters(true);
  }

  // ── Filters / layout ────────────────────────────────────────────────────

  get preset(): FilterPreset {
    return FILTER_PRESETS[this.presetIndex] ?? FILTER_PRESETS[0];
  }

  get focusedProject(): string | null {
    return this.filters.filterProject === "all" ? null : this.filters.filterProject;
  }

  private applyFilters(warm: boolean): void {
    this.visible = buildVisibleData(this.model, this.filters, this.selectedId);
    this.model.visibleAdjacency = this.visible.visibleAdjacency;
    const visibleIds = new Set(this.visible.nodes.map((node) => node.id));
    if (this.selectedId && !visibleIds.has(this.selectedId)) this.selectedId = null;
    this.rebuildLayout(warm);
    this.refreshSearch();
  }

  private rebuildLayout(warm: boolean): void {
    if (this.sim) this.lastPositions = new Map([...this.sim.positions].map(([id, p]) => [id, { ...p }]));
    const nodes: LayoutNode[] = this.visible.nodes.map((node) => ({ id: node.id, kind: node.kind, project: node.project, size: node.size }));
    const links: RawLink[] = this.visible.links;
    // The layout is shaped to the canvas so it fills a wide terminal.
    this.sim = new ForceSim(nodes, links, undefined, this.viewport.width / Math.max(1, this.viewport.height));
    if (warm && this.lastPositions.size) this.sim.warmStart(this.lastPositions);
    this.mascot.reset();
    const fresh = !warm || !this.lastPositions.size;
    if (this.repaintHook) {
      this.sim.tick(warm ? 12 : 40);
      if (fresh) { this.fitAll(); this.fitOnSettle = true; }
      this.startAnimation();
    } else {
      this.sim.settle();
      if (fresh) this.fitAll();
    }
  }

  /**
   * The view reports its canvas size (in dots) before projecting. The first
   * fit happens before any frame is drawn, so a size change re-fits unless
   * the user has taken the camera over.
   */
  setViewport(width: number, height: number): void {
    if (width === this.viewport.width && height === this.viewport.height) return;
    this.viewport = { width: Math.max(2, width), height: Math.max(4, height) };
    if (!this.userMoved) { const keepFlag = this.fitOnSettle; this.fitAll(); this.fitOnSettle = keepFlag; }
    else if (this.selectedId) this.keepInView(this.selectedId);
  }

  get viewportSize(): { width: number; height: number } {
    return this.viewport;
  }

  /** World → dot coordinates for the current camera. */
  project(p: Point): Point {
    return {
      x: (p.x - this.camera.cx) * this.camera.scaleX + this.viewport.width / 2,
      y: (p.y - this.camera.cy) * this.camera.scaleY + this.viewport.height / 2,
    };
  }

  fitAll(): void {
    const box = bounds(this.positions.values());
    this.cameraTarget = null;
    this.fitOnSettle = false;
    this.userMoved = false;
    if (!box) { this.camera = { cx: 0, cy: 0, scaleX: 2, scaleY: 2 }; return; }
    const w = Math.max(1, box.maxX - box.minX);
    const h = Math.max(1, box.maxY - box.minY);
    const pad = 0.92;
    let sx = (this.viewport.width * pad) / w;
    let sy = (this.viewport.height * pad) / h;
    // Fill both axes rather than letting the shorter one strand the rest of
    // the screen, but pull the looser axis back in once it would distort.
    if (sx > sy * MAX_STRETCH) sx = sy * MAX_STRETCH;
    else if (sy > sx * MAX_STRETCH) sy = sx * MAX_STRETCH;
    const clamp01 = (v: number) => Math.max(0.2, Math.min(v, 12));
    this.camera = {
      cx: (box.minX + box.maxX) / 2,
      cy: (box.minY + box.maxY) / 2,
      scaleX: clamp01(sx),
      scaleY: clamp01(sy),
    };
  }

  zoom(factor: number): void {
    this.userMoved = true;
    // Both axes move together, so a zoom never changes the shape on screen.
    const clampZoom = (v: number) => Math.max(0.2, Math.min(24, v));
    this.camera.scaleX = clampZoom(this.camera.scaleX * factor);
    this.camera.scaleY = clampZoom(this.camera.scaleY * factor);
  }

  pan(direction: keyof typeof DIRECTIONS): void {
    const d = DIRECTIONS[direction];
    const stepX = (this.viewport.width * 0.12) / this.camera.scaleX;
    const stepY = (this.viewport.height * 0.12) / this.camera.scaleY;
    this.userMoved = true;
    this.cameraTarget = null;
    this.camera.cx += d.x * stepX;
    this.camera.cy += d.y * stepY;
  }

  /** Centre the camera on a node, eased when animation is available. */
  flyTo(nodeId: string): void {
    const p = this.positions.get(nodeId);
    if (!p) return;
    if (this.repaintHook) {
      this.cameraTarget = { x: p.x, y: p.y };
      this.startAnimation();
    } else {
      this.camera.cx = p.x;
      this.camera.cy = p.y;
    }
  }

  /** Fly only when the node sits outside the middle band of the viewport. */
  private keepInView(nodeId: string): void {
    const p = this.positions.get(nodeId);
    if (!p) return;
    const d = this.project(p);
    const { width, height } = this.viewport;
    if (d.x < width * 0.18 || d.x > width * 0.82 || d.y < height * 0.18 || d.y > height * 0.82) this.flyTo(nodeId);
  }

  relayout(): void {
    this.lastPositions = new Map();
    this.cameraTarget = null;
    this.rebuildLayout(false);
    this.fitAll();
  }

  // ── Animation ───────────────────────────────────────────────────────────

  private startAnimation(): void {
    if (this.timer || !this.repaintHook) return;
    this.timer = setInterval(() => this.animationFrame(), this.frameMs);
    this.timer.unref?.();
  }

  stopAnimation(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  get animating(): boolean {
    return this.timer !== null;
  }

  private animationFrame(): void {
    let busy = this.watch.hot;
    if (this.mascot.step()) busy = true;
    if (this.mascot.arrivalGlow() > 0) busy = true;
    if (this.mascot.maybeWander(this.visible.nodes.map((node) => node.id), this.positions)) busy = true;
    if (this.sim && !this.sim.settled) {
      this.sim.tick(3);
      busy = true;
      if (this.sim.settled && this.fitOnSettle && !this.cameraTarget) { this.fitAll(); this.fitOnSettle = false; }
    }
    if (this.cameraTarget) {
      const t = this.cameraTarget;
      this.camera.cx += (t.x - this.camera.cx) * 0.35;
      this.camera.cy += (t.y - this.camera.cy) * 0.35;
      if (Math.abs(t.x - this.camera.cx) < 0.05 && Math.abs(t.y - this.camera.cy) < 0.05) {
        this.camera.cx = t.x;
        this.camera.cy = t.y;
        this.cameraTarget = null;
      } else {
        busy = true;
      }
    }
    if (!busy) this.stopAnimation();
    this.repaintHook?.();
  }

  /** Called by the shell when the view changes away or the shell closes. */
  dispose(): void {
    this.stopAnimation();
    this.stopWatch();
    this.agents.stop();
  }

  // ── Selection / search / focus ──────────────────────────────────────────

  detail(nodeId: string): NodeDetail | null {
    return nodeDetail(this.model, nodeId);
  }

  /** Visible neighbours of a node, best first — what the pane numbers 1-9. */
  neighborsOf(nodeId: string): RuntimeNode[] {
    const ids = this.model.visibleAdjacency.get(nodeId);
    if (!ids) return [];
    const nodes: RuntimeNode[] = [];
    ids.forEach((id) => { const node = this.model.nodeById.get(id); if (node) nodes.push(node); });
    return nodes.sort((a, b) => nodeRank(b, this.filters, this.model.scores) - nodeRank(a, this.filters, this.model.scores));
  }

  select(nodeId: string | null, opts: { fly?: boolean } = {}): void {
    this.selectedId = nodeId;
    if (nodeId) {
      this.mascot.walkTo(nodeId, this.positions);
      if (opts.fly) this.flyTo(nodeId);
      else this.keepInView(nodeId);
    }
  }

  private nearestToCenter(): RuntimeNode | null {
    let best: RuntimeNode | null = null;
    let bestDist = Infinity;
    const center = { x: this.viewport.width / 2, y: this.viewport.height / 2 };
    for (const node of this.visible.nodes) {
      const p = this.positions.get(node.id);
      if (!p) continue;
      const d = this.project(p);
      const dist = (d.x - center.x) ** 2 + (d.y - center.y) ** 2;
      if (dist < bestDist) { bestDist = dist; best = node; }
    }
    return best;
  }

  /**
   * Arrow-key traversal: prefer a connected neighbour in that direction; if
   * there is none, take the nearest visible node in that half-plane so the
   * walk never dead-ends on a leaf.
   */
  walk(direction: keyof typeof DIRECTIONS): RuntimeNode | null {
    if (!this.selectedId) {
      const start = this.nearestToCenter();
      if (start) this.select(start.id);
      return start;
    }
    const from = this.positions.get(this.selectedId);
    if (!from) return null;
    const dir = DIRECTIONS[direction];
    const pick = (candidates: Iterable<string>, minCos: number): { id: string; score: number } | null => {
      let best: { id: string; score: number } | null = null;
      for (const id of candidates) {
        if (id === this.selectedId) continue;
        const p = this.positions.get(id);
        if (!p) continue;
        const dx = p.x - from.x;
        const dy = p.y - from.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len === 0) continue;
        const cos = (dx * dir.x + dy * dir.y) / len;
        if (cos <= minCos) continue;
        const score = len / Math.max(cos, 0.15);
        if (!best || score < best.score) best = { id, score };
      }
      return best;
    };
    const neighbors = this.model.visibleAdjacency.get(this.selectedId) ?? new Set<string>();
    const target = pick(neighbors, 0.1) ?? pick(this.visible.nodes.map((node) => node.id), 0.3);
    if (!target) return null;
    this.select(target.id);
    return this.model.nodeById.get(target.id) ?? null;
  }

  private refreshSearch(): void {
    const matches = recomputeSearchMatches(this.visible.nodes, this.search.query, this.filters, this.model.scores);
    this.search.matchIds = matches.matchIds;
    this.search.results = matches.results;
    if (this.search.index >= matches.results.length) this.search.index = matches.results.length ? 0 : -1;
  }

  /** Set the query, light up matches, and fly to the best one. */
  applySearch(query: string): RuntimeNode | null {
    this.search.query = query.trim();
    this.filters.searchQuery = this.search.query;
    this.refreshSearch();
    if (!this.search.query) { this.search.index = -1; return null; }
    const best = bestSearchMatch(this.search.results);
    this.search.index = best ? 0 : -1;
    if (best) this.select(best.id, { fly: true });
    return best;
  }

  clearSearch(): void {
    this.applySearch("");
  }

  stepSearch(delta: number): RuntimeNode | null {
    const results = this.search.results;
    if (!results.length) return null;
    this.search.index = ((this.search.index + delta) % results.length + results.length) % results.length;
    const node = results[this.search.index];
    this.select(node.id, { fly: true });
    return node;
  }

  cyclePreset(delta = 1): FilterPreset {
    this.presetIndex = ((this.presetIndex + delta) % FILTER_PRESETS.length + FILTER_PRESETS.length) % FILTER_PRESETS.length;
    const preset = this.preset;
    this.filters.filterTypes = { ...preset.types };
    this.filters.filterHealth = preset.health;
    this.applyFilters(true);
    return preset;
  }

  /** Focus one project (name) or all (null). */
  focusProject(name: string | null): void {
    this.filters.filterProject = name ?? "all";
    this.applyFilters(true);
    // Either way the visible set just changed shape: frame it, then keep the
    // project selected so its neighbours are numbered.
    this.cameraTarget = null;
    this.fitAll();
    if (name) {
      const node = this.projects.find((p) => (p.project || p.id) === name);
      if (node) this.selectedId = node.id;
    }
  }

  cycleProject(delta: number): string | null {
    if (!this.projects.length) return null;
    const names = this.projects.map((p) => p.project || p.id);
    const current = this.focusedProject ? names.indexOf(this.focusedProject) : -1;
    // Slot -1 is "all projects"; the cycle runs all → first … last → all.
    const slots = names.length + 1;
    const next = (((current + 1 + delta) % slots) + slots) % slots - 1;
    const name = next < 0 ? null : names[next];
    this.focusProject(name);
    return name;
  }

  jumpToNeighbor(n: number): RuntimeNode | null {
    if (!this.selectedId) return null;
    const node = this.neighborsOf(this.selectedId)[n - 1];
    if (!node) return null;
    this.select(node.id);
    return node;
  }

  // ── Keys ────────────────────────────────────────────────────────────────

  /**
   * Returns true when the key was consumed, undefined to let the shell's
   * generic handler have it (q, :, ?, view shortcuts, final Esc).
   */
  handleKey(rawKey: string, host: GraphKeyHost): true | undefined {
    const key = normalizeArrow(rawKey);
    if (key !== "w" && key !== "W") this.lastUserInputAt = Date.now();
    if (this.status !== "ready") {
      if (key === "r") { this.dataToken = ""; host.setMessage("  Rebuilding graph…"); return true; }
      return undefined;
    }
    const arrow = ARROW_DIRECTION[key];
    if (arrow) {
      const node = this.walk(arrow);
      host.setMessage(node ? this.describe(node) : `  ${style.dim("nothing further that way")}`);
      return true;
    }
    const shifted = SHIFT_ARROW_DIRECTION[key] ?? PAN_LETTER_DIRECTION[key];
    if (shifted) { this.pan(shifted); return true; }
    if (key === "+" || key === "=") { this.zoom(1.25); return true; }
    if (key === "-" || key === "_") { this.zoom(1 / 1.25); return true; }
    if (key === "0") { this.fitAll(); host.setMessage(`  ${style.dim("fit to screen")}`); return true; }
    if (key === "r") { this.relayout(); host.setMessage(`  ${style.dim("re-laid out")}`); return true; }
    if (key === "\r" || key === "\n") {
      // A highlighted agent takes the Enter: bring it to the front.
      const highlighted = this.agents.current;
      if (highlighted) {
        const focused = this.agents.focusCurrent();
        host.setMessage(focused
          ? `  ${style.boldCyan("→")} ${focused.label}`
          : `  ${style.dim(highlighted.focus?.length ? "could not focus that agent" : "this agent's host cannot be focused")}`);
        return true;
      }
      if (!this.selectedId) {
        const node = this.nearestToCenter();
        if (node) { this.select(node.id); host.setMessage(this.describe(node)); }
        return true;
      }
      const node = this.model.nodeById.get(this.selectedId);
      if (node?.kind === "project") {
        const name = node.project || node.id;
        const next = this.focusedProject === name ? null : name;
        this.focusProject(next);
        host.setMessage(next ? `  ${style.boldCyan("❖")} ${style.boldCyan(next)}  ${style.dim("focused — ↵ again to release")}` : `  ${style.dim("all projects")}`);
      } else if (node) {
        this.flyTo(node.id);
        host.setMessage(this.describe(node));
      }
      return true;
    }
    if (/^[1-9]$/.test(key)) {
      const node = this.jumpToNeighbor(Number(key));
      if (node) host.setMessage(this.describe(node));
      else host.setMessage(`  ${style.dim(this.selectedId ? "no such neighbour" : "select a node first (↵)")}`);
      return true;
    }
    if (key === "/") { host.startInput("graph-search", this.search.query); return true; }
    if (key === "n" || key === "N") {
      const node = this.stepSearch(key === "n" ? 1 : -1);
      host.setMessage(node
        ? `  ${style.yellow(`${this.search.index + 1}/${this.search.results.length}`)}  ${this.describe(node).trimStart()}`
        : `  ${style.dim("no search — press / first")}`);
      return true;
    }
    if (key === "f") {
      const preset = this.cyclePreset(1);
      host.setMessage(`  ${style.boldCyan("filter")} ${preset.name}  ${style.dim(`${this.visible.nodes.length} nodes`)}`);
      return true;
    }
    if (key === "F") {
      const preset = this.cyclePreset(-1);
      host.setMessage(`  ${style.boldCyan("filter")} ${preset.name}  ${style.dim(`${this.visible.nodes.length} nodes`)}`);
      return true;
    }
    if (key === "]" || key === "[") {
      const name = this.cycleProject(key === "]" ? 1 : -1);
      host.setMessage(name ? `  ${style.boldCyan("❖")} ${style.boldCyan(name)}` : `  ${style.dim("all projects")}`);
      return true;
    }
    if (key === "a" || key === "A") {
      const on = this.toggleAgents();
      host.setMessage(on
        ? `  ${style.boldCyan("◉ agents")} ${style.dim(`— ${this.agents.agents.length} running  ·  tab to cycle, ↵ to focus`)}`
        : `  ${style.dim("agents off")}`);
      return true;
    }
    if (key === "\t" || key === "\x1b[Z") {
      if (!this.agents.enabled || !this.agents.agents.length) return undefined;
      const agent = this.agents.cycle(key === "\t" ? 1 : -1);
      if (agent) {
        if (agent.project && this.model.nodeById.has(agent.project)) this.select(agent.project, { fly: true });
        host.setMessage(`  ${style.boldCyan(agent.label)}  ${style.dim(`${agent.status}${agent.project ? ` · ${agent.project}` : " · outside phren"}`)}`);
      }
      return true;
    }
    if (key === "w" || key === "W") {
      const on = this.toggleWatch();
      host.setMessage(on
        ? `  ${style.boldCyan("◉ watching")} ${style.dim("— lighting up what phren touches, anywhere on this machine")}`
        : `  ${style.dim("watch off")}`);
      return true;
    }
    if (key === "o") {
      host.setMessage(`  ${style.dim("open the 3D viewer in a browser:")} ${style.boldCyan("phren web-ui")}`);
      return true;
    }
    if (key === "\x1b") {
      if (this.agents.current) { this.agents.clearHighlight(); host.setMessage(`  ${style.dim("agent released")}`); return true; }
      if (this.search.query) { this.clearSearch(); host.setMessage(`  ${style.dim("search cleared")}`); return true; }
      if (this.selectedId) { this.select(null); host.setMessage(`  ${style.dim("selection cleared")}`); return true; }
      if (this.focusedProject) { this.focusProject(null); host.setMessage(`  ${style.dim("all projects")}`); return true; }
      return undefined;
    }
    return undefined;
  }

  /** One-line description for the message bar. */
  describe(node: RuntimeNode): string {
    const label = node.fullLabel || node.label;
    const short = label.length > 70 ? `${label.slice(0, 68)}…` : label;
    const where = node.project && node.kind !== "project" ? `  ${style.dim("·")} ${style.cyan(node.project)}` : "";
    return `  ${style.dim(node.kind)} ${short}${where}`;
  }
}

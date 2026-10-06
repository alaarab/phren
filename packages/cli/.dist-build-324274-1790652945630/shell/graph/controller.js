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
import { StoreColorAssigner, bestSearchMatch, buildFullAdjacency, buildVisibleData, nodeDetail, nodeRank, normalizeNode, recomputeSearchMatches, } from "../../graph-core/model.js";
import { errorMessage } from "../../utils.js";
import { logger } from "../../logger.js";
import { style } from "../render.js";
import { ForceSim, bounds } from "./layout.js";
import { GraphWatch } from "./watch.js";
import { GraphAgents } from "./agents.js";
import { GraphMascot } from "./mascot.js";
import { LIVE_BUBBLE_MS } from "./bubble.js";
import { readKnowsBlock } from "../../content/summarize.js";
import { DEFAULT_ORBIT, PITCH_LIMIT, buildOrbitLayout, parseMouse, projectOrbit, yawDelta, yawToFace } from "./orbit.js";
/** Left alone in orbit for this long, the sphere starts turning on its own. */
const IDLE_SPIN_MS = 6000;
/** Nodes drawn at once. Terminals have far fewer pixels than a browser tab. */
export const TUI_NODE_LIMIT = 350;
const ALL_TYPES = { project: true, finding: true, task: true, entity: true, reference: true };
export const FILTER_PRESETS = [
    { name: "all", types: ALL_TYPES, health: "all" },
    { name: "findings", types: { project: true, finding: true }, health: "all" },
    { name: "tasks", types: { project: true, task: true }, health: "all" },
    { name: "fragments", types: { project: true, entity: true, reference: true }, health: "all" },
    { name: "aging", types: ALL_TYPES, health: "aging" },
];
/** How far the x and y scales may diverge when filling the canvas. */
const MAX_STRETCH = 2.2;
const DIRECTIONS = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
};
function normalizeArrow(rawKey) {
    return /^\x1bO[A-D]$/.test(rawKey) ? `\x1b[${rawKey[2]}` : rawKey;
}
const ARROW_DIRECTION = {
    "\x1b[A": "up",
    "\x1b[B": "down",
    "\x1b[D": "left",
    "\x1b[C": "right",
};
/** Shift+arrow in the CSI 1;2 form most terminals emit. */
const SHIFT_ARROW_DIRECTION = {
    "\x1b[1;2A": "up",
    "\x1b[1;2B": "down",
    "\x1b[1;2D": "left",
    "\x1b[1;2C": "right",
};
const PAN_LETTER_DIRECTION = { K: "up", J: "down", H: "left", L: "right" };
export class GraphController {
    phrenPath;
    profile;
    status = "idle";
    errorText = "";
    /** A rebuild is running while the previous picture stays on screen. */
    get refreshing() { return this.building !== null && this.payload !== null; }
    payload = null;
    model = { rawNodes: [], rawLinks: [], nodeById: new Map(), fullAdjacency: new Map(), visibleAdjacency: new Map(), scores: {} };
    filters = {
        filterTypes: { ...ALL_TYPES },
        filterTopics: {},
        filterHealth: "all",
        filterProject: "all",
        filterStore: "all",
        searchQuery: "",
        nodeLimit: TUI_NODE_LIMIT,
    };
    visible = { nodes: [], links: [], visibleAdjacency: new Map() };
    /** Project nodes in display order for `[`/`]`. */
    projects = [];
    presetIndex = 0;
    selectedId = null;
    search = { query: "", matchIds: new Set(), results: [], index: -1 };
    camera = { cx: 0, cy: 0, scaleX: 2, scaleY: 2 };
    sim = null;
    lastPositions = new Map();
    viewport = { width: 160, height: 80 };
    dataToken = "";
    building = null;
    repaintHook = null;
    timer = null;
    cameraTarget = null;
    /** Re-frame once the intro settle finishes so the whole map is in view. */
    /** Set by pan/zoom; until then a resize re-fits the whole map. */
    userMoved = false;
    builder;
    tokenOf;
    frameMs;
    /** Live tail of what phren is landing on, in this or any other terminal. */
    watch;
    /** Coding agents running on this machine, joined onto their projects. */
    agents;
    /** phren himself, who walks to whatever the store just touched. */
    mascot = new GraphMascot();
    /** Space opens the selected node's full text in a bubble on the canvas. */
    reader = false;
    knowsCache = new Map();
    /**
     * The "What phren knows" paragraph for a project, written by
     * `phren maintain summarize`; null until it has run. Read once per project
     * per data load, so the pane can show it on every frame.
     */
    knowsFor(project) {
        if (!this.knowsCache.has(project)) {
            let text = null;
            try {
                text = readKnowsBlock(this.phrenPath, project)?.text.replace(/^## What phren knows\s*/m, "").trim() ?? null;
            }
            catch {
                text = null;
            }
            this.knowsCache.set(project, text);
        }
        return this.knowsCache.get(project) ?? null;
    }
    /**
     * v: the same graph as a sphere. Selection, search, watch mode and the
     * neighbour numbers all keep working; the camera orbits instead of panning.
     */
    orbit = false;
    orbitCamera = { ...DEFAULT_ORBIT };
    orbitPositions = new Map();
    orbitRadius = 1;
    orbitYawTarget = null;
    lastOrbitTouch = 0;
    drag = null;
    /** Where the canvas sits in the terminal, so mouse coordinates can be mapped onto it. */
    canvasOrigin = { col: 0, row: 2 };
    watchEnabled;
    /**
     * Wall-clock ms of the last navigation keypress. While the user is driving,
     * incoming events still pulse and feed but do not steal the camera.
     */
    lastUserInputAt = 0;
    constructor(phrenPath, profile, opts = {}) {
        this.phrenPath = phrenPath;
        this.profile = profile;
        this.builder = opts.builder ?? ((p, prof) => buildGraph(p, prof, undefined, null, { includeFragmentEdges: true, includeLifecycleEdges: true }));
        this.tokenOf = opts.tokenOf ?? computePhrenLiveStateToken;
        this.frameMs = opts.frameMs ?? 50;
        this.watch = opts.watch ?? new GraphWatch(phrenPath);
        this.watchEnabled = opts.watchEnabled !== false;
        this.agents = opts.agents ?? new GraphAgents(phrenPath, profile);
    }
    // ── Watch mode ──────────────────────────────────────────────────────────
    /** Idempotent; called every render so the tail starts with the view. */
    startWatch() {
        if (!this.watchEnabled || this.watch.running)
            return;
        this.watch.start((items) => this.onWatchEvents(items));
    }
    stopWatch() {
        this.watch.stop();
    }
    // ── Agents ──────────────────────────────────────────────────────────────
    /** Idempotent; the poller only runs while the Graph view is open. */
    startAgents() {
        if (!this.agents.enabled || this.agents.running)
            return;
        this.agents.start(() => this.repaintHook?.());
    }
    /**
     * The recall that just landed, while it is still fresh enough to show at its
     * node. Watch mode's feed lists everything; this is the one worth pointing at.
     */
    liveRecall(now = Date.now()) {
        if (!this.watchEnabled || !this.watch.running)
            return null;
        for (const item of this.watch.activity) {
            if (item.historical || !item.nodeId)
                continue;
            const age = now - item.seenAt;
            if (age > LIVE_BUBBLE_MS)
                return null;
            if (!this.positions.has(item.nodeId))
                return null;
            return { nodeId: item.nodeId, item, age };
        }
        return null;
    }
    /**
     * Offer the overlay once per session when agents are actually running but it
     * is switched off. Shipping a feature off by default and never mentioning it
     * is the same as not shipping it.
     */
    agentHint() {
        if (this.offeredAgents || this.agents.enabled || this.status !== "ready")
            return null;
        this.offeredAgents = true;
        return this.agents.hasSomethingToShow() ? "agents are running on this machine" : null;
    }
    offeredAgents = false;
    toggleAgents() {
        if (this.agents.enabled) {
            this.agents.toggle();
            return false;
        }
        this.agents.enabled = true;
        this.agents.start(() => this.repaintHook?.());
        return true;
    }
    toggleWatch() {
        this.watchEnabled = !this.watchEnabled;
        if (this.watchEnabled)
            this.startWatch();
        else
            this.stopWatch();
        return this.watchEnabled;
    }
    /** True while the user is actively driving, so the camera is left alone. */
    get userDriving() {
        return Date.now() - this.lastUserInputAt < 4000;
    }
    /**
     * New events landed. Light every node they touch, then follow the newest
     * one that is actually on screen — unless the user is mid-navigation.
     */
    onWatchEvents(items) {
        let followed = false;
        for (let i = items.length - 1; i >= 0 && !followed; i--) {
            const nodeId = items[i].nodeId;
            if (!nodeId || !this.model.nodeById.has(nodeId))
                continue;
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
    setRepaintHook(hook) {
        this.repaintHook = hook;
    }
    get positions() {
        return this.sim ? this.sim.positions : this.lastPositions;
    }
    lastToken = "";
    lastTokenAt = 0;
    /** The store token, re-read at most every 2s: animation repaints must not stat the whole store. */
    currentToken() {
        const now = Date.now();
        if (now - this.lastTokenAt < 2000 && this.lastToken)
            return this.lastToken;
        try {
            this.lastToken = this.tokenOf(this.phrenPath);
        }
        catch {
            this.lastToken = `err:${now}`;
        }
        this.lastTokenAt = now;
        return this.lastToken;
    }
    /**
     * Make sure a payload matching the store is loaded, or on its way. Blocks
     * only on the very first build when there is no repaint hook to come back
     * through; otherwise the old picture stays up with a refreshing badge.
     */
    async ensureData() {
        this.startWatch();
        this.startAgents();
        const token = this.currentToken();
        if (this.payload && token === this.dataToken)
            return;
        if (!this.building) {
            if (!this.payload)
                this.status = "loading";
            this.building = this.build(token).finally(() => { this.building = null; });
        }
        if (!this.payload && !this.repaintHook)
            await this.building;
    }
    async build(token) {
        try {
            const payload = await this.builder(this.phrenPath, this.profile);
            this.dataToken = token;
            this.adopt(payload);
        }
        catch (err) {
            this.errorText = errorMessage(err);
            this.status = "error";
            logger.debug("shell", `graph build failed: ${this.errorText}`);
        }
        finally {
            this.repaintHook?.();
        }
    }
    /** Load a payload directly (tests, or a host that already has one). */
    adopt(payload) {
        this.payload = payload;
        const scores = payload.scores ?? {};
        const storeColors = new StoreColorAssigner();
        const rawNodes = (payload.nodes ?? []).map((node) => normalizeNode(node, scores, (s) => storeColors.color(s)));
        const rawLinks = payload.links ?? [];
        this.model = {
            rawNodes,
            rawLinks,
            nodeById: new Map(rawNodes.map((node) => [node.id, node])),
            fullAdjacency: buildFullAdjacency(rawNodes, rawLinks),
            visibleAdjacency: new Map(),
            scores,
        };
        this.projects = rawNodes.filter((node) => node.kind === "project").sort((a, b) => a.label.localeCompare(b.label));
        if (this.filters.filterProject !== "all" && !this.projects.some((p) => (p.project || p.id) === this.filters.filterProject)) {
            this.filters.filterProject = "all";
        }
        if (this.selectedId && !this.model.nodeById.has(this.selectedId))
            this.selectedId = null;
        this.status = rawNodes.length ? "ready" : "empty";
        this.applyFilters(true);
    }
    // ── Filters / layout ────────────────────────────────────────────────────
    get preset() {
        return FILTER_PRESETS[this.presetIndex] ?? FILTER_PRESETS[0];
    }
    get focusedProject() {
        return this.filters.filterProject === "all" ? null : this.filters.filterProject;
    }
    applyFilters(warm) {
        this.visible = buildVisibleData(this.model, this.filters, this.selectedId);
        this.model.visibleAdjacency = this.visible.visibleAdjacency;
        const visibleIds = new Set(this.visible.nodes.map((node) => node.id));
        if (this.selectedId && !visibleIds.has(this.selectedId))
            this.selectedId = null;
        this.rebuildLayout(warm);
        this.refreshSearch();
    }
    rebuildLayout(warm) {
        if (this.sim)
            this.lastPositions = new Map([...this.sim.positions].map(([id, p]) => [id, { ...p }]));
        const nodes = this.visible.nodes.map((node) => ({ id: node.id, kind: node.kind, project: node.project, size: node.size }));
        const links = this.visible.links;
        // The layout is shaped to the canvas so it fills a wide terminal.
        this.sim = new ForceSim(nodes, links, undefined, this.viewport.width / Math.max(1, this.viewport.height));
        if (warm && this.lastPositions.size)
            this.sim.warmStart(this.lastPositions);
        this.mascot.reset();
        this.knowsCache.clear();
        // Settle before anyone sees it. Animating the relaxation instead — ticking
        // a few steps, framing the half-settled positions, then letting the rest
        // play out under a fixed camera — read as the whole cluster bouncing for a
        // second every time a project came into focus. A layout change is a cut,
        // not a motion; the camera flights are the only thing meant to move. It
        // is cheap enough not to notice: under 10ms for a couple of hundred nodes,
        // and the focused subset that [ ] shows is far smaller than that.
        this.sim.settle();
        this.rebuildOrbit();
        if (!warm || !this.lastPositions.size)
            this.fitAll();
        // One frame through the loop repaints, then it stops itself unless the
        // mascot, a flight or watch mode has something to show.
        if (this.repaintHook)
            this.startAnimation();
    }
    /**
     * The view reports its canvas size (in dots) before projecting. The first
     * fit happens before any frame is drawn, so a size change re-fits unless
     * the user has taken the camera over.
     */
    setViewport(width, height) {
        if (width === this.viewport.width && height === this.viewport.height)
            return;
        this.viewport = { width: Math.max(2, width), height: Math.max(4, height) };
        if (!this.userMoved)
            this.fitAll();
        else if (this.selectedId)
            this.keepInView(this.selectedId);
    }
    get viewportSize() {
        return this.viewport;
    }
    /** The sphere is derived from the settled flat layout, never simulated. */
    rebuildOrbit() {
        const nodes = this.visible.nodes.map((node) => ({ id: node.id, kind: node.kind, project: node.project, size: node.size }));
        const built = buildOrbitLayout(nodes, this.visible.links, this.positions);
        this.orbitPositions = built.positions;
        this.orbitRadius = built.radius;
    }
    /** A node's place on screen, with depth: 0 nearest, 1 farthest, always 0 on the flat map. */
    projectNode(id) {
        if (this.orbit) {
            const v = this.orbitPositions.get(id);
            return v ? projectOrbit(v, this.orbitCamera, this.viewport, this.orbitRadius) : null;
        }
        const p = this.positions.get(id);
        return p ? { ...this.project(p), t: 0 } : null;
    }
    toggleOrbit() {
        this.orbit = !this.orbit;
        this.drag = null;
        this.orbitYawTarget = null;
        this.lastOrbitTouch = Date.now();
        if (this.orbit) {
            this.orbitCamera = { ...DEFAULT_ORBIT };
            if (this.selectedId)
                this.flyTo(this.selectedId);
            if (this.repaintHook)
                this.startAnimation();
        }
        return this.orbit;
    }
    /** In orbit, the pan keys turn the sphere instead. */
    turn(direction) {
        const d = DIRECTIONS[direction];
        this.orbitCamera.yaw += d.x * 0.12;
        this.orbitCamera.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.orbitCamera.pitch + d.y * 0.08));
        this.orbitYawTarget = null;
        this.lastOrbitTouch = Date.now();
    }
    /** The visible node nearest a dot on the canvas, within a radius. */
    nearestToDot(x, y, within) {
        let best = null;
        let bestDistance = within;
        for (const node of this.visible.nodes) {
            const d = this.projectNode(node.id);
            if (!d)
                continue;
            // A project marker has findings packed right up against it; a click on
            // the marker means the project, so it wins a few dots of slack.
            const distance = Math.hypot(d.x - x, d.y - y) - (node.kind === "project" ? 4 : 0);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = node;
            }
        }
        return best;
    }
    /**
     * Mouse: wheel zooms in both modes; a left drag turns the sphere or pans
     * the map; a click with no movement selects the node under it.
     */
    handleMouse(m, host) {
        if (m.type === "wheel") {
            this.zoom(m.delta < 0 ? 1.15 : 1 / 1.15);
            return true;
        }
        if (m.type === "press") {
            if (m.button === 0)
                this.drag = { col: m.col, row: m.row, moved: false };
            return true;
        }
        if (m.type === "drag") {
            if (!this.drag)
                return true;
            const dx = m.col - this.drag.col;
            const dy = m.row - this.drag.row;
            if (dx === 0 && dy === 0)
                return true;
            this.drag = { col: m.col, row: m.row, moved: true };
            if (this.orbit) {
                this.orbitCamera.yaw += dx * 0.035;
                this.orbitCamera.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.orbitCamera.pitch + dy * 0.06));
                this.orbitYawTarget = null;
                this.lastOrbitTouch = Date.now();
            }
            else {
                this.userMoved = true;
                this.cameraTarget = null;
                this.camera.cx -= (dx * 2) / this.camera.scaleX;
                this.camera.cy -= (dy * 4) / this.camera.scaleY;
            }
            return true;
        }
        const wasClick = this.drag !== null && !this.drag.moved;
        this.drag = null;
        if (wasClick) {
            const x = (m.col - this.canvasOrigin.col) * 2 + 1;
            const y = (m.row - this.canvasOrigin.row) * 4 + 2;
            const node = this.nearestToDot(x, y, 12);
            if (node) {
                this.select(node.id);
                host.setMessage(this.describe(node));
            }
        }
        return true;
    }
    /** World → dot coordinates for the current camera. */
    project(p) {
        return {
            x: (p.x - this.camera.cx) * this.camera.scaleX + this.viewport.width / 2,
            y: (p.y - this.camera.cy) * this.camera.scaleY + this.viewport.height / 2,
        };
    }
    fitAll() {
        if (this.orbit) {
            this.orbitCamera.zoom = 1;
            this.orbitCamera.pitch = DEFAULT_ORBIT.pitch;
            this.lastOrbitTouch = Date.now();
        }
        const box = bounds(this.positions.values());
        this.cameraTarget = null;
        this.userMoved = false;
        if (!box) {
            this.camera = { cx: 0, cy: 0, scaleX: 2, scaleY: 2 };
            return;
        }
        const w = Math.max(1, box.maxX - box.minX);
        const h = Math.max(1, box.maxY - box.minY);
        const pad = 0.92;
        let sx = (this.viewport.width * pad) / w;
        let sy = (this.viewport.height * pad) / h;
        // Fill both axes rather than letting the shorter one strand the rest of
        // the screen, but pull the looser axis back in once it would distort.
        if (sx > sy * MAX_STRETCH)
            sx = sy * MAX_STRETCH;
        else if (sy > sx * MAX_STRETCH)
            sy = sx * MAX_STRETCH;
        const clamp01 = (v) => Math.max(0.2, Math.min(v, 12));
        this.camera = {
            cx: (box.minX + box.maxX) / 2,
            cy: (box.minY + box.maxY) / 2,
            scaleX: clamp01(sx),
            scaleY: clamp01(sy),
        };
    }
    zoom(factor) {
        if (this.orbit) {
            this.orbitCamera.zoom = Math.max(0.4, Math.min(4, this.orbitCamera.zoom * factor));
            this.lastOrbitTouch = Date.now();
            return;
        }
        this.userMoved = true;
        // Both axes move together, so a zoom never changes the shape on screen.
        const clampZoom = (v) => Math.max(0.2, Math.min(24, v));
        this.camera.scaleX = clampZoom(this.camera.scaleX * factor);
        this.camera.scaleY = clampZoom(this.camera.scaleY * factor);
    }
    pan(direction) {
        if (this.orbit) {
            this.turn(direction);
            return;
        }
        const d = DIRECTIONS[direction];
        const stepX = (this.viewport.width * 0.12) / this.camera.scaleX;
        const stepY = (this.viewport.height * 0.12) / this.camera.scaleY;
        this.userMoved = true;
        this.cameraTarget = null;
        this.camera.cx += d.x * stepX;
        this.camera.cy += d.y * stepY;
    }
    /** Centre the camera on a node, eased when animation is available. */
    flyTo(nodeId) {
        if (this.orbit) {
            // Turn the sphere so the node faces you, eased like a flight.
            const v = this.orbitPositions.get(nodeId);
            if (!v)
                return;
            this.orbitYawTarget = yawToFace(v);
            if (this.repaintHook)
                this.startAnimation();
            else {
                this.orbitCamera.yaw = this.orbitYawTarget;
                this.orbitYawTarget = null;
            }
            return;
        }
        const p = this.positions.get(nodeId);
        if (!p)
            return;
        if (this.repaintHook) {
            this.cameraTarget = { x: p.x, y: p.y };
            this.startAnimation();
        }
        else {
            this.camera.cx = p.x;
            this.camera.cy = p.y;
        }
    }
    /** Fly only when the node sits outside the middle band of the viewport. */
    keepInView(nodeId) {
        if (this.orbit) {
            this.flyTo(nodeId);
            return;
        }
        const p = this.positions.get(nodeId);
        if (!p)
            return;
        const d = this.project(p);
        const { width, height } = this.viewport;
        if (d.x < width * 0.18 || d.x > width * 0.82 || d.y < height * 0.18 || d.y > height * 0.82)
            this.flyTo(nodeId);
    }
    relayout() {
        this.lastPositions = new Map();
        this.cameraTarget = null;
        this.rebuildLayout(false);
        this.fitAll();
    }
    // ── Animation ───────────────────────────────────────────────────────────
    startAnimation() {
        if (this.timer || !this.repaintHook)
            return;
        this.timer = setInterval(() => this.animationFrame(), this.frameMs);
        this.timer.unref?.();
    }
    stopAnimation() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    get animating() {
        return this.timer !== null;
    }
    animationFrame() {
        let busy = this.watch.hot;
        if (this.orbit) {
            if (this.orbitYawTarget !== null) {
                const d = yawDelta(this.orbitCamera.yaw, this.orbitYawTarget);
                if (Math.abs(d) < 0.01) {
                    this.orbitCamera.yaw = this.orbitYawTarget;
                    this.orbitYawTarget = null;
                }
                else
                    this.orbitCamera.yaw += d * 0.25;
            }
            else if (!this.drag && Date.now() - this.lastOrbitTouch > IDLE_SPIN_MS) {
                // Left alone, it turns slowly, so the depth is always there to see.
                this.orbitCamera.yaw += 0.005;
            }
            // The loop stays alive in orbit so the idle spin can start on its own.
            busy = true;
        }
        if (this.liveRecall())
            busy = true;
        if (this.mascot.step())
            busy = true;
        if (this.mascot.arrivalGlow() > 0)
            busy = true;
        if (this.mascot.maybeWander(this.visible.nodes.map((node) => node.id), this.positions))
            busy = true;
        // Only a graph too large to settle within the tick budget gets here; it
        // finishes relaxing quietly under whatever camera it was given.
        if (this.sim && !this.sim.settled) {
            this.sim.tick(3);
            busy = true;
        }
        if (this.cameraTarget) {
            const t = this.cameraTarget;
            this.camera.cx += (t.x - this.camera.cx) * 0.35;
            this.camera.cy += (t.y - this.camera.cy) * 0.35;
            if (Math.abs(t.x - this.camera.cx) < 0.05 && Math.abs(t.y - this.camera.cy) < 0.05) {
                this.camera.cx = t.x;
                this.camera.cy = t.y;
                this.cameraTarget = null;
            }
            else {
                busy = true;
            }
        }
        if (!busy)
            this.stopAnimation();
        this.repaintHook?.();
    }
    /** Called by the shell when the view changes away or the shell closes. */
    dispose() {
        this.stopAnimation();
        this.stopWatch();
        this.agents.stop();
    }
    // ── Selection / search / focus ──────────────────────────────────────────
    detail(nodeId) {
        return nodeDetail(this.model, nodeId);
    }
    /** Visible neighbours of a node, best first — what the pane numbers 1-9. */
    neighborsOf(nodeId) {
        const ids = this.model.visibleAdjacency.get(nodeId);
        if (!ids)
            return [];
        const nodes = [];
        ids.forEach((id) => { const node = this.model.nodeById.get(id); if (node)
            nodes.push(node); });
        return nodes.sort((a, b) => nodeRank(b, this.filters, this.model.scores) - nodeRank(a, this.filters, this.model.scores));
    }
    select(nodeId, opts = {}) {
        if (nodeId !== this.selectedId)
            this.reader = false;
        this.selectedId = nodeId;
        if (nodeId) {
            this.mascot.walkTo(nodeId, this.positions);
            if (opts.fly)
                this.flyTo(nodeId);
            else
                this.keepInView(nodeId);
        }
    }
    nearestToCenter() {
        let best = null;
        let bestDist = Infinity;
        const center = { x: this.viewport.width / 2, y: this.viewport.height / 2 };
        for (const node of this.visible.nodes) {
            const p = this.positions.get(node.id);
            if (!p)
                continue;
            const d = this.project(p);
            const dist = (d.x - center.x) ** 2 + (d.y - center.y) ** 2;
            if (dist < bestDist) {
                bestDist = dist;
                best = node;
            }
        }
        return best;
    }
    /**
     * Arrow-key traversal: prefer a connected neighbour in that direction; if
     * there is none, take the nearest visible node in that half-plane so the
     * walk never dead-ends on a leaf.
     */
    walk(direction) {
        if (!this.selectedId) {
            const start = this.nearestToCenter();
            if (start)
                this.select(start.id);
            return start;
        }
        const from = this.positions.get(this.selectedId);
        if (!from)
            return null;
        const dir = DIRECTIONS[direction];
        const pick = (candidates, minCos) => {
            let best = null;
            for (const id of candidates) {
                if (id === this.selectedId)
                    continue;
                const p = this.positions.get(id);
                if (!p)
                    continue;
                const dx = p.x - from.x;
                const dy = p.y - from.y;
                const len = Math.sqrt(dx * dx + dy * dy);
                if (len === 0)
                    continue;
                const cos = (dx * dir.x + dy * dir.y) / len;
                if (cos <= minCos)
                    continue;
                const score = len / Math.max(cos, 0.15);
                if (!best || score < best.score)
                    best = { id, score };
            }
            return best;
        };
        const neighbors = this.model.visibleAdjacency.get(this.selectedId) ?? new Set();
        const target = pick(neighbors, 0.1) ?? pick(this.visible.nodes.map((node) => node.id), 0.3);
        if (!target)
            return null;
        this.select(target.id);
        return this.model.nodeById.get(target.id) ?? null;
    }
    refreshSearch() {
        const matches = recomputeSearchMatches(this.visible.nodes, this.search.query, this.filters, this.model.scores);
        this.search.matchIds = matches.matchIds;
        this.search.results = matches.results;
        if (this.search.index >= matches.results.length)
            this.search.index = matches.results.length ? 0 : -1;
    }
    /** Set the query, light up matches, and fly to the best one. */
    applySearch(query) {
        this.search.query = query.trim();
        this.filters.searchQuery = this.search.query;
        this.refreshSearch();
        if (!this.search.query) {
            this.search.index = -1;
            return null;
        }
        const best = bestSearchMatch(this.search.results);
        this.search.index = best ? 0 : -1;
        if (best)
            this.select(best.id, { fly: true });
        return best;
    }
    clearSearch() {
        this.applySearch("");
    }
    stepSearch(delta) {
        const results = this.search.results;
        if (!results.length)
            return null;
        this.search.index = ((this.search.index + delta) % results.length + results.length) % results.length;
        const node = results[this.search.index];
        this.select(node.id, { fly: true });
        return node;
    }
    cyclePreset(delta = 1) {
        this.presetIndex = ((this.presetIndex + delta) % FILTER_PRESETS.length + FILTER_PRESETS.length) % FILTER_PRESETS.length;
        const preset = this.preset;
        this.filters.filterTypes = { ...preset.types };
        this.filters.filterHealth = preset.health;
        this.applyFilters(true);
        return preset;
    }
    /** Focus one project (name) or all (null). */
    focusProject(name) {
        this.filters.filterProject = name ?? "all";
        this.applyFilters(true);
        // Either way the visible set just changed shape: frame it, then keep the
        // project selected so its neighbours are numbered.
        this.cameraTarget = null;
        this.fitAll();
        if (name) {
            const node = this.projects.find((p) => (p.project || p.id) === name);
            if (node)
                this.selectedId = node.id;
        }
    }
    cycleProject(delta) {
        if (!this.projects.length)
            return null;
        const names = this.projects.map((p) => p.project || p.id);
        const current = this.focusedProject ? names.indexOf(this.focusedProject) : -1;
        // Slot -1 is "all projects"; the cycle runs all → first … last → all.
        const slots = names.length + 1;
        const next = (((current + 1 + delta) % slots) + slots) % slots - 1;
        const name = next < 0 ? null : names[next];
        this.focusProject(name);
        return name;
    }
    jumpToNeighbor(n) {
        if (!this.selectedId)
            return null;
        const node = this.neighborsOf(this.selectedId)[n - 1];
        if (!node)
            return null;
        this.select(node.id);
        return node;
    }
    // ── Keys ────────────────────────────────────────────────────────────────
    /**
     * Returns true when the key was consumed, undefined to let the shell's
     * generic handler have it (q, :, ?, view shortcuts, final Esc).
     */
    handleKey(rawKey, host) {
        const mouse = parseMouse(rawKey);
        if (mouse) {
            this.lastUserInputAt = Date.now();
            return this.status === "ready" ? this.handleMouse(mouse, host) : true;
        }
        const key = normalizeArrow(rawKey);
        if (key !== "w" && key !== "W")
            this.lastUserInputAt = Date.now();
        if (this.status !== "ready") {
            if (key === "r") {
                this.dataToken = "";
                host.setMessage("  Rebuilding graph…");
                return true;
            }
            return undefined;
        }
        const arrow = ARROW_DIRECTION[key];
        if (arrow) {
            const node = this.walk(arrow);
            host.setMessage(node ? this.describe(node) : `  ${style.dim("nothing further that way")}`);
            return true;
        }
        const shifted = SHIFT_ARROW_DIRECTION[key] ?? PAN_LETTER_DIRECTION[key];
        if (shifted) {
            this.pan(shifted);
            return true;
        }
        if (key === "+" || key === "=") {
            this.zoom(1.25);
            return true;
        }
        if (key === "-" || key === "_") {
            this.zoom(1 / 1.25);
            return true;
        }
        if (key === "0") {
            this.fitAll();
            host.setMessage(`  ${style.dim("fit to screen")}`);
            return true;
        }
        if (key === "r") {
            this.relayout();
            host.setMessage(`  ${style.dim("re-laid out")}`);
            return true;
        }
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
                if (node) {
                    this.select(node.id);
                    host.setMessage(this.describe(node));
                }
                return true;
            }
            const node = this.model.nodeById.get(this.selectedId);
            if (node?.kind === "project") {
                const name = node.project || node.id;
                const next = this.focusedProject === name ? null : name;
                this.focusProject(next);
                host.setMessage(next ? `  ${style.boldCyan("❖")} ${style.boldCyan(next)}  ${style.dim("focused — ↵ again to release")}` : `  ${style.dim("all projects")}`);
            }
            else if (node) {
                this.flyTo(node.id);
                host.setMessage(this.describe(node));
            }
            return true;
        }
        if (/^[1-9]$/.test(key)) {
            const node = this.jumpToNeighbor(Number(key));
            if (node)
                host.setMessage(this.describe(node));
            else
                host.setMessage(`  ${style.dim(this.selectedId ? "no such neighbour" : "select a node first (↵)")}`);
            return true;
        }
        if (key === "/") {
            host.startInput("graph-search", this.search.query);
            return true;
        }
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
            if (!this.agents.enabled || !this.agents.agents.length)
                return undefined;
            const agent = this.agents.cycle(key === "\t" ? 1 : -1);
            if (agent) {
                if (agent.project && this.model.nodeById.has(agent.project))
                    this.select(agent.project, { fly: true });
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
        if (key === "v") {
            const on = this.toggleOrbit();
            host.setMessage(on
                ? `  ${style.boldCyan("⟲")} ${style.dim("orbit — drag to turn, wheel to zoom,")} ${style.boldCyan("v")} ${style.dim("back to the map")}`
                : `  ${style.dim("flat map")}`);
            return true;
        }
        if (key === "o") {
            host.setMessage(`  ${style.dim("open the 3D viewer in a browser:")} ${style.boldCyan("phren web-ui")}`);
            return true;
        }
        if (key === " ") {
            if (!this.selectedId) {
                host.setMessage(`  ${style.dim("select a node first — ↵ or 1-9")}`);
                return true;
            }
            this.reader = !this.reader;
            host.setMessage(this.reader ? `  ${style.dim("reading —")} ${style.boldCyan("␣")} ${style.dim("or")} ${style.boldCyan("esc")} ${style.dim("to close")}` : "");
            return true;
        }
        if (key === "\x1b") {
            if (this.reader) {
                this.reader = false;
                host.setMessage("");
                return true;
            }
            if (this.agents.current) {
                this.agents.clearHighlight();
                host.setMessage(`  ${style.dim("agent released")}`);
                return true;
            }
            if (this.search.query) {
                this.clearSearch();
                host.setMessage(`  ${style.dim("search cleared")}`);
                return true;
            }
            if (this.selectedId) {
                this.select(null);
                host.setMessage(`  ${style.dim("selection cleared")}`);
                return true;
            }
            if (this.focusedProject) {
                this.focusProject(null);
                host.setMessage(`  ${style.dim("all projects")}`);
                return true;
            }
            return undefined;
        }
        return undefined;
    }
    /** One-line description for the message bar. */
    describe(node) {
        const label = node.fullLabel || node.label;
        const short = label.length > 70 ? `${label.slice(0, 68)}…` : label;
        const where = node.project && node.kind !== "project" ? `  ${style.dim("·")} ${style.cyan(node.project)}` : "";
        return `  ${style.dim(node.kind)} ${short}${where}`;
    }
}

import ForceGraph3D from "3d-force-graph";
import * as THREE from "three";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import type { FGLink, FGNode } from "./types.js";
import { ACCENT_AMBER, BG_COLOR } from "./types.js";
import {
  buildVisibleData,
  currentTheme,
  nodeRadius,
  rebuildHostNodes,
  recomputeSearchMatches,
  seeded,
  state,
} from "./state.js";
import {
  applyHighlight,
  buildNodeObject,
  disposeFocusHalos,
  ensureFocusHalos,
  glowTexture,
  nodeWorldPos,
  ringTexture,
  tickNodes,
} from "./nodes.js";
import { linkColor, linkEndpointId, linkParticles, linkWidth } from "./links.js";
import {
  clearSelection,
  containerSize,
  noteInteraction,
  fitCameraToGraph,
  notifyClear,
  notifySelection,
  onHover,
  onNodeClick,
  onNodeRightClick,
  runIntro,
  tickIdleResume,
} from "./interactions.js";
import { createLabelRenderer, injectLabelCss, labelTick } from "./labels.js";
import { mascotUpdate } from "./mascot.js";
import { syncResultsAfterFilter, updateFilterBarCounter, updateHudStats } from "./hud.js";
import { buildProjectNav, stepProject } from "./project-nav.js";
import { computeHierarchicalLayout } from "./layout.js";
import { buildCages, disposeCages, setCageResolution } from "./cages.js";

let starfield: THREE.Points | null = null;
let nebula: THREE.Group | null = null;
let ringSprite: THREE.Sprite | null = null;
let ringPhase = 0;
let bloomPass: UnrealBloomPass | null = null;
let vignetteEl: HTMLElement | null = null;
let labelRenderer: ReturnType<typeof createLabelRenderer> | null = null;
let cageScene: THREE.Scene | null = null;

function buildStarfield(): THREE.Points {
  const count = 1400;
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
    color: 0x8b93c9,
    size: 3.5,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
    fog: false,
  });
  return new THREE.Points(geometry, material);
}

/** Two faint nebula washes parked far behind the graph — depth, not spectacle. */
function buildNebula(): THREE.Group {
  const group = new THREE.Group();
  const blooms: Array<{ color: number; pos: [number, number, number]; scale: number }> = [
    { color: 0x4633b0, pos: [-1500, 600, -2800], scale: 950 },
    { color: 0x1b6f96, pos: [1600, -500, -3050], scale: 1050 },
  ];
  for (const bloom of blooms) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(),
      color: bloom.color,
      transparent: true,
      opacity: 0.04,
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

/** Pointer-transparent vignette. (The old film-grain layer is gone on purpose.) */
function buildVignette(): HTMLElement {
  const overlay = document.createElement("div");
  overlay.className = "graph-cinematic";
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:4;overflow:hidden;";
  const vignette = document.createElement("div");
  vignette.className = "graph-vignette";
  vignette.style.cssText =
    "position:absolute;inset:0;background:radial-gradient(ellipse at 50% 50%, transparent 55%, rgba(0,0,0,0.55) 100%);";
  overlay.appendChild(vignette);
  vignetteEl = overlay;
  return overlay;
}

function detectSwiftShader(renderer: THREE.WebGLRenderer): boolean {
  try {
    const gl = renderer.getContext();
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const parts = [
      dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "",
      gl.getParameter(gl.RENDERER),
      gl.getParameter(gl.VERSION),
    ];
    return /swiftshader/i.test(parts.join(" "));
  } catch {
    return false;
  }
}

function fgNodeFor(node: (typeof state.visibleNodes)[number]): FGNode {
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

export function pushGraphData(): void {
  const nodes = state.visibleNodes.map(fgNodeFor);
  const visibleIds = new Set(nodes.map((n) => n.id));
  const links: FGLink[] = state.visibleLinks
    .filter((link) => visibleIds.has(link.source) && visibleIds.has(link.target))
    .map((link) => ({ source: link.source, target: link.target }));
  // Deterministic hierarchical layout (store ⊃ project ⊃ findings) — every
  // node is pinned via fx/fy/fz so the force sim leaves the positions alone.
  const cageSpecs = computeHierarchicalLayout(nodes);
  state.fg.graphData({ nodes, links });
  if (state.fg.scene) {
    cageScene = state.fg.scene();
    buildCages(cageScene!, cageSpecs, containerSize());
  }
  // applyHighlight also re-applies cage focus (refreshCageFocus) on the
  // freshly built cages, keyed by project name + store.
  applyHighlight();
}

export function applyFilters(options: { resetCamera?: boolean; emitSelection?: boolean } = {}): void {
  const visibleData = buildVisibleData();
  state.visibleNodes = visibleData.nodes;
  state.visibleLinks = visibleData.links;
  state.visibleIds = new Set(visibleData.nodes.map((node) => node.id));
  rebuildHostNodes();
  const prevMatchId = state.currentMatchIndex >= 0
    ? (state.searchResults[state.currentMatchIndex]?.id ?? null)
    : null;
  recomputeSearchMatches();
  if (state.fg) pushGraphData();
  updateFilterBarCounter();
  syncResultsAfterFilter(prevMatchId);
  updateHudStats();
  buildProjectNav();

  if (state.selectedNodeId && !state.visibleAdjacency.has(state.selectedNodeId)) {
    state.selectedNodeId = null;
    notifyClear();
  } else if (options.emitSelection && state.selectedNodeId) {
    setTimeout(() => notifySelection(state.selectedNodeId!), 0);
  }
  if (options.resetCamera && state.fg) {
    // The force sim is disabled (cooldownTicks 0), so onEngineStop won't
    // re-fire after a data swap — a filtered subset would otherwise be left
    // off-screen (e.g. isolating one project parked the camera on empty space).
    // Refit explicitly, but only after force-graph has committed the new node
    // set — getGraphBbox lags the graphData() swap by a couple of frames, so an
    // immediate fit would frame the stale (larger) bbox and leave the subset
    // tiny. A short delay lets the new pinned layout settle first.
    const fg = state.fg;
    setTimeout(() => { if (state.fg === fg) fitCameraToGraph(600); }, 180);
  }
}

export function setupForceGraph(): void {
  if (!state.container || state.fg) return;
  state.theme = currentTheme();
  state.container.style.position = "relative";
  injectLabelCss();
  state.fxOff = state.container.getAttribute("data-fx") === "off";

  labelRenderer = createLabelRenderer();

  const fg = new ForceGraph3D(state.container, {
    controlType: "orbit",
    extraRenderers: [labelRenderer as unknown as THREE.Renderer],
  })
    .backgroundColor(BG_COLOR)
    .showNavInfo(false)
    .nodeId("id")
    .nodeThreeObject((node: FGNode) => buildNodeObject(node))
    .nodeThreeObjectExtend(false)
    .linkColor((link: FGLink) => linkColor(link))
    .linkWidth(() => linkWidth())
    .linkCurvature(0.2)
    .linkOpacity(1)
    .linkDirectionalParticles((link: FGLink) => linkParticles(link))
    .linkDirectionalParticleSpeed(0.006)
    .linkDirectionalParticleWidth(1.2)
    .linkDirectionalParticleColor(() => ACCENT_AMBER)
    .enableNodeDrag(false)
    .warmupTicks(0)
    .cooldownTicks(0)
    .d3AlphaDecay(1)
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

  // Renderer: filmic tone mapping keeps the glow in check; SwiftShader
  // (software GL) drops to pixelRatio 1 so captures stay smooth.
  const renderer = fg.renderer() as THREE.WebGLRenderer;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const softwareGl = detectSwiftShader(renderer);
  renderer.setPixelRatio(softwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 1.5));

  // Idle orbit stays OFF until the graph has settled and the user has been
  // still for a while (tickIdleResume) — auto-rotating during load drifted the
  // camera into the cluster before the fit finished.
  fg.controls().autoRotate = false;
  fg.controls().autoRotateSpeed = 0.22;
  const pauseRotate = () => noteInteraction();
  state.container.addEventListener("pointerdown", pauseRotate);
  state.container.addEventListener("wheel", pauseRotate, { passive: true });
  state.cleanupFns.push(() => {
    state.container?.removeEventListener("pointerdown", pauseRotate);
    state.container?.removeEventListener("wheel", pauseRotate);
  });

  // Layout is deterministic (see computeHierarchicalLayout) and every node is
  // pinned, so the force sim is neutralised: kill charge so nothing drifts.
  const charge = fg.d3Force("charge");
  if (charge) charge.strength(0);
  fg.d3Force("link", null);
  fg.d3Force("center", null);

  // Bloom does the glow for the tiny additive dots — lower threshold, tighter.
  if (!state.fxOff) {
    const size = containerSize();
    bloomPass = new UnrealBloomPass(new THREE.Vector2(Math.max(1, size.w / 2), Math.max(1, size.h / 2)), 0.55, 0.5, 0.2);
    fg.postProcessingComposer().addPass(bloomPass);
  }

  fg.scene().fog = new THREE.FogExp2(BG_COLOR, 0.0006);
  ensureFocusHalos(fg.scene());

  // Open on a 3/4 angle (the fit preserves the direction). Head-on read flat.
  fg.cameraPosition({ x: 260, y: 190, z: 520 }, { x: 0, y: 0, z: 0 }, 0);

  // Expanding pulse ring around the active node.
  ringSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: ringTexture(),
    color: new THREE.Color(ACCENT_AMBER),
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    fog: false,
  }));
  ringSprite.visible = false;
  ringSprite.renderOrder = 998;
  fg.scene().add(ringSprite);

  const overlay = buildVignette();
  state.container.appendChild(overlay);
  state.cleanupFns.push(() => overlay.remove());

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
    // Never steal keys while the user is typing in the search box or a field.
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;
    if (event.key === "Escape") {
      if (!state.selectedNodeId && !state.focusedProjectId) return;
      clearSelection();
      return;
    }
    // ←/→ step through projects via the navigator dock (Alt/Ctrl/Meta reserved).
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !event.altKey && !event.ctrlKey && !event.metaKey) {
      stepProject(event.key === "ArrowRight" ? 1 : -1);
      event.preventDefault();
    }
  };
  document.addEventListener("keydown", onKeydown);
  state.cleanupFns.push(() => document.removeEventListener("keydown", onKeydown));

  const onResize = () => {
    const next = containerSize();
    state.fg?.width(next.w).height(next.h);
    labelRenderer?.setSize(next.w, next.h);
    setCageResolution(next.w, next.h);
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
      runIntro();
    }
  });

  const observer = new MutationObserver(() => {
    if (currentTheme() === state.theme) return;
    state.theme = currentTheme();
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  state.themeObserver = observer;

  // Ambient loop — every animated system hangs off this one RAF.
  let lastTime = 0;
  const ambientTick = (timestamp: number) => {
    state.ambientRafId = requestAnimationFrame(ambientTick);
    if (document.hidden) {
      lastTime = timestamp;
      return;
    }
    const dt = lastTime > 0 ? Math.min(0.05, (timestamp - lastTime) / 1000) : 0.016;
    lastTime = timestamp;
    const now = timestamp * 0.001;

    if (starfield) starfield.rotation.y += dt * 0.008;

    tickNodes(dt, now);
    labelTick(dt);
    tickIdleResume(timestamp);

    if (ringSprite) {
      const activeId = state.selectedNodeId || state.focusedProjectId;
      const pos = activeId ? nodeWorldPos(activeId) : null;
      const activeNode = activeId ? state.nodeById.get(activeId) : null;
      if (pos && activeNode) {
        ringSprite.visible = true;
        ringSprite.position.copy(pos);
        ringPhase = (ringPhase + dt * 0.6) % 1;
        const baseR = nodeRadius(activeNode) || 8;
        ringSprite.scale.setScalar(baseR * (1.6 + ringPhase * 3));
        (ringSprite.material as THREE.SpriteMaterial).opacity = (1 - ringPhase) * 0.2;
      } else {
        ringSprite.visible = false;
      }
    }
    mascotUpdate(dt);
  };
  state.ambientRafId = requestAnimationFrame(ambientTick);
}

/** Dispose everything setupForceGraph created (called from destroy()). */
export function disposeScene(): void {
  if (starfield) {
    starfield.geometry.dispose();
    (starfield.material as THREE.Material).dispose();
    starfield = null;
  }
  nebula?.children.forEach((child) => {
    ((child as THREE.Sprite).material as THREE.SpriteMaterial).dispose();
  });
  nebula = null;
  if (ringSprite) {
    (ringSprite.material as THREE.SpriteMaterial).dispose();
    ringSprite = null;
  }
  disposeFocusHalos();
  if (cageScene) { disposeCages(cageScene); cageScene = null; }
  bloomPass = null;
  vignetteEl = null;
  labelRenderer = null;
}

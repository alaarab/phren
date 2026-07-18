import * as THREE from "three";
import type { FGNode, RuntimeNode } from "./types.js";
import { ACCENT_AMBER, ACCENT_CYAN } from "./types.js";
import { clamp, focusMode, isInProjectNetwork, nodeRadius, seeded, state } from "./state.js";
import { attachEagerLabel, refreshLabels } from "./labels.js";

// ── Shared geometries (5 singletons for every node in the scene) ────────

const SPHERE_GEOM = new THREE.SphereGeometry(1, 18, 18);
const CAGE_GEOM = new THREE.IcosahedronGeometry(1, 1);
const SHARD_GEOM = new THREE.OctahedronGeometry(1, 0);
const REF_GEOM = new THREE.IcosahedronGeometry(1, 0);
const RING_GEOM = new THREE.RingGeometry(1.55, 1.62, 48);

let _glowTexture: THREE.Texture | null = null;
export function glowTexture(): THREE.Texture {
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

let _dotTexture: THREE.Texture | null = null;
/** Crisp glowing dot for point-nodes — tighter falloff than the soft glow. */
export function dotTexture(): THREE.Texture {
  if (_dotTexture) return _dotTexture;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.45, "rgba(255,255,255,0.9)");
  gradient.addColorStop(0.7, "rgba(255,255,255,0.35)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  _dotTexture = new THREE.CanvasTexture(canvas);
  return _dotTexture;
}

let _ringTexture: THREE.Texture | null = null;
export function ringTexture(): THREE.Texture {
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

// ── Holographic shell shader ────────────────────────────────────────────
// One program shared by every node (three caches by source); per-node
// uniform sets. Normal blending — additive stacking is what washed the old
// scene out. A fixed in-shader key light gives form without scene lights.

const HOLO_VERT = `
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const HOLO_FRAG = `
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uRimPower;
  uniform float uBodyAlpha;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float fres = pow(1.0 - max(dot(vNormal, vView), 0.0), uRimPower);
    float key = max(dot(vNormal, normalize(vec3(0.4, 0.7, 0.6))), 0.0) * 0.35;
    vec3 col = uColor * (0.22 + key) + uColor * fres * 1.25;
    float alpha = (uBodyAlpha + fres * 0.55) * uIntensity;
    gl_FragColor = vec4(col, alpha);
  }
`;

function makeHoloMaterial(color: string, bodyAlpha: number, rimPower: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uIntensity: { value: 1 },
      uRimPower: { value: rimPower },
      uBodyAlpha: { value: bodyAlpha },
    },
    vertexShader: HOLO_VERT,
    fragmentShader: HOLO_FRAG,
    transparent: true,
    depthWrite: false,
  });
}

// ── Node construction ───────────────────────────────────────────────────

/** Point-node size (world units) by kind — GraphRAG-style small glowing dots. */
function dotSize(node: FGNode["raw"]): number {
  if (node.kind === "project") return 5.4;
  if (node.kind === "finding") return node.tagged ? 4 : 3.4;
  if (node.kind === "task") return 3.8;
  if (node.kind === "reference") return 2.8;
  return 2.6; // entity
}

/** Point-node tint by kind — findings brightest, entities dim satellites. */
function dotColor(node: FGNode["raw"]): THREE.Color {
  const c = new THREE.Color(node.baseColor);
  if (node.kind === "project") return c.lerp(new THREE.Color(0xffffff), 0.35);
  if (node.kind === "finding") return c.lerp(new THREE.Color(0xffffff), node.tagged ? 0.5 : 0.35);
  if (node.kind === "entity") return c.lerp(new THREE.Color(0xffffff), 0.12).multiplyScalar(0.72);
  if (node.kind === "reference") return c.lerp(new THREE.Color(0xffffff), 0.2).multiplyScalar(0.8);
  return c.lerp(new THREE.Color(0xffffff), 0.3);
}

export function buildNodeObject(fgNode: FGNode): THREE.Group {
  if (fgNode.__group) return fgNode.__group;
  const node = fgNode.raw;
  const group = new THREE.Group();
  group.userData.phrenNodeId = node.id;

  // Every node is a small glowing point (dot sprite). Communities/structure
  // come from the cages, not from big per-node geometry.
  const dot = new THREE.Sprite(new THREE.SpriteMaterial({
    map: dotTexture(),
    color: dotColor(node),
    transparent: true,
    opacity: 1,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  }));
  dot.scale.setScalar(dotSize(node));
  group.add(dot);
  fgNode.__dot = dot;

  fgNode.__group = group;
  fgNode.__focusScale = 1;
  fgNode.__int = fgNode.__int ?? 1;
  fgNode.__intTarget = fgNode.__intTarget ?? 1;
  applyNodeIntensity(fgNode);
  attachEagerLabel(fgNode);
  return group;
}

export function nodeWorldPos(nodeId: string): THREE.Vector3 | null {
  const fgNode = state.fgNodeById.get(nodeId);
  if (!fgNode || fgNode.x == null) return null;
  return new THREE.Vector3(fgNode.x, fgNode.y || 0, fgNode.z || 0);
}

// ── Focus dimming state machine ─────────────────────────────────────────
// idle: everything at 1. hover/selected: node + 1-hop neighbors lit, rest
// fades to 0.08 (the Obsidian trick). project focus: the project's network.
// search: matches lit, rest 0.10. Targets lerp over ~220ms in tickNodes.

const DIM_OTHER = 0.08;
const DIM_SEARCH = 0.1;

export function applyHighlight(): void {
  const mode = focusMode();
  const focus = state.hoveredNodeId || state.selectedNodeId;
  const neighbors = focus ? state.visibleAdjacency.get(focus) : null;

  state.fgNodeById.forEach((fgNode, id) => {
    let target = 1;
    if (mode === "project") {
      target = isInProjectNetwork(id, state.focusedProjectId!) ? 1 : DIM_OTHER;
    } else if (mode === "hover" || mode === "selected") {
      target = id === focus || Boolean(neighbors?.has(id)) ? 1 : DIM_OTHER;
    } else if (mode === "search") {
      target = state.searchMatchIds.has(id) ? 1 : DIM_SEARCH;
    }
    fgNode.__intTarget = target;
    const isSelected = id === state.selectedNodeId || id === state.focusedProjectId;
    const isHovered = id === state.hoveredNodeId;
    fgNode.__focusScale = isSelected ? 1.18 : isHovered ? 1.12 : 1;
  });
  state.dimAnimating = true;

  if (state.fg) {
    // Re-evaluate link styling accessors.
    state.fg
      .linkColor(state.fg.linkColor())
      .linkWidth(state.fg.linkWidth())
      .linkDirectionalParticles(state.fg.linkDirectionalParticles());
  }
  refreshLabels();
}

export function applyNodeIntensity(fgNode: FGNode): void {
  const i = fgNode.__int ?? 1;
  if (fgNode.__dot) (fgNode.__dot.material as THREE.SpriteMaterial).opacity = i;
}

// ── Intro stagger ───────────────────────────────────────────────────────

let introStaggerActive = false;
let introClock = 0;

/** Fade every node from 0 with a hash-seeded delay in [0, 0.9s]. */
export function startIntroStagger(): void {
  introStaggerActive = true;
  introClock = 0;
  state.fgNodeById.forEach((fgNode) => {
    fgNode.__int = 0;
    fgNode.__intTarget = 0;
    fgNode.__introDelay = seeded(fgNode.id, "intro") * 0.9;
    applyNodeIntensity(fgNode);
  });
  state.dimAnimating = true;
}

// Shared focus halos: exactly two sprites follow the hovered/selected node
// instead of one halo per node (the old renderer carried ~N sprites).
let hoverHalo: THREE.Sprite | null = null;
let selectHalo: THREE.Sprite | null = null;

export function ensureFocusHalos(scene: THREE.Scene): void {
  if (hoverHalo) return;
  const make = (color: string, opacity: number) => {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(),
      color: new THREE.Color(color),
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    sprite.visible = false;
    scene.add(sprite);
    return sprite;
  };
  hoverHalo = make(ACCENT_CYAN, 0.2);
  selectHalo = make(ACCENT_AMBER, 0.26);
}

export function disposeFocusHalos(): void {
  for (const sprite of [hoverHalo, selectHalo]) {
    if (sprite) {
      sprite.parent?.remove(sprite);
      (sprite.material as THREE.SpriteMaterial).dispose();
    }
  }
  hoverHalo = null;
  selectHalo = null;
}

function positionFocusHalo(sprite: THREE.Sprite | null, nodeId: string | null): void {
  if (!sprite) return;
  const pos = nodeId ? nodeWorldPos(nodeId) : null;
  const node = nodeId ? state.nodeById.get(nodeId) : null;
  if (pos && node) {
    sprite.visible = true;
    sprite.position.copy(pos);
    sprite.scale.setScalar(nodeRadius(node) * 3.2);
  } else {
    sprite.visible = false;
  }
}

// ── Per-frame node animation ────────────────────────────────────────────

export function tickNodes(dt: number, now: number): void {
  if (introStaggerActive) {
    introClock += dt;
    let allReleased = true;
    state.fgNodeById.forEach((fgNode) => {
      if ((fgNode.__introDelay ?? 0) <= introClock) fgNode.__intTarget = 1;
      else allReleased = false;
    });
    state.dimAnimating = true;
    if (allReleased) introStaggerActive = false;
  }

  if (state.dimAnimating) {
    let maxDelta = 0;
    const step = dt / 0.22;
    state.fgNodeById.forEach((fgNode) => {
      const target = fgNode.__intTarget ?? 1;
      const current = fgNode.__int ?? 1;
      const delta = target - current;
      if (Math.abs(delta) < 0.004) {
        if (current !== target) {
          fgNode.__int = target;
          applyNodeIntensity(fgNode);
        }
        return;
      }
      fgNode.__int = current + clamp(delta, -step, step);
      applyNodeIntensity(fgNode);
      maxDelta = Math.max(maxDelta, Math.abs(delta));
    });
    if (maxDelta < 0.004 && !introStaggerActive) state.dimAnimating = false;
  }

  // Breathing + slow project cage/ring rotation. Object3D transforms only —
  // no material churn at rest.
  state.fgNodeById.forEach((fgNode) => {
    if (!fgNode.__group) return;
    if (fgNode.__phase === undefined) fgNode.__phase = seeded(fgNode.id, "breathe") * 6.283;
    const breathe = 1 + 0.02 * Math.sin(now * 1.2 + fgNode.__phase);
    fgNode.__group.scale.setScalar((fgNode.__focusScale ?? 1) * breathe);
    if (fgNode.__wire) {
      fgNode.__wire.rotation.y += dt * 0.25;
      fgNode.__wire.rotation.x += dt * 0.09;
    }
    if (fgNode.__ring) fgNode.__ring.rotation.z += dt * 0.1;
  });

  positionFocusHalo(hoverHalo, state.hoveredNodeId);
  positionFocusHalo(selectHalo, state.selectedNodeId || state.focusedProjectId);
}

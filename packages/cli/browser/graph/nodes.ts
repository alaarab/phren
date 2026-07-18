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

export function buildNodeObject(fgNode: FGNode): THREE.Group {
  if (fgNode.__group) return fgNode.__group;
  const node = fgNode.raw;
  const group = new THREE.Group();
  group.userData.phrenNodeId = node.id;
  const radius = nodeRadius(node);
  const color = new THREE.Color(node.baseColor);

  if (node.kind === "project") {
    // Glass orb: translucent fresnel sphere around a hot white-amber core,
    // ringed by a thin accent band and a slow wireframe cage.
    const core = new THREE.Mesh(
      SPHERE_GEOM,
      new THREE.MeshBasicMaterial({ color: color.clone().lerp(new THREE.Color("#ffffff"), 0.55), transparent: true, opacity: 1, toneMapped: false }),
    );
    core.scale.setScalar(radius * 0.3);
    group.add(core);

    const shell = new THREE.Mesh(SPHERE_GEOM, makeHoloMaterial(node.baseColor, 0.12, 3.0));
    shell.scale.setScalar(radius);
    group.add(shell);

    const wire = new THREE.Mesh(CAGE_GEOM, new THREE.MeshBasicMaterial({
      color,
      wireframe: true,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
    }));
    wire.scale.setScalar(radius * 1.35);
    group.add(wire);
    fgNode.__wire = wire;

    const ring = new THREE.Mesh(RING_GEOM, new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.15,
      side: THREE.DoubleSide,
      depthWrite: false,
    }));
    ring.scale.setScalar(radius);
    ring.rotation.x = 1.1 + seeded(node.id, "tilt") * 0.6;
    ring.rotation.y = seeded(node.id, "spin") * Math.PI;
    group.add(ring);
    fgNode.__ring = ring;

    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(),
      color,
      transparent: true,
      opacity: 0.1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    halo.scale.setScalar(radius * 2.2);
    group.add(halo);
    fgNode.__halo = halo;

    fgNode.__core = core;
    fgNode.__shell = shell;
  } else if (node.kind === "finding" || node.kind === "task") {
    // Crystal shard, tinted by topic. Static hash-seeded orientation — no
    // per-frame spin, the stillness is part of the archive look.
    const shard = new THREE.Mesh(SHARD_GEOM, makeHoloMaterial(node.baseColor, 0.55, 2.0));
    if (node.kind === "task") shard.scale.set(radius * 0.8, radius * 1.4, radius * 0.8);
    else shard.scale.setScalar(radius);
    shard.rotation.set(
      seeded(node.id, "rx") * Math.PI,
      seeded(node.id, "ry") * Math.PI,
      seeded(node.id, "rz") * Math.PI,
    );
    group.add(shard);

    const core = new THREE.Mesh(
      SPHERE_GEOM,
      new THREE.MeshBasicMaterial({ color: color.clone().lerp(new THREE.Color("#ffffff"), 0.25), transparent: true, opacity: 1, toneMapped: false }),
    );
    core.scale.setScalar(radius * 0.22);
    group.add(core);

    fgNode.__core = core;
    fgNode.__shell = shard;
  } else {
    // Entities and references: small quiet satellites.
    const isRef = node.kind === "reference";
    const shell = new THREE.Mesh(
      isRef ? REF_GEOM : SPHERE_GEOM,
      makeHoloMaterial(node.baseColor, isRef ? 0.4 : 0.35, 2.4),
    );
    shell.scale.setScalar(radius * 0.8);
    group.add(shell);

    const core = new THREE.Mesh(
      SPHERE_GEOM,
      new THREE.MeshBasicMaterial({ color: color.clone().lerp(new THREE.Color("#ffffff"), 0.2), transparent: true, opacity: 1, toneMapped: false }),
    );
    core.scale.setScalar(radius * 0.18);
    group.add(core);

    fgNode.__core = core;
    fgNode.__shell = shell;
  }

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
  if (fgNode.__core) (fgNode.__core.material as THREE.MeshBasicMaterial).opacity = i;
  if (fgNode.__shell) {
    const mat = fgNode.__shell.material as THREE.ShaderMaterial;
    if (mat.uniforms?.uIntensity) mat.uniforms.uIntensity.value = i;
  }
  if (fgNode.__wire) (fgNode.__wire.material as THREE.MeshBasicMaterial).opacity = 0.18 * i;
  if (fgNode.__ring) (fgNode.__ring.material as THREE.MeshBasicMaterial).opacity = 0.15 * i;
  if (fgNode.__halo) (fgNode.__halo.material as THREE.SpriteMaterial).opacity = 0.1 * i;
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

import * as THREE from "three";
import { PHREN_SPRITE_B64 } from "../phren-sprite.js";
import { ACCENT_CYAN } from "./types.js";
import { state } from "./state.js";
import { glowTexture, nodeWorldPos, ringTexture } from "./nodes.js";

// The phren mascot as a subtle easter egg: small, calm, drifting the graph's
// periphery on long pauses — and perching next to whatever you select. Live
// retrieval events (phren:lookup → walkTo) send it to the retrieved node
// with a cyan pulse ring, so the graph visibly "thinks" as searches land.

export const mascot = {
  sprite: null as THREE.Sprite | null,
  glow: null as THREE.Sprite | null,
  pos: new THREE.Vector3(),
  target: new THREE.Vector3(),
  moving: false,
  initialized: false,
  bobPhase: 0,
  idleTimer: 0,
  idlePause: 12,
  tripT: 0,
  currentNodeId: null as string | null,
  targetNodeId: null as string | null,
  lastVisited: null as string | null,
  userTarget: false,
};

export function startMascot(): void {
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
  sprite.scale.setScalar(14);
  sprite.renderOrder = 999;
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(),
    color: 0x9c8ff8,
    transparent: true,
    opacity: 0.28,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }));
  glow.scale.setScalar(26);
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

export function stopMascot(): void {
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

export function mascotMoveTo(targetId: string, userTriggered = false): void {
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

// ── Live-lookup pulse rings ─────────────────────────────────────────────
// A pool of 2 one-shot expanding cyan rings; lookup bursts recycle them.

type Pulse = { sprite: THREE.Sprite; t: number; active: boolean };
const pulses: Pulse[] = [];

export function spawnLookupPulse(nodeId: string): void {
  if (!state.fg) return;
  const pos = nodeWorldPos(nodeId);
  if (!pos) return;
  let pulse = pulses.find((p) => !p.active);
  if (!pulse && pulses.length < 2) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: ringTexture(),
      color: new THREE.Color(ACCENT_CYAN),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    }));
    sprite.renderOrder = 998;
    sprite.visible = false;
    state.fg.scene().add(sprite);
    pulse = { sprite, t: 0, active: false };
    pulses.push(pulse);
  }
  if (!pulse) pulse = pulses[0];
  pulse.sprite.position.copy(pos);
  pulse.t = 0;
  pulse.active = true;
  pulse.sprite.visible = true;
}

export function disposePulses(): void {
  for (const pulse of pulses) {
    pulse.sprite.parent?.remove(pulse.sprite);
    (pulse.sprite.material as THREE.SpriteMaterial).dispose();
  }
  pulses.length = 0;
}

/**
 * Send the mascot to a node in response to a live memory lookup. Returns
 * false only for unknown/not-yet-positioned nodes, so hosts can fall back.
 */
export function walkTo(nodeId: string): boolean {
  const pos = nodeWorldPos(nodeId);
  if (!pos) return false;
  if (!mascot.initialized) {
    mascot.pos.copy(pos);
    mascot.target.copy(pos);
    mascot.currentNodeId = nodeId;
    mascot.initialized = Boolean(mascot.sprite);
    spawnLookupPulse(nodeId);
    return true;
  }
  if (nodeId === mascot.currentNodeId && !mascot.moving) {
    // Already perched here — bounce instead of a no-op.
    mascot.bobPhase += 2;
  } else {
    mascotMoveTo(nodeId, true);
  }
  spawnLookupPulse(nodeId);
  return true;
}

export function mascotUpdate(dt: number): void {
  // Advance pulse rings even if the mascot itself is absent.
  for (const pulse of pulses) {
    if (!pulse.active) continue;
    pulse.t += dt / 0.7;
    if (pulse.t >= 1) {
      pulse.active = false;
      pulse.sprite.visible = false;
      continue;
    }
    pulse.sprite.scale.setScalar(10 + pulse.t * 46);
    (pulse.sprite.material as THREE.SpriteMaterial).opacity = (1 - pulse.t) * 0.55;
  }

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
      mascot.idlePause = 9 + Math.random() * 7;
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

  const bob = Math.sin(mascot.bobPhase * 2.2) * 2;
  mascot.sprite.position.set(mascot.pos.x + 10, mascot.pos.y + 10 + bob, mascot.pos.z);
  mascot.glow.position.copy(mascot.sprite.position);
  const pulse = 0.24 + 0.08 * Math.sin(mascot.bobPhase * 3);
  (mascot.glow.material as THREE.SpriteMaterial).opacity = mascot.moving ? pulse + 0.15 : pulse;
}

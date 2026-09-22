import * as THREE from "three";
import { freeSpaceCenter, perspectivePlaneOffset } from "../../src/graph-core/camera.js";
import { state } from "./state.js";

type Pose = { position: THREE.Vector3; target: THREE.Vector3 };
export type SelectionViewport = { bottomInset: number; topInset?: number; gap?: number };

let viewport: SelectionViewport | null = null;
let previousPose: Pose | null = null;
let selectedId: string | null = null;
let following = false;
let interacting = false;
let animation = 0;
let restoreDamping: (() => void) | null = null;

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function cameraPose(): Pose {
  return { position: state.fg.camera().position.clone(), target: state.fg.controls().target.clone() };
}

export function stopCameraMotion(): void {
  cancelAnimationFrame(animation);
  animation = 0;
  restoreDamping?.();
  restoreDamping = null;
}

/** One cancellable camera animation for selection, restoration and explicit camera commands. */
export function moveCamera(position: THREE.Vector3, target: THREE.Vector3, duration: number): void {
  stopCameraMotion();
  const fg = state.fg;
  if (!fg) return;
  const controls = fg.controls();
  controls.autoRotate = false;
  const damping = controls.enableDamping;
  controls.enableDamping = false;
  // Drain any remaining orbit momentum before taking ownership of the camera.
  controls.update();
  restoreDamping = () => { controls.enableDamping = damping; };
  const from = cameraPose();
  const start = performance.now();
  const milliseconds = reducedMotion() ? 0 : duration;
  const tick = (now: number) => {
    const progress = milliseconds > 0 ? Math.min(1, (now - start) / milliseconds) : 1;
    const eased = 1 - (1 - progress) ** 3;
    const pos = from.position.clone().lerp(position, eased);
    const aim = from.target.clone().lerp(target, eased);
    fg.cameraPosition(pos, aim, 0);
    controls.update();
    fg.camera().updateMatrixWorld(true);
    if (progress < 1) animation = requestAnimationFrame(tick);
    else stopCameraMotion();
  };
  tick(start);
}

export function setSelectionViewport(next: SelectionViewport): void {
  const changed = !viewport || next.bottomInset !== viewport.bottomInset
    || next.topInset !== viewport.topInset || next.gap !== viewport.gap;
  viewport = next;
  if (changed) recenterSelection();
}

/** Opted-in hosts measure their own dossier. Desktop hosts keep their existing fly-to. */
export function frameSelection(nodeId: string): boolean {
  if (!viewport || !state.fg) return false;
  stopCameraMotion();
  if (!previousPose) previousPose = cameraPose();
  selectedId = nodeId;
  following = !interacting;
  state.firstSettle = false;
  state.introPlayed = true;
  recenterSelection();
  return true;
}

export function recenterSelection(duration = 180, pose?: Pose): void {
  if (!viewport || !selectedId || !following || interacting || !state.fg) return;
  const node = state.fgNodeById.get(selectedId);
  if (!node || node.x == null) return;
  const camera = state.fg.camera() as THREE.PerspectiveCamera;
  const current = pose ?? cameraPose();
  const nodePosition = new THREE.Vector3(node.x, node.y ?? 0, node.z ?? 0);
  const back = current.position.clone().sub(current.target).normalize();
  const right = new THREE.Vector3().crossVectors(camera.up, back).normalize();
  const up = new THREE.Vector3().crossVectors(back, right).normalize();
  const nodeDepth = current.position.clone().sub(nodePosition).dot(back);
  // Keep the selected node's scale. A node behind the camera is brought onto
  // the current orbit plane so selecting an offscreen search result also works.
  const depth = nodeDepth > camera.near ? nodeDepth : Math.max(camera.near * 2, current.position.distanceTo(current.target));
  const size = { width: state.container?.clientWidth || 1, height: state.container?.clientHeight || 1 };
  const center = freeSpaceCenter({ ...size, ...viewport });
  const offset = perspectivePlaneOffset(center, size, depth, camera.fov, camera.zoom);
  const target = nodePosition.clone().addScaledVector(right, -offset.x).addScaledVector(up, -offset.y);
  moveCamera(target.clone().addScaledVector(back, depth), target, duration);
}

export function restoreSelectionCamera(): void {
  const previous = previousPose;
  previousPose = null;
  selectedId = null;
  following = false;
  if (previous && !interacting) moveCamera(previous.position, previous.target, 180);
  else stopCameraMotion();
}

export function beginCameraInteraction(): void {
  interacting = true;
  following = false;
  // An initial layout callback must not start the intro over a user's gesture.
  state.firstSettle = false;
  state.introPlayed = true;
  stopCameraMotion();
}

export function endCameraInteraction(): void {
  interacting = false;
  // Resizing a dossier must not pull the camera back after a deliberate pan.
}

export function zoomCamera(factor: number): void {
  if (!state.fg) return;
  const pose = cameraPose();
  pose.position.sub(pose.target).multiplyScalar(1 / Math.max(factor, 0.05)).add(pose.target);
  if (selectedId && following && !interacting) recenterSelection(160, pose);
  else moveCamera(pose.position, pose.target, 160);
}

export function disposeSelectionCamera(): void {
  stopCameraMotion();
  previousPose = null;
  selectedId = null;
  following = false;
  interacting = false;
}

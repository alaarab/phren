import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { state } from "../../browser/graph/state.js";
import {
  beginCameraInteraction, disposeSelectionCamera, endCameraInteraction,
  frameSelection, recenterSelection, restoreSelectionCamera, setSelectionViewport, zoomCamera,
} from "../../browser/graph/selection-camera.js";

describe("dossier camera", () => {
  let camera: THREE.PerspectiveCamera;
  let controls: { target: THREE.Vector3; autoRotate: boolean; enableDamping: boolean; update: () => void };
  let frames: Map<number, FrameRequestCallback>;
  let clock: number;
  let reduced: boolean;
  const size = { clientWidth: 393, clientHeight: 620 };

  function settle() {
    clock += 200;
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(clock));
  }

  function project(id = "node") {
    const node = state.fgNodeById.get(id)!;
    const point = new THREE.Vector3(node.x, node.y, node.z).project(camera);
    return { x: (point.x + 1) * size.clientWidth / 2, y: (1 - point.y) * size.clientHeight / 2 };
  }

  beforeEach(() => {
    frames = new Map();
    clock = 0;
    reduced = false;
    let nextFrame = 0;
    vi.stubGlobal("window", { matchMedia: () => ({ matches: reduced }) });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    size.clientWidth = 393;
    size.clientHeight = 620;
    camera = new THREE.PerspectiveCamera(50, size.clientWidth / size.clientHeight, 0.1, 10000);
    camera.position.set(160, 120, 400);
    controls = { target: new THREE.Vector3(), autoRotate: false, enableDamping: true, update() {} };
    camera.lookAt(controls.target);
    camera.updateMatrixWorld(true);
    state.container = size as HTMLElement;
    state.fg = {
      camera: () => camera,
      controls: () => controls,
      cameraPosition: (position: THREE.Vector3, target: THREE.Vector3) => {
        camera.position.copy(position);
        controls.target.copy(target);
        camera.lookAt(target);
        camera.updateMatrixWorld(true);
      },
    };
    state.fgNodeById.set("node", { id: "node", x: 40, y: -30, z: 15, raw: {} as never });
    state.fgNodeById.set("next", { id: "next", x: -80, y: 45, z: 30, raw: {} as never });
    setSelectionViewport({ bottomInset: 200, gap: 24 });
  });

  afterEach(() => {
    disposeSelectionCamera();
    state.fgNodeById.clear();
    state.fg = null;
    state.container = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([0.2, 1, 8])("projects the selected node into free space at camera scale %s", scale => {
    camera.position.multiplyScalar(scale);
    camera.updateMatrixWorld(true);
    const originalDepth = new THREE.Vector3(40, -30, 15).applyMatrix4(camera.matrixWorldInverse).z;
    frameSelection("node");
    settle();
    expect(project().x).toBeCloseTo(196.5);
    expect(project().y).toBeCloseTo(198);
    expect(new THREE.Vector3(40, -30, 15).applyMatrix4(camera.matrixWorldInverse).z).toBeCloseTo(originalDepth);
  });

  it("recomputes for long text, viewport changes and zoom buttons", () => {
    frameSelection("node");
    settle();
    setSelectionViewport({ bottomInset: 300, gap: 24 });
    settle();
    expect(project().y).toBeCloseTo(148);
    size.clientHeight = 480;
    camera.aspect = size.clientWidth / size.clientHeight;
    camera.updateProjectionMatrix();
    recenterSelection();
    settle();
    expect(project().y).toBeCloseTo(78);
    zoomCamera(1.4);
    settle();
    expect(project().y).toBeCloseTo(78);
    expect(project().x).toBeCloseTo(196.5);
  });

  it("restores the camera from before the first selection after stepping", () => {
    const position = camera.position.clone();
    const target = controls.target.clone();
    frameSelection("node");
    settle();
    frameSelection("next");
    settle();
    expect(project("next").y).toBeCloseTo(198);
    restoreSelectionCamera();
    settle();
    expect(camera.position.distanceTo(position)).toBeLessThan(0.000001);
    expect(controls.target.distanceTo(target)).toBeLessThan(0.000001);
  });

  it("retargets a growing card while the first selection is still animating", () => {
    frameSelection("node");
    clock = 60;
    const tick = [...frames.values()][0];
    frames.clear();
    tick(clock);
    setSelectionViewport({ bottomInset: 280, gap: 24 });
    settle();
    expect(project().y).toBeCloseTo(158);
    expect(frames.size).toBe(0);
  });

  it("brings a search result behind the camera into the free space", () => {
    state.fgNodeById.set("behind", { id: "behind", x: 800, y: 600, z: 2000, raw: {} as never });
    frameSelection("behind");
    settle();
    expect(project("behind").x).toBeCloseTo(196.5);
    expect(project("behind").y).toBeCloseTo(198);
  });

  it("jumps for Reduce Motion including resize and deselection", () => {
    reduced = true;
    const position = camera.position.clone();
    frameSelection("node");
    expect(project().y).toBeCloseTo(198);
    setSelectionViewport({ bottomInset: 300, gap: 24 });
    expect(project().y).toBeCloseTo(148);
    restoreSelectionCamera();
    expect(camera.position.distanceTo(position)).toBeLessThan(0.000001);
    expect(frames.size).toBe(0);
  });

  it("cancels an in-flight recenter and never pulls back during or after a drag", () => {
    frameSelection("node");
    clock = 60;
    const tick = [...frames.values()][0];
    frames.clear();
    tick(clock);
    beginCameraInteraction();
    expect(state.firstSettle).toBe(false);
    camera.position.x += 50;
    const dragged = camera.position.clone();
    setSelectionViewport({ bottomInset: 300, gap: 24 });
    settle();
    expect(camera.position.equals(dragged)).toBe(true);
    endCameraInteraction();
    setSelectionViewport({ bottomInset: 220, gap: 24 });
    settle();
    expect(camera.position.equals(dragged)).toBe(true);
    expect(controls.enableDamping).toBe(true);
    frameSelection("next");
    settle();
    expect(project("next").y).toBeCloseTo(188);
  });
});

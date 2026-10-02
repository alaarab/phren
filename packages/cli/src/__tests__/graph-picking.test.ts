import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => { vi.stubGlobal("window", {}); });
import { getNodeAt } from "../../browser/graph/interactions.js";
import { normalizeNode, state } from "../../browser/graph/state.js";

describe("graph picking between rendered frames", () => {
  afterEach(() => {
    state.fg = null;
    state.container = null;
    state.fgNodeById.clear();
    state.nodeById.clear();
  });

  it("picks a relaid-out sprite before the renderer updates its world matrix", () => {
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    camera.position.set(0, 0, 100);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    group.userData.phrenNodeId = "finding";
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial());
    sprite.scale.setScalar(10);
    group.add(sprite);
    scene.add(group);
    group.position.set(40, 0, 0);
    scene.updateMatrixWorld(true);
    // The new neighbourhood puts this node in the middle between render ticks.
    group.position.set(0, 0, 0);
    const node = normalizeNode({ id: "finding", label: "Finding", group: "topic:general" });
    state.nodeById.set(node.id, node);
    state.fgNodeById.set(node.id, { id: node.id, raw: node, x: 0, y: 0, z: 0 });
    state.container = { clientWidth: 400, clientHeight: 400 } as HTMLElement;
    state.fg = {
      camera: () => camera,
      scene: () => scene,
      graph2ScreenCoords: () => ({ x: 200, y: 200 }),
    };
    expect(getNodeAt(200, 200)?.id).toBe("finding");
    expect(getNodeAt(10, 10)).toBeNull();
    sprite.material.dispose();
  });
});

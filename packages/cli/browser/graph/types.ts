import type * as THREE from "three";
import type { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import type { GraphPayload, NodeDetail, RawLink, RawTopic, RuntimeNode } from "../../src/graph-core/types.js";

// The payload contract, palette and runtime-node types are shared with the
// terminal graph view; they live in src/graph-core and are re-exported here so
// the rest of the browser bundle keeps importing from "./types.js".
export * from "../../src/graph-core/types.js";

/** A node object handed to 3d-force-graph. Force layout mutates x/y/z/vx/vy/vz onto it. */
export type FGNode = {
  id: string;
  raw: RuntimeNode;
  x?: number;
  y?: number;
  z?: number;
  fx?: number;
  fy?: number;
  fz?: number;
  __group?: THREE.Group;
  __dot?: THREE.Sprite;
  __core?: THREE.Mesh;
  __shell?: THREE.Mesh;
  __wire?: THREE.Mesh;
  __ring?: THREE.Mesh;
  __halo?: THREE.Sprite;
  __labelObj?: CSS2DObject;
  __labelEl?: HTMLDivElement;
  __focusScale?: number;
  __phase?: number;
  /** Current dim intensity 0..1 applied to materials. */
  __int?: number;
  /** Target dim intensity the ambient loop lerps toward. */
  __intTarget?: number;
  /** Extra per-node stagger delay (seconds) used by the intro fade. */
  __introDelay?: number;
};

/** A link object handed to 3d-force-graph. Force layout swaps source/target to node refs. */
export type FGLink = { source: string | FGNode; target: string | FGNode };

export type SelectCallback = (node: NodeDetail, x: number, y: number) => void;
export type ClearCallback = () => void;

export type PhrenGraphApi = {
  __renderer: string;
  mount: (payload: GraphPayload) => void;
  onNodeSelect: (callback: SelectCallback) => void;
  onSelectionClear: (callback: ClearCallback) => void;
  onRightClick: (callback: (node: NodeDetail, x: number, y: number) => void) => void;
  onItemAction: (callback: (node: NodeDetail | NodeDetail[], action: string) => void) => void;
  clearSelection: () => void;
  selectNode: (nodeId: string) => boolean;
  focusNode: (nodeId: string) => boolean;
  peekNode: (nodeId: string) => void;
  walkTo: (nodeId: string) => boolean;
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

export const ROOT = window as unknown as {
  phrenGraph?: PhrenGraphApi;
  graphZoom?: (factor: number) => void;
  graphReset?: () => void;
  graphResetLayout?: () => void;
  graphClearSelection?: () => void;
};

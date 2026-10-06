/**
 * The graph in three dimensions.
 *
 * Not a second layout: the settled 2D map is lifted into a sphere. Projects
 * sit on a fibonacci sphere in stable order, each cluster keeps the shape the
 * force layout gave it and gains a seeded depth, fragments shared between
 * projects fall to the middle where their homes' centroid is, and orphans go
 * to an outer shell. Then a yaw/pitch camera with a little perspective
 * projects it, and depth comes back as brightness and size.
 *
 * Also here: the SGR mouse protocol, because drag-to-orbit is the whole
 * point. Pure functions throughout; the controller owns the state.
 */
import type { RawLink } from "../../graph-core/types.js";
import { type LayoutNode, type Point } from "./layout.js";
export interface Vec3 {
    x: number;
    y: number;
    z: number;
}
export interface OrbitCamera {
    /** Rotation about the vertical axis, radians. */
    yaw: number;
    /** Tilt toward the viewer, radians; clamped so the sphere never flips. */
    pitch: number;
    /** 1 fits the sphere to the viewport. */
    zoom: number;
}
export declare const DEFAULT_ORBIT: OrbitCamera;
export declare const PITCH_LIMIT = 1.25;
export interface OrbitLayout {
    positions: Map<string, Vec3>;
    /** Radius of the project sphere, in world units. */
    radius: number;
}
/** Lift the 2D layout onto a sphere. Deterministic for the same inputs. */
export declare function buildOrbitLayout(nodes: LayoutNode[], links: RawLink[], flat: Map<string, Point>): OrbitLayout;
export interface Projected {
    x: number;
    y: number;
    /** 0 nearest the viewer, 1 farthest. */
    t: number;
}
/** World point → dot coordinates, with depth. */
export declare function projectOrbit(v: Vec3, cam: OrbitCamera, viewport: {
    width: number;
    height: number;
}, radius: number): Projected;
/** The yaw that brings a point to the front, facing the viewer. */
export declare function yawToFace(v: Vec3): number;
/** Shortest signed distance from yaw a to yaw b. */
export declare function yawDelta(a: number, b: number): number;
export type MouseEvent = {
    type: "press";
    button: number;
    col: number;
    row: number;
} | {
    type: "drag";
    button: number;
    col: number;
    row: number;
} | {
    type: "release";
    button: number;
    col: number;
    row: number;
} | {
    type: "wheel";
    delta: -1 | 1;
    col: number;
    row: number;
};
/**
 * SGR mouse reporting (mode 1006): `ESC [ < b ; x ; y M` for a press or
 * motion, `m` for a release. Bit 5 of b marks motion, bit 6 the wheel.
 * Coordinates are 1-based; returned 0-based.
 */
export declare function parseMouse(key: string): MouseEvent | null;
export declare const MOUSE_ON = "\u001B[?1000h\u001B[?1002h\u001B[?1006h";
export declare const MOUSE_OFF = "\u001B[?1006l\u001B[?1002l\u001B[?1000l";

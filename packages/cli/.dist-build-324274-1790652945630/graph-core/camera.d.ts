export type FreeSpaceViewport = {
    width: number;
    height: number;
    topInset?: number;
    /** Everything below the panel's top, including any tab bar inside the viewport. */
    bottomInset: number;
    gap?: number;
};
/** Center the node in the usable rectangle, reserving breathing room above the card. */
export declare function freeSpaceCenter(viewport: FreeSpaceViewport): {
    x: number;
    y: number;
};
/** Camera-plane offset whose perspective projection lands at the given pixel. */
export declare function perspectivePlaneOffset(point: {
    x: number;
    y: number;
}, viewport: {
    width: number;
    height: number;
}, depth: number, verticalFovDegrees: number, zoom?: number): {
    x: number;
    y: number;
};

/** Center the node in the usable rectangle, reserving breathing room above the card. */
export function freeSpaceCenter(viewport) {
    const width = Math.max(1, viewport.width);
    const height = Math.max(1, viewport.height);
    const top = Math.min(height, Math.max(0, viewport.topInset ?? 0));
    const bottom = Math.max(top, height - Math.max(0, viewport.bottomInset) - Math.max(0, viewport.gap ?? 24));
    return { x: width / 2, y: (top + bottom) / 2 };
}
/** Camera-plane offset whose perspective projection lands at the given pixel. */
export function perspectivePlaneOffset(point, viewport, depth, verticalFovDegrees, zoom = 1) {
    const width = Math.max(1, viewport.width);
    const height = Math.max(1, viewport.height);
    const halfHeight = depth * Math.tan(verticalFovDegrees * Math.PI / 360) / zoom;
    return {
        x: (point.x * 2 / width - 1) * halfHeight * width / height,
        y: (1 - point.y * 2 / height) * halfHeight,
    };
}

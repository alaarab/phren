/**
 * Screen-space label collision resolution shared by the browser 3D viewer
 * (and unit-testable without a DOM). Pure rectangle logic: hosts project
 * their labels to screen space, call `resolveLabelOverlaps` each frame, and
 * hide whatever comes back outside the returned set.
 *
 * Must stay free of DOM, node builtins, and imports outside `src/graph-core/`.
 */
export type LabelRect = {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
};
export type LabelCandidate = {
    id: string;
    rect: LabelRect;
    /** Project/group labels: always outrank leaves and never yield to them. */
    isGroup: boolean;
    /** Node degree; higher wins within a tier after `priority` and stickiness. */
    degree: number;
    /** Recency in ms (newer first); tie-break after `degree`. */
    recency: number;
    /** Focus/hover/search boost applied before stickiness within a tier. */
    priority?: number;
};
export type LabelResolveOptions = {
    /**
     * Maximum labels (groups and leaves together) kept this frame, scaled to
     * the viewport by the host. Groups sort first so landmarks claim slots
     * before leaves; `labelDrawCap`'s floor keeps a typical project count
     * drawable on a phone-sized canvas.
     */
    cap: number;
    /** Ids visible last frame; sticky under hysteresis and cap pressure. */
    previousVisible?: ReadonlySet<string>;
    /** Extra pixels between rectangles (readability margin). Default 0. */
    pad?: number;
    /**
     * Show/hide dead band in pixels, leaf-versus-leaf only: a previously-visible
     * leaf shrinks by this before testing (marginal overlaps do not drop it), a
     * newly shown leaf expands by this (it needs clearance to appear). Leaves
     * always yield to groups on an exact intersection. Default 3.
     */
    hysteresisPx?: number;
    /**
     * Cleared and filled with the visible ids instead of allocating a new Set.
     * Must not be the same object as `previousVisible` (the previous set is
     * read while `into` is written).
     */
    into?: Set<string>;
};
export type LabelDrawCapOptions = {
    /** Pixel area divisor: one label slot per `areaPerLabel` pixels squared. */
    areaPerLabel?: number;
    min?: number;
    max?: number;
};
export declare function rectsIntersect(a: LabelRect, b: LabelRect): boolean;
/**
 * Viewport-scaled budget for labels drawn in one frame. Groups count toward
 * the cap; the default floor of 40 keeps a full project navigator (up to the
 * survey's 40-project stores) drawable on a phone-sized viewport where pure
 * area scaling would allow only ~29 slots.
 */
export declare function labelDrawCap(width: number, height: number, options?: LabelDrawCapOptions): number;
/**
 * Greedy placement in rank order. Group labels always win: they are placed
 * first with exact rectangles and a leaf that intersects any group is hidden.
 * Within a tier `priority`, stickiness, then degree, then recency decide.
 * Leaf-versus-leaf conflicts use `hysteresisPx` so a shown label does not
 * flicker out on a marginal overlap while a new label needs clearance before
 * it appears. Duplicate ids keep the first candidate. The cap counts every
 * label; when it is full the loop `continue`s (never `break`s) so a group
 * that somehow sorts late is still tested rather than abandoned mid-list.
 */
export declare function resolveLabelOverlaps(candidates: readonly LabelCandidate[], options: LabelResolveOptions): Set<string>;

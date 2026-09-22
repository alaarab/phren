/**
 * Screen-space label collision resolution shared by the browser 3D viewer
 * (and unit-testable without a DOM). Pure rectangle logic: hosts project
 * their labels to screen space, call `resolveLabelOverlaps` each frame, and
 * hide whatever comes back outside the returned set.
 *
 * Must stay free of DOM, node builtins, and imports outside `src/graph-core/`.
 */

export type LabelRect = { x0: number; y0: number; x1: number; y1: number };

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

function expand(rect: LabelRect, by: number): LabelRect {
  if (by <= 0) return rect;
  return { x0: rect.x0 - by, y0: rect.y0 - by, x1: rect.x1 + by, y1: rect.y1 + by };
}

function shrink(rect: LabelRect, by: number): LabelRect {
  if (by <= 0) return rect;
  const x0 = rect.x0 + by;
  const y0 = rect.y0 + by;
  const x1 = rect.x1 - by;
  const y1 = rect.y1 - by;
  // Degenerate after erosion: report an empty rect, never an inverted one
  // (an inverted rect can falsely "intersect" a large neighbour).
  if (x1 <= x0 || y1 <= y0) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return { x0, y0, x1, y1 };
}

export function rectsIntersect(a: LabelRect, b: LabelRect): boolean {
  if (a.x1 <= a.x0 || a.y1 <= a.y0 || b.x1 <= b.x0 || b.y1 <= b.y0) return false;
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

/**
 * Viewport-scaled budget for labels drawn in one frame. Groups count toward
 * the cap; the default floor of 40 keeps a full project navigator (up to the
 * survey's 40-project stores) drawable on a phone-sized viewport where pure
 * area scaling would allow only ~29 slots.
 */
export function labelDrawCap(width: number, height: number, options: LabelDrawCapOptions = {}): number {
  const areaPerLabel = options.areaPerLabel ?? 10000;
  const min = options.min ?? 40;
  const max = options.max ?? 72;
  const area = Math.max(1, width) * Math.max(1, height);
  return Math.min(max, Math.max(min, Math.round(area / areaPerLabel)));
}

function compareLabels(a: LabelCandidate, b: LabelCandidate, previous: ReadonlySet<string> | undefined): number {
  // Invariant: `isGroup` first. The shared budget then always fills with
  // landmark groups before any leaf, so a comparator tweak that lifts
  // `priority` above `isGroup` cannot starve groups at the cap edge.
  if (a.isGroup !== b.isGroup) return a.isGroup ? -1 : 1;
  const pa = a.priority ?? 0;
  const pb = b.priority ?? 0;
  if (pa !== pb) return pb - pa;
  // Stickiness before degree/recency: a shown label holds its slot under cap
  // pressure and rank churn instead of flickering out and needing clearance
  // to return.
  const sa = previous?.has(a.id) ? 1 : 0;
  const sb = previous?.has(b.id) ? 1 : 0;
  if (sa !== sb) return sb - sa;
  if (a.degree !== b.degree) return b.degree - a.degree;
  if (a.recency !== b.recency) return b.recency - a.recency;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

type Placed = { rect: LabelRect; isGroup: boolean };

// Reused across calls so a 60fps host does not allocate a sort buffer per frame.
const scratchOrdered: LabelCandidate[] = [];
const scratchSeen = new Set<string>();

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
export function resolveLabelOverlaps(
  candidates: readonly LabelCandidate[],
  options: LabelResolveOptions,
): Set<string> {
  const previous = options.previousVisible;
  const pad = options.pad ?? 0;
  const hyst = options.hysteresisPx ?? 3;
  const cap = Math.max(0, options.cap);
  const into = options.into ?? new Set<string>();
  into.clear();

  scratchOrdered.length = 0;
  for (const candidate of candidates) scratchOrdered.push(candidate);
  scratchOrdered.sort((a, b) => compareLabels(a, b, previous));

  scratchSeen.clear();
  const placed: Placed[] = [];

  for (const candidate of scratchOrdered) {
    if (into.size >= cap) continue;
    if (scratchSeen.has(candidate.id)) continue;
    scratchSeen.add(candidate.id);
    const rect = expand(candidate.rect, pad);
    const wasVisible = previous?.has(candidate.id) ?? false;
    let blocked = false;
    for (const p of placed) {
      if (candidate.isGroup || p.isGroup) {
        // Cross-tier and group-versus-group: exact rectangles only.
        if (rectsIntersect(rect, p.rect)) {
          blocked = true;
          break;
        }
        continue;
      }
      const test = wasVisible ? shrink(rect, hyst) : expand(rect, hyst);
      if (rectsIntersect(test, p.rect)) {
        blocked = true;
        break;
      }
    }
    if (!blocked) {
      into.add(candidate.id);
      placed.push({ rect, isGroup: candidate.isGroup });
    }
  }
  return into;
}

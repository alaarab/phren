// Which tabs a tab's context menu acts on, and which entries it offers. Pure:
// no DOM, no store. shell/tiles.js builds the menu from it; ids are document ids
// in tab-bar order (left to right) within ONE tile.

/** The ids "Close others" / "Close to the right" close, in the order to close them: rightmost first. */
export function closeTargets(order, id, mode) {
  const at = order.indexOf(id);
  if (at < 0) return [];
  const picked = mode === "others" ? order.filter((other) => other !== id)
    : mode === "right" ? order.slice(at + 1)
      : [];
  // Right to left: each close leaves the earlier tabs' positions alone, so a chat reopens at the
  // position it had and the reopen stack (newest last) hands them back left to right.
  return picked.reverse();
}

/**
 * The menu's core entries for the tab `id`: `{ id, label, enabled }`. An entry that would do
 * nothing stays listed but disabled, so the menu keeps one shape. `order` is the tab's tile.
 */
export function tabMenuItems(order, id) {
  const at = order.indexOf(id);
  if (at < 0) return [];
  return [
    { id: "close", label: "Close", enabled: true },
    { id: "others", label: "Close others", enabled: order.length > 1 },
    { id: "right", label: "Close to the right", enabled: at < order.length - 1 },
    // A lone tab split off its own tile changes nothing.
    { id: "split", label: "Move to new split (right)", enabled: order.length > 1 },
  ];
}

/**
 * Split the targets into tabs that close now and tabs holding unsaved changes. Only the first
 * dirty one is asked about (one prompt at a time); the rest stay open and are counted.
 */
export function planClose(ids, isDirty) {
  const clean = [];
  const dirty = [];
  for (const id of ids) (isDirty(id) ? dirty : clean).push(id);
  return { clean, ask: dirty[0] ?? null, kept: Math.max(0, dirty.length - 1) };
}

/** What the menu says after a bulk close left tabs open: null when nothing did. */
export function keptNotice(kept) {
  return kept > 0 ? `${kept} more ${kept === 1 ? "tab has" : "tabs have"} unsaved changes and stayed open` : null;
}

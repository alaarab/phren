// Stepping through the focused tile's tabs from the keyboard. Pure: no DOM, no store.

/**
 * The tab `delta` places from `activeId` in `order` (tab ids left to right), wrapping at both
 * ends. With no active tab, forward goes to the first and back to the last. Null for no tabs.
 */
export function stepTarget(order, activeId, delta) {
  if (!order.length) return null;
  const at = order.indexOf(activeId);
  if (at < 0) return delta < 0 ? order[order.length - 1] : order[0];
  return order[(((at + delta) % order.length) + order.length) % order.length];
}

/** Whether the focused widget (a terminal, editor or iframe) keeps the press: it owns it, whatever the modifiers. */
export function widgetKeepsTabKey(owned) {
  return !!owned;
}

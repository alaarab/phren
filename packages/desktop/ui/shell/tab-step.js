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

/** Whether tab stepping leaves a Ctrl+Tab press (a rebinding) to the recent-chat switcher, which owns it while on. */
export function recentOwnsKey(ev, recentOn) {
  return !!recentOn && ev.key === "Tab" && !!ev.ctrlKey && !ev.altKey && !ev.metaKey;
}

/** Whether a direct binding without Ctrl, Alt or Cmd stays text: it never fires while the user is typing. */
export function typedKeyStaysText(ev, typingNow) {
  return !!typingNow && !(ev.ctrlKey || ev.altKey || ev.metaKey);
}

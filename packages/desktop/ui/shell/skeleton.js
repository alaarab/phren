// Placeholder shapes shown while a section's first read is in flight, so the
// layout is already where the content will land. Styles: theme.css `.skel`.

/**
 * `count` placeholder items of class `itemClass`, each holding one bar per
 * width in `widths` (CSS lengths); a list of lists gives successive items
 * their own widths, cycling, so a column of rows doesn't look stamped. The wrapper carries the busy state and the
 * `label` screen readers hear instead of the shapes.
 */
export function skeleton({ count, itemClass, widths, wrapClass = "", label }) {
  const wrap = document.createElement("div");
  wrap.className = `skel-wrap${wrapClass ? ` ${wrapClass}` : ""}`;
  wrap.setAttribute("aria-busy", "true");
  wrap.setAttribute("role", "status");
  wrap.setAttribute("aria-label", label);
  for (let i = 0; i < count; i++) {
    const item = document.createElement("div");
    item.className = `${itemClass} skel-item`;
    item.setAttribute("aria-hidden", "true");
    const row = Array.isArray(widths[0]) ? widths[i % widths.length] : widths;
    for (const width of row) {
      const bar = document.createElement("span");
      bar.className = "skel";
      bar.style.width = width;
      item.append(bar);
    }
    wrap.append(item);
  }
  return wrap;
}

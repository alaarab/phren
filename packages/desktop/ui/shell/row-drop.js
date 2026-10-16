// Dropping files on a sidebar chat row: which drags count, the hint the row
// shows, and a single highlight that every way of ending a drag clears.
//
//   carriesFiles(dataTransfer) -> boolean
//   dropHint(title) -> "Attach to <title>"
//   leftRow(node, relatedTarget) -> boolean
//   createRowDrop(doc?) -> { over(node, title), clear(), active() }

/** True when the drag carries OS files (not a tab, text or link). */
export function carriesFiles(dataTransfer) {
  return Array.from(dataTransfer?.types || []).includes("Files");
}

/** The hint shown over the target row; a long title is cut by CSS, not here. */
export function dropHint(title) {
  const name = String(title || "").trim();
  return name ? `Attach to ${name}` : "Attach to this chat";
}

/** True when the pointer left `node` for something outside it (or the window). */
export function leftRow(node, related) {
  return !(related && node.contains(related));
}

/**
 * One highlighted row at a time. Escape, a drag that ends elsewhere, or the
 * pointer leaving the row clears it.
 */
export function createRowDrop(doc = document) {
  let current = null;
  let tip = null;
  function onKey(event) { if (event.key === "Escape") clear(); }
  // The hint floats beside the row (fixed, outside the sidebar's own clipping), so a narrow icon rail never cuts it.
  function showTip(node, text) {
    if (!tip) { tip = doc.createElement("div"); tip.className = "sb-drop-hint"; tip.setAttribute("role", "status"); doc.body.append(tip); }
    tip.textContent = text;
    const rect = node.getBoundingClientRect?.() || { right: 0, top: 0, height: 0 };
    const left = rect.right + 8;
    tip.style.left = `${left}px`;
    tip.style.top = `${rect.top + rect.height / 2}px`;
    tip.style.maxWidth = `${Math.max(120, Math.min(280, (doc.defaultView?.innerWidth || 1024) - left - 8))}px`;
  }
  function clear() {
    if (!current) return;
    current.classList.remove("sb-drop");
    current.removeAttribute("data-drop-hint");
    current = null;
    tip?.remove();
    tip = null;
    doc.removeEventListener("keydown", onKey, true);
    doc.removeEventListener("dragend", clear, true);
    doc.removeEventListener("drop", clear, true);
  }
  return {
    over(node, title) {
      if (current !== node) {
        clear();
        current = node;
        doc.addEventListener("keydown", onKey, true);
        doc.addEventListener("dragend", clear, true);
        doc.addEventListener("drop", clear, true);
      }
      node.classList.add("sb-drop");
      const text = dropHint(title);
      node.setAttribute("data-drop-hint", text);
      showTip(node, text);
    },
    clear,
    active: () => current,
  };
}

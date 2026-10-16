// Dropping files on a sidebar chat row: which drags count, the hint the row
// shows, and a single highlight that every way of ending a drag clears.
//
//   carriesFiles(dataTransfer) -> boolean
//   dropHint(title) -> "Attach to <title>"
//   leftRow(node, relatedTarget) -> boolean
//   placeHint(rect, size, viewport) -> { left, top }
//   createRowDrop(doc?) -> { over(node, title), clear(), sweep(), active() }

const GAP = 8;

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
 * Where the hint chip goes: beside the row on its right, flipped to the left
 * when it would pass the viewport's right edge, centered on the row and
 * clamped so no edge leaves the viewport.
 */
export function placeHint(rect, size, viewport) {
  let left = rect.right + GAP;
  if (left + size.width > viewport.width - GAP) left = rect.left - GAP - size.width;
  left = Math.max(GAP, Math.min(left, viewport.width - GAP - size.width));
  const top = Math.max(GAP, Math.min(rect.top + rect.height / 2 - size.height / 2, viewport.height - GAP - size.height));
  return { left, top };
}

/**
 * One highlighted row at a time, and one persistent hint chip. Escape, a drag
 * that ends elsewhere, the pointer leaving the row or the row leaving the DOM
 * (`sweep`) clears it.
 */
export function createRowDrop(doc = document) {
  let current = null;
  let tip = null;
  function onKey(event) { if (event.key === "Escape") clear(); }
  function ensureTip() {
    if (tip) return tip;
    tip = doc.createElement("div");
    tip.className = "sb-drop-hint";
    tip.setAttribute("aria-live", "polite");
    doc.body.append(tip);
    return tip;
  }
  // The chip floats beside the row (fixed, outside the sidebar's clipping), so a narrow icon rail never cuts it.
  function showTip(node, text) {
    const chip = ensureTip();
    const view = doc.defaultView || { innerWidth: 1024, innerHeight: 768 };
    chip.style.maxWidth = `${Math.max(120, Math.min(280, view.innerWidth - 2 * GAP))}px`;
    chip.textContent = text;
    chip.classList.add("show");
    const rect = node.getBoundingClientRect?.() || { left: 0, right: 0, top: 0, height: 0 };
    const at = placeHint(rect, { width: chip.offsetWidth || 0, height: chip.offsetHeight || 0 }, { width: view.innerWidth, height: view.innerHeight });
    chip.style.left = `${at.left}px`;
    chip.style.top = `${at.top}px`;
  }
  function clear() {
    if (!current) return;
    current.classList.remove("sb-drop");
    current = null;
    if (tip) { tip.classList.remove("show"); tip.textContent = ""; }
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
      showTip(node, dropHint(title));
    },
    clear,
    /** Clear when the highlighted row has been removed from the page. */
    sweep() { if (current && current.isConnected === false) clear(); },
    active: () => current,
  };
}

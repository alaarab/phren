// The Projects section's modal sheet and its form controls.
import { el } from "../../dom.js";

export function createSheets() {

  let openSheetEl = null;
  const current = () => openSheetEl;

  function openSheet(title, { width = 460 } = {}) {
    closeSheet();
    const backdrop = el("div", "pj-backdrop");
    const panel = el("div", "pj-sheet");
    panel.style.maxWidth = `${width}px`;
    const head = el("div", "pj-sheet-head");
    const heading = el("h2", "pj-sheet-title", title);
    const close = el("button", "pj-icon", "\u00d7");
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", closeSheet);
    head.append(heading, el("span", "pj-spacer"), close);
    const bodyEl = el("div", "pj-sheet-body");
    const footer = el("div", "pj-sheet-footer");
    panel.append(head, bodyEl, footer);
    backdrop.append(panel);
    backdrop.addEventListener("mousedown", (event) => { if (event.target === backdrop) closeSheet(); });
    const onKey = (event) => { if (event.key === "Escape") closeSheet(); };
    document.addEventListener("keydown", onKey);
    document.body.append(backdrop);
    openSheetEl = { backdrop, onKey };
    return { bodyEl, footer };
  }

  function closeSheet() {
    if (!openSheetEl) return;
    document.removeEventListener("keydown", openSheetEl.onKey);
    openSheetEl.onClose?.();
    openSheetEl.backdrop.remove();
    openSheetEl = null;
  }

  function field(labelText, control) {
    const wrap = el("label", "pj-field");
    wrap.append(el("span", "pj-field-label", labelText));
    wrap.append(control);
    return wrap;
  }

  function selectEl(options, selected) {
    const select = document.createElement("select");
    select.className = "pj-select wide";
    for (const [value, label] of options) {
      const option = el("option", null, label);
      option.value = value;
      select.append(option);
    }
    select.value = selected ?? options[0]?.[0] ?? "";
    return select;
  }

  function noticeBox() {
    const box = el("div", "pj-notice");
    box.hidden = true;
    return box;
  }

  function setNotice(box, text, danger) {
    box.textContent = text;
    box.className = danger ? "pj-notice danger" : "pj-notice";
    box.hidden = !text;
  }

  return { openSheet, closeSheet, field, selectEl, noticeBox, setNotice, current };
}

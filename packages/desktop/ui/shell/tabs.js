// Centre document tabs: chats, files, diffs, consoles, terminals, settings
// pages. A document stays mounted while its tab is hidden, and can move
// between tab groups (tiles) without remounting, so a chat keeps its sockets.
//
// A document: { id, kind, title, subtitle?, mount(el) -> { close(), focus?(), show?(), hide?() }, persist? }
// `persist` is a small JSON-able value saved for restore on relaunch.

import { reopenPosition } from "./closed-tabs.js";
import { stepTarget } from "./tab-step.js";

const STORAGE_KEY = "phren.desktop.tabs";

/**
 * options.storageKey: localStorage key for the open-tab list, or null to not
 * save (tiles save the whole layout instead). options.onFocus: called on any
 * pointer interaction inside the group. options.onMenu(doc, { x, y, tab }): a
 * right-click, Shift+F10 or the context-menu key on a tab (x/y: where to put it).
 */
export function createTabs(barEl, bodyEl, { onActivate, onEmpty, onClose, onClosing, onChange, onMenu, storageKey = STORAGE_KEY } = {}) {
  const docs = new Map(); // id -> entry { doc, tab, el, handle, owner }
  let active = null;

  barEl.classList.add("doc-tabs");
  barEl.setAttribute("role", "tablist");

  function save() {
    onChange?.();
    if (storageKey === null) return;
    try {
      const list = [...docs.values()].filter((d) => d.doc.persist).map((d) => ({ kind: d.doc.kind, ...d.doc.persist }));
      localStorage.setItem(storageKey, JSON.stringify({ list, active }));
    } catch { /* storage unavailable */ }
  }

  function buildTab(entry) {
    const { doc } = entry;
    const tab = document.createElement("div");
    tab.className = `doc-tab doc-tab-${doc.kind}`;
    tab.setAttribute("role", "tab");
    tab.draggable = true;
    tab.dataset.doc = doc.id;
    const label = document.createElement("span");
    label.className = "doc-tab-title";
    const close = document.createElement("button");
    close.className = "doc-tab-close";
    close.title = "Close tab";
    close.setAttribute("aria-label", "Close tab");
    close.textContent = "×";
    // Handlers go through entry.owner, so a tab moved to another group talks to it.
    close.addEventListener("click", (ev) => { ev.stopPropagation(); entry.owner.close(doc.id); });
    tab.append(label, close);
    tab.tabIndex = -1; // roving: the selected tab is the one tab stop (see activate)
    tab.addEventListener("click", () => entry.owner.activate(doc.id));
    // Right-click and the keyboard route share one opener; Chromium may also send a contextmenu
    // event for the key we already handled, so one that follows it closely is swallowed.
    let keyedAt = 0;
    const openMenu = (x, y) => entry.owner.menu?.(doc.id, { x, y, tab });
    tab.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      if (Date.now() - keyedAt < 400) return;
      const r = tab.getBoundingClientRect();
      const keyboard = ev.clientX === 0 && ev.clientY === 0; // from the keyboard: no pointer position
      openMenu(keyboard ? r.left : ev.clientX, keyboard ? r.bottom : ev.clientY);
    });
    tab.addEventListener("keydown", (ev) => {
      if (ev.target !== tab) return; // the close button keeps its own keys
      // Roving focus along the tab bar; Enter / Space activate the focused tab.
      const move = { ArrowRight: 1, ArrowLeft: -1, Home: "first", End: "last" }[ev.key];
      if (move !== undefined) {
        const tabs = [...(tab.parentElement?.children ?? [])]; // the bar it is in now: a moved tab changed bars
        const at = tabs.indexOf(tab);
        const next = move === "first" ? 0 : move === "last" ? tabs.length - 1 : (at + move + tabs.length) % tabs.length;
        ev.preventDefault();
        ev.stopPropagation();
        tabs[next]?.focus();
        return;
      }
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); entry.owner.activate(doc.id); return; }
      if (!(ev.key === "ContextMenu" || (ev.key === "F10" && ev.shiftKey))) return;
      ev.preventDefault();
      ev.stopPropagation();
      keyedAt = Date.now();
      const r = tab.getBoundingClientRect();
      openMenu(r.left, r.bottom);
    });
    tab.addEventListener("auxclick", (ev) => { if (ev.button === 1) entry.owner.close(doc.id); });
    tab.addEventListener("dragstart", (ev) => {
      ev.dataTransfer.setData("text/phren-tab", doc.id);
      ev.dataTransfer.effectAllowed = "move";
    });
    tab.addEventListener("dragover", (ev) => { if (ev.dataTransfer.types.includes("text/phren-tab")) ev.preventDefault(); });
    tab.addEventListener("drop", (ev) => {
      const from = ev.dataTransfer.getData("text/phren-tab");
      const moved = docs.get(from)?.tab;
      if (moved && moved !== tab) { ev.preventDefault(); ev.stopPropagation(); barEl.insertBefore(moved, tab); save(); }
    });
    return tab;
  }

  /** One tab stop for the bar: the selected tab, or the first when none is selected. */
  function syncTabStops() {
    const tabs = [...barEl.children];
    const stop = tabs.find((t) => t.classList.contains("selected")) ?? tabs[0];
    for (const t of tabs) t.tabIndex = t === stop ? 0 : -1;
  }

  function open(doc, { background = false, at, after } = {}) {
    let entry = docs.get(doc.id);
    if (!entry) {
      const el = document.createElement("div");
      el.className = `doc doc-${doc.kind}`;
      el.hidden = true;
      bodyEl.append(el);
      entry = { doc, tab: null, el, handle: null, owner: api };
      entry.tab = buildTab(entry);
      // Back next to the tab that was on its left when `after` still names one here, else at index `at`.
      const pos = reopenPosition([...barEl.children].map((t) => t.dataset.doc), { index: at, after });
      barEl.insertBefore(entry.tab, Number.isInteger(pos) ? barEl.children[pos] ?? null : null);
      docs.set(doc.id, entry);
      setTitle(doc.id, doc.title, doc.subtitle);
      entry.handle = doc.mount(el) ?? {};
    }
    if (!background) activate(doc.id);
    syncTabStops();
    save();
    return entry.handle;
  }

  function setTitle(id, title, subtitle) {
    const entry = docs.get(id);
    if (!entry) return;
    entry.doc.title = title;
    if (subtitle !== undefined) entry.doc.subtitle = subtitle;
    entry.tab.querySelector(".doc-tab-title").textContent = title || "Untitled";
    entry.tab.title = entry.doc.subtitle ? `${title} · ${entry.doc.subtitle}` : title;
    document.dispatchEvent(new Event("phren:tabs-changed")); // the window title follows a rename (it reads the focused tab only)
  }

  function activate(id) {
    const entry = docs.get(id);
    if (!entry) return;
    for (const [other, e] of docs) {
      const on = other === id;
      if (e.el.hidden === on) {
        e.el.hidden = !on;
        if (on) e.handle.show?.(); else e.handle.hide?.();
      }
      e.tab.classList.toggle("selected", on);
      e.tab.setAttribute("aria-selected", String(on));
    }
    syncTabStops();
    active = id;
    entry.tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    entry.handle.focus?.();
    onActivate?.(entry.doc, entry.handle);
    save();
  }

  /** Remove a tab from this group, returning its entry still mounted (for adopt). */
  function detach(id) {
    const entry = docs.get(id);
    if (!entry) return null;
    const order = [...barEl.children].map((t) => t.dataset.doc);
    const index = order.indexOf(id);
    entry.tab.remove();
    entry.el.remove();
    docs.delete(id);
    syncTabStops();
    if (active === id) {
      active = null;
      const next = order[index + 1] ?? order[index - 1];
      if (next && docs.has(next)) activate(next);
      else onEmpty?.();
    }
    save();
    return entry;
  }

  /** Take a mounted entry from another group. */
  function adopt(entry, { background = false } = {}) {
    entry.owner = api;
    entry.el.hidden = true;
    barEl.append(entry.tab);
    bodyEl.append(entry.el);
    docs.set(entry.doc.id, entry);
    syncTabStops();
    if (!background) activate(entry.doc.id);
    save();
  }

  function closeTab(id = active) {
    const entry = docs.get(id);
    if (!entry) return false;
    const order = [...barEl.children].map((t) => t.dataset.doc);
    const index = order.indexOf(id);
    onClosing?.(entry.doc, { index, after: index > 0 ? order.slice(0, index).reverse() : undefined });
    try { entry.handle.close?.(); } catch { /* already closed */ }
    detach(id);
    onClose?.(entry.doc);
    return true;
  }

  function step(delta) {
    const target = stepTarget([...barEl.children].map((t) => t.dataset.doc), active, delta);
    if (!target || target === active) return false; // nothing to go to
    activate(target);
    return true;
  }

  /** The saved tab list from the last run: [{ kind, ...persist }] and the active id. */
  function saved() {
    if (storageKey === null) return { list: [], active: null };
    try { return JSON.parse(localStorage.getItem(storageKey) ?? "null") ?? { list: [], active: null }; }
    catch { return { list: [], active: null }; }
  }

  const api = {
    menu: (id, at) => onMenu?.(docs.get(id)?.doc, at),
    open, activate, close: closeTab, step, setTitle, saved, detach, adopt,
    has: (id) => docs.has(id),
    size: () => docs.size,
    activeId: () => active,
    active: () => (active ? docs.get(active)?.doc ?? null : null),
    activeHandle: () => (active ? docs.get(active)?.handle ?? null : null),
    handle: (id) => docs.get(id)?.handle ?? null,
    list: () => [...barEl.children].map((t) => docs.get(t.dataset.doc)?.doc).filter(Boolean),
  };
  return api;
}

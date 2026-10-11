// Centre document tabs: chats, files, diffs, consoles, terminals, settings
// pages. A document stays mounted while its tab is hidden, and can move
// between tab groups (tiles) without remounting, so a chat keeps its sockets.
//
// A document: { id, kind, title, subtitle?, mount(el) -> { close(), focus?(), show?(), hide?() }, persist? }
// `persist` is a small JSON-able value saved for restore on relaunch.

const STORAGE_KEY = "phren.desktop.tabs";

/**
 * options.storageKey: localStorage key for the open-tab list, or null to not
 * save (tiles save the whole layout instead). options.onFocus: called on any
 * pointer interaction inside the group.
 */
export function createTabs(barEl, bodyEl, { onActivate, onEmpty, onClose, onChange, storageKey = STORAGE_KEY } = {}) {
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
    tab.addEventListener("click", () => entry.owner.activate(doc.id));
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

  function open(doc, { background = false } = {}) {
    let entry = docs.get(doc.id);
    if (!entry) {
      const el = document.createElement("div");
      el.className = `doc doc-${doc.kind}`;
      el.hidden = true;
      bodyEl.append(el);
      entry = { doc, tab: null, el, handle: null, owner: api };
      entry.tab = buildTab(entry);
      barEl.append(entry.tab);
      docs.set(doc.id, entry);
      setTitle(doc.id, doc.title, doc.subtitle);
      entry.handle = doc.mount(el) ?? {};
    }
    if (!background) activate(doc.id);
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
    if (!background) activate(entry.doc.id);
    save();
  }

  function closeTab(id = active) {
    const entry = docs.get(id);
    if (!entry) return false;
    try { entry.handle.close?.(); } catch { /* already closed */ }
    detach(id);
    onClose?.(entry.doc);
    return true;
  }

  function step(delta) {
    const order = [...barEl.children].map((t) => t.dataset.doc);
    if (!order.length) return;
    const i = order.indexOf(active);
    activate(order[(i + delta + order.length) % order.length]);
  }

  /** The saved tab list from the last run: [{ kind, ...persist }] and the active id. */
  function saved() {
    if (storageKey === null) return { list: [], active: null };
    try { return JSON.parse(localStorage.getItem(storageKey) ?? "null") ?? { list: [], active: null }; }
    catch { return { list: [], active: null }; }
  }

  const api = {
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

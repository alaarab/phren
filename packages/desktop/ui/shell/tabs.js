// Centre document tabs: chats, files, diffs, a whole terminal server,
// settings pages. A document stays mounted while its tab is hidden.
//
// A document: { id, kind, title, subtitle?, mount(el) -> { close(), focus?(), show?(), hide?() }, persist? }
// `persist` is a small JSON-able value saved for restore on relaunch.

const STORAGE_KEY = "phren.desktop.tabs";

export function createTabs(barEl, bodyEl, { onActivate, onEmpty, onClose } = {}) {
  const docs = new Map(); // id -> { doc, tab, el, handle }
  let active = null;

  barEl.classList.add("doc-tabs");
  barEl.setAttribute("role", "tablist");

  function save() {
    try {
      const list = [...docs.values()].filter((d) => d.doc.persist).map((d) => ({ kind: d.doc.kind, ...d.doc.persist }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ list, active }));
    } catch { /* storage unavailable */ }
  }

  function open(doc, { background = false } = {}) {
    let entry = docs.get(doc.id);
    if (!entry) {
      const el = document.createElement("div");
      el.className = `doc doc-${doc.kind}`;
      el.hidden = true;
      bodyEl.append(el);
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
      close.addEventListener("click", (ev) => { ev.stopPropagation(); closeTab(doc.id); });
      tab.append(label, close);
      tab.addEventListener("click", () => activate(doc.id));
      tab.addEventListener("auxclick", (ev) => { if (ev.button === 1) closeTab(doc.id); });
      tab.addEventListener("dragstart", (ev) => { ev.dataTransfer.setData("text/phren-tab", doc.id); });
      tab.addEventListener("dragover", (ev) => ev.preventDefault());
      tab.addEventListener("drop", (ev) => {
        ev.preventDefault();
        const from = ev.dataTransfer.getData("text/phren-tab");
        const moved = docs.get(from)?.tab;
        if (moved && moved !== tab) { barEl.insertBefore(moved, tab); save(); }
      });
      barEl.append(tab);
      entry = { doc, tab, el, handle: null };
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
    entry.tab.querySelector(".doc-tab-title").textContent = title || "Untitled";
    entry.tab.title = subtitle ? `${title} · ${subtitle}` : title;
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

  function closeTab(id = active) {
    const entry = docs.get(id);
    if (!entry) return false;
    const order = [...barEl.children].map((t) => t.dataset.doc);
    const index = order.indexOf(id);
    try { entry.handle.close?.(); } catch { /* already closed */ }
    entry.tab.remove();
    entry.el.remove();
    docs.delete(id);
    onClose?.(entry.doc);
    if (active === id) {
      active = null;
      const next = order[index + 1] ?? order[index - 1];
      if (next && docs.has(next)) activate(next);
      else onEmpty?.();
    }
    save();
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
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") ?? { list: [], active: null }; }
    catch { return { list: [], active: null }; }
  }

  return {
    open, activate, close: closeTab, step, setTitle, saved,
    has: (id) => docs.has(id),
    active: () => (active ? docs.get(active)?.doc ?? null : null),
    activeHandle: () => (active ? docs.get(active)?.handle ?? null : null),
    list: () => [...barEl.children].map((t) => docs.get(t.dataset.doc)?.doc).filter(Boolean),
  };
}

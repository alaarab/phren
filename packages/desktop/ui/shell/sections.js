// Top-level sections (Home, Agents, Projects, ...) shown as pills in the
// titlebar. Each section mounts once into its own container and stays mounted
// while hidden, so open chats keep their sockets and drafts.
//
// registerSection(id, { label, order, mount(el, ctx) -> { show?(), hide?(), focus?() } })

const sections = new Map();
let current = null;
let pillsEl = null;
let hostEl = null;
const changeListeners = new Set();

export function registerSection(id, def) {
  sections.set(id, { id, order: 100, ...def, el: null, handle: null });
  if (pillsEl) renderPills();
}

export function installSections(pills, host) {
  pillsEl = pills;
  hostEl = host;
  renderPills();
  window.addEventListener("hashchange", () => {
    const id = location.hash.replace(/^#\/?/, "");
    if (sections.has(id) && id !== current) showSection(id);
  });
}

export function showSection(id, ctx = {}) {
  const def = sections.get(id);
  if (!def) return null;
  let fresh = false;
  if (!def.el) {
    def.el = document.createElement("div");
    def.el.className = `section section-${id}`;
    hostEl.append(def.el);
    def.handle = def.mount(def.el, ctx) ?? {};
    fresh = true;
  }
  // A section mounted hidden (sectionHandle) or just now gets its first show().
  if (fresh || def.el.hidden) { def.el.hidden = false; def.handle?.show?.(); }
  for (const s of sections.values()) {
    if (s.id === id) continue;
    if (!s.el || s.el.hidden) continue;
    s.el.hidden = true;
    s.handle?.hide?.();
  }
  current = id;
  if (location.hash !== `#/${id}`) history.replaceState(null, "", `#/${id}`);
  for (const b of pillsEl?.querySelectorAll(".section-pill") ?? []) {
    b.classList.toggle("selected", b.dataset.section === id);
    b.setAttribute("aria-selected", String(b.dataset.section === id));
  }
  for (const fn of changeListeners) fn(id);
  return def.handle;
}

export function currentSection() { return current; }

/** The mounted handle of a section, mounting it hidden if needed. */
export function sectionHandle(id) {
  const def = sections.get(id);
  if (!def) return null;
  if (!def.el) {
    def.el = document.createElement("div");
    def.el.className = `section section-${id}`;
    def.el.hidden = true;
    hostEl.append(def.el);
    def.handle = def.mount(def.el, {}) ?? {};
  }
  return def.handle;
}

export function onSectionChange(fn) { changeListeners.add(fn); return () => changeListeners.delete(fn); }

/** The section ids in titlebar order. */
export function sectionIds() {
  return [...sections.values()].sort((a, b) => a.order - b.order).map((s) => s.id);
}

function renderPills() {
  pillsEl.replaceChildren();
  pillsEl.setAttribute("role", "tablist");
  for (const id of sectionIds()) {
    const def = sections.get(id);
    const b = document.createElement("button");
    b.className = "section-pill";
    b.dataset.section = id;
    b.setAttribute("role", "tab");
    b.textContent = def.label;
    if (def.badge) {
      const badge = document.createElement("span");
      badge.className = "section-badge";
      badge.hidden = true;
      b.append(badge);
    }
    b.classList.toggle("selected", id === current);
    b.addEventListener("click", () => showSection(id));
    pillsEl.append(b);
  }
}

/** Set a pill's count badge (0 hides it). */
export function setSectionBadge(id, count) {
  const badge = pillsEl?.querySelector(`.section-pill[data-section="${id}"] .section-badge`);
  if (!badge) return;
  badge.hidden = !count;
  badge.textContent = count ? String(count) : "";
}

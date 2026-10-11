// Top-level sections (Home, Agents, Projects, ...) shown in the titlebar. Each
// section mounts once into its own container and stays mounted while hidden,
// so open chats keep their sockets and drafts.
//
// registerSection(id, { label, order, group?, groupLabel?, icon?, mount(el, ctx) -> { show?(), hide?(), focus?() } })
//
// Sections that share a `group` get one pill (labelled by `groupLabel`) and a
// row of sub-tabs beside it while the group is open; the pill reopens the
// group's last section. An `icon` section (Settings) is a button at the end of
// the titlebar instead of a pill.

const sections = new Map();
let current = null;
let pillsEl = null;
let subEl = null;
let iconEl = null;
let hostEl = null;
const changeListeners = new Set();
const lastInGroup = new Map(); // group -> section id

const groupOf = (id) => sections.get(id)?.group ?? id;

// Back and forward through the sections you visited, like a browser.
const trail = [];
let trailAt = -1;
let walking = false;
const trailListeners = new Set();

export function canGoBack() { return trailAt > 0; }
export function canGoForward() { return trailAt < trail.length - 1; }
export function goBack() { if (canGoBack()) walk(trailAt - 1); }
export function goForward() { if (canGoForward()) walk(trailAt + 1); }
export function onTrailChange(fn) { trailListeners.add(fn); return () => trailListeners.delete(fn); }

function walk(index) {
  trailAt = index;
  walking = true;
  try { showSection(trail[index]); } finally { walking = false; }
  for (const fn of trailListeners) fn();
}

function remember(id) {
  if (walking || trail[trailAt] === id) return;
  trail.splice(trailAt + 1);
  trail.push(id);
  if (trail.length > 50) trail.shift();
  trailAt = trail.length - 1;
  for (const fn of trailListeners) fn();
}

export function registerSection(id, def) {
  sections.set(id, { id, order: 100, ...def, el: null, handle: null });
  if (pillsEl) renderPills();
}

export function installSections(pills, host, { sub = null, icons = null } = {}) {
  pillsEl = pills;
  subEl = sub;
  iconEl = icons;
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
  lastInGroup.set(groupOf(id), id);
  remember(id);
  markSelected();
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

/** A section's own label ("Tasks"), for the palette. */
export function sectionLabel(id) { return sections.get(id)?.label ?? id; }

/** Groups in titlebar order: [{ key, label, ids }]. */
function groups() {
  const out = new Map();
  for (const id of sectionIds()) {
    const def = sections.get(id);
    const key = groupOf(id);
    if (!out.has(key)) out.set(key, { key, label: def.groupLabel ?? def.label, icon: def.icon, ids: [] });
    out.get(key).ids.push(id);
  }
  return [...out.values()];
}

function renderPills() {
  pillsEl.replaceChildren();
  iconEl?.replaceChildren();
  pillsEl.setAttribute("role", "tablist");
  for (const group of groups()) {
    const b = document.createElement("button");
    b.className = group.icon ? "section-pill icon" : "section-pill";
    b.dataset.group = group.key;
    // A one-section pill keeps its section id, so it can be found by it.
    if (group.ids.length === 1) b.dataset.section = group.ids[0];
    if (group.icon) {
      b.innerHTML = group.icon;
      b.setAttribute("aria-label", group.label);
      b.title = group.label;
    } else {
      b.setAttribute("role", "tab");
      b.textContent = group.label;
    }
    if (group.ids.some((id) => sections.get(id).badge)) {
      const badge = document.createElement("span");
      badge.className = "section-badge";
      badge.hidden = true;
      b.append(badge);
    }
    b.addEventListener("click", () => showSection(lastInGroup.get(group.key) ?? group.ids[0]));
    (group.icon && iconEl ? iconEl : pillsEl).append(b);
  }
  markSelected();
}

function markSelected() {
  const open = current ? groupOf(current) : null;
  for (const b of document.querySelectorAll(".section-pill[data-group]")) {
    const on = b.dataset.group === open;
    b.classList.toggle("selected", on);
    b.setAttribute("aria-selected", String(on));
  }
  if (!subEl) return;
  const group = groups().find((g) => g.key === open);
  subEl.replaceChildren();
  subEl.hidden = !group || group.ids.length < 2;
  if (subEl.hidden) return;
  for (const id of group.ids) {
    const b = document.createElement("button");
    b.className = `section-sub${id === current ? " selected" : ""}`;
    b.dataset.section = id;
    b.textContent = sections.get(id).label;
    b.addEventListener("click", () => showSection(id));
    subEl.append(b);
  }
}

/** Set a pill's count badge (0 hides it). */
export function setSectionBadge(id, count) {
  const badge = document.querySelector(`.section-pill[data-group="${groupOf(id)}"] .section-badge`);
  if (!badge) return;
  badge.hidden = !count;
  badge.textContent = count ? String(count) : "";
}

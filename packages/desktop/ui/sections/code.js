// Code: a project's code index in the desktop. A rail of every online
// computer and the projects its store holds, then Files (a lazy tree of the
// checkout beside one file's outline), What changed (the functions, types and
// variables today's sessions and the last commits touched), Most used (a
// ranked, paged table) and Notes (findings linked to code), with a dossier for
// one declaration and a form that remembers a note through /v1/code/note.
// Reads the Hook's code routes through the daemon.
//
// Opening a file at a line is done by handing the Agents section a file
// document; see openAtLine below.

import { store, projectOf } from "../shell/store.js";
import { showSection, sectionHandle } from "../shell/sections.js";
import { hookGet, hookPost } from "../api.js";
import { openEditorDoc } from "../editor.js";

const CSS_ID = "code-css";
const SEGMENTS = [
  { id: "files", label: "Files" },
  { id: "changed", label: "What changed" },
  { id: "usage", label: "Most used" },
  { id: "notes", label: "Notes" },
];
const SVG_NS = "http://www.w3.org/2000/svg";
// The Hook batches change-counts and the tree at most 200 paths per call.
const COUNT_BATCH = 200;
const KIND_FILTERS = [
  { value: "", label: "Everything" },
  { value: "function", label: "Functions" },
  { value: "method", label: "Methods" },
  { value: "types", label: "Types" },
  { value: "variable", label: "Variables" },
];
const USAGE_LIMIT = 50;

function ensureCss() {
  if (document.getElementById(CSS_ID)) return;
  const link = document.createElement("link");
  link.id = CSS_ID;
  link.rel = "stylesheet";
  link.href = "./sections/code.css";
  document.head.append(link);
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgPath(d, fill = "currentColor") {
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", fill);
  return path;
}

/** A folder, an open folder or a file, drawn as a 14 px inline SVG. */
function glyph(kind) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("cd-glyph", kind);
  if (kind === "file") {
    svg.append(svgPath("M4 1.5h5l3 3V14a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 4 14z", "none"));
    svg.append(svgPath("M9 1.5v3h3", "none"));
  } else {
    svg.append(svgPath(kind === "folderOpen"
      ? "M1.5 4.2c0-.6.5-1.1 1.1-1.1h3l1.2 1.3h6.5c.6 0 1.1.5 1.1 1.1v.8H4.2L2.3 13.6a.6.6 0 0 1-.8-.5z"
      : "M1.5 3.7c0-.6.5-1.1 1.1-1.1h3.1l1.3 1.4h6.4c.6 0 1.1.5 1.1 1.1v7.2c0 .6-.5 1.1-1.1 1.1H2.6c-.6 0-1.1-.5-1.1-1.1z"));
  }
  return svg;
}

/** The disclosure triangle; `open` turns it a quarter turn. */
function chevron(open) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "10");
  svg.setAttribute("height", "10");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("cd-chev");
  if (open) svg.classList.add("open");
  svg.append(svgPath("M6 3.5 10.5 8 6 12.5", "none"));
  return svg;
}

async function parseResponse(res) {
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0, 300) }; }
  if (!res.ok) {
    const error = new Error(body.error || `The daemon answered ${res.status}.`);
    error.status = res.status;
    error.code = body.code;
    error.body = body;
    throw error;
  }
  return body;
}

/** The daemon's Memory routes: one computer's store, read for projects and findings. */
async function apiGet(computer, route, query) {
  const qs = query ? new URLSearchParams(query).toString() : "";
  return parseResponse(await fetch(`/api/memory/${encodeURIComponent(computer)}${route}${qs ? `?${qs}` : ""}`, { cache: "no-store" }));
}

function basename(p) {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

/** A finding's citation file and line, from citationData or the raw comment. */
function citation(item) {
  let data = item?.citationData;
  if (!data || typeof data !== "object") {
    const match = String(item?.citation ?? "").match(/phren:cite\s+(\{[\s\S]*\})/);
    if (match) { try { data = JSON.parse(match[1]); } catch { data = null; } }
  }
  const file = String(data?.file ?? "").trim();
  const line = Number.isFinite(Number(data?.line)) ? Number(data.line) : null;
  return file ? { file, line } : null;
}

/** Finding display text: comments removed and a leading [type] tag stripped. */
function findingText(item) {
  return String(item?.text ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^\[[A-Za-z][A-Za-z0-9_-]*\]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

const KIND_LABEL = {
  function: "function", method: "method", class: "type", struct: "type",
  enum: "type", interface: "type", type: "type", variable: "variable",
};
function kindWord(kind) { return KIND_LABEL[kind] ?? (kind || "declaration"); }

function familyWord(family) {
  return family === "function" ? "function" : family === "type" ? "type" : "variable";
}

/** "Used in 1 place" / "Used in 3 places", as the phone words it. */
function usedIn(uses) {
  return uses === 1 ? "Used in 1 place" : `Used in ${uses} places`;
}

/** The Files tab's tree, lazy-loaded directories and batched change counts. */
function freshFiles() {
  return {
    dirs: new Map(),           // directory path "" or "src" -> { status, entries, error }
    expanded: new Set(),       // directory paths the person opened
    counts: new Map(),         // file path -> change-counts entry
    countsPending: new Set(),  // file paths a batch is in flight for
    selected: null,            // the highlighted path (file or folder)
    outline: null,             // { path, entries, loading, error } for the open file
  };
}

/** A change-counts entry: functions and types each {changed, added}. */
function countTotals(entry) {
  const f = (entry?.functions?.changed ?? 0) + (entry?.functions?.added ?? 0);
  const t = (entry?.types?.changed ?? 0) + (entry?.types?.added ?? 0);
  return { functions: f, types: t, recent: f + t };
}

export function mountCode(root) {
  ensureCss();
  root.innerHTML = `
    <div class="cd">
      <aside class="cd-rail">
        <div class="cd-rail-head">
          <div data-computer></div>
        </div>
        <div class="cd-rail-title">
          <span class="section-label">Projects</span>
          <span class="cd-count" data-pcount></span>
        </div>
        <div class="cd-projects" data-projects></div>
        <div class="cd-rail-note" data-railnote hidden></div>
        <div class="cd-rail-foot">
          <div class="cd-status" data-status></div>
          <button class="cd-btn" data-reindex type="button" hidden>Reindex</button>
        </div>
      </aside>
      <section class="cd-main">
        <div class="cd-head">
          <div class="cd-title-row">
            <div class="cd-title" data-title>Code</div>
            <span class="spacer"></span>
            <div class="cd-menu-wrap">
              <button class="cd-more" data-more type="button" aria-haspopup="true" aria-expanded="false" aria-label="More actions" hidden>&#8943;</button>
              <div class="cd-menu" data-menu hidden></div>
            </div>
          </div>
          <div class="cd-seg-row" data-filters></div>
        </div>
        <div class="cd-body" data-body></div>
        <div class="cd-split" data-split hidden></div>
      </section>
    </div>`;

  const computerEl = root.querySelector("[data-computer]");
  const projectsEl = root.querySelector("[data-projects]");
  const pcountEl = root.querySelector("[data-pcount]");
  const railNoteEl = root.querySelector("[data-railnote]");
  const titleEl = root.querySelector("[data-title]");
  const reindexBtn = root.querySelector("[data-reindex]");
  const statusEl = root.querySelector("[data-status]");
  const filtersEl = root.querySelector("[data-filters]");
  const bodyEl = root.querySelector("[data-body]");
  const splitEl = root.querySelector("[data-split]");
  const moreBtn = root.querySelector("[data-more]");
  const menuEl = root.querySelector("[data-menu]");

  const state = {
    computers: [],
    computer: null,
    projects: [],
    project: null,
    segment: "changed",
    status: null,
    indexOff: false,
    gate: false,
    statusError: null,
    changed: [],
    usage: null,
    usageKind: "",
    usageFile: "",
    notes: [],
    reindexing: false,
    disabling: false,
    files: freshFiles(),
    generation: 0,
  };

  // ── Rail ───────────────────────────────────────────────────────────────
  let lastSig = null;
  function refreshComputers() {
    const names = (store.merged?.computers ?? []).filter((c) => c.state === "online").map((c) => c.computer);
    const sig = names.join("|");
    if (sig === lastSig) return;
    lastSig = sig;
    state.computers = names;
    if (!names.includes(state.computer)) { state.computer = names[0] ?? null; state.project = null; }
    renderComputer();
    if (state.computer) void loadProjects();
    else renderAll();
  }

  function renderComputer() {
    computerEl.replaceChildren();
    if (!state.computers.length) {
      computerEl.append(el("div", "cd-rail-note", "No computer is online."));
      return;
    }
    if (state.computers.length === 1) {
      computerEl.append(el("div", "cd-computer-name", state.computers[0]), el("div", "cd-computer-host", "online"));
      return;
    }
    const select = el("select", "cd-computer-select");
    select.setAttribute("aria-label", "Computer");
    for (const name of state.computers) {
      const option = el("option", undefined, name);
      option.value = name;
      option.selected = name === state.computer;
      select.append(option);
    }
    select.addEventListener("change", () => {
      state.computer = select.value;
      resetForProject(null);
      void loadProjects();
    });
    computerEl.append(select);
  }

  function resetForProject(project) {
    state.project = project;
    state.status = null;
    state.statusError = null;
    state.indexOff = false;
    state.gate = false;
    state.changed = [];
    state.usage = null;
    state.notes = [];
    state.usageKind = "";
    state.usageFile = "";
    state.files = freshFiles();
  }

  async function loadProjects() {
    const generation = ++state.generation;
    railNoteEl.hidden = true;
    try {
      const body = await apiGet(state.computer, "/projects");
      if (generation !== state.generation) return;
      state.projects = Array.isArray(body.projects) ? body.projects : [];
      if (!state.projects.some((p) => p.name === state.project)) resetForProject(state.projects[0]?.name ?? null);
    } catch (error) {
      if (generation !== state.generation) return;
      state.projects = [];
      railNoteEl.textContent = error.message || "The projects could not be loaded.";
      railNoteEl.hidden = false;
    }
    renderComputer();
    renderProjects();
    renderHead();
    if (state.project) void loadStatus().then(() => loadSegment());
    else renderBody();
  }

  function renderProjects() {
    renderComputer();
    pcountEl.textContent = state.projects.length ? String(state.projects.length) : "";
    projectsEl.replaceChildren();
    if (!state.computer) return;
    // The note is set while loading; clear it once projects arrive.
    railNoteEl.textContent = state.projects.length ? "" : "No projects in this store.";
    railNoteEl.hidden = state.projects.length > 0;
    for (const project of state.projects) {
      const row = el("button", `cd-project${project.name === state.project ? " selected" : ""}`);
      row.type = "button";
      row.append(el("span", "cd-project-name", project.name));
      const counts = el("span", "cd-project-count");
      if (project.findings) counts.textContent = String(project.findings);
      row.append(counts);
      row.addEventListener("click", () => {
        resetForProject(project.name);
        renderProjects();
        renderHead();
        void loadStatus().then(() => loadSegment());
      });
      projectsEl.append(row);
    }
  }

  function renderAll() { renderComputer(); renderProjects(); renderHead(); renderBody(); }

  function renderHead() {
    titleEl.textContent = state.project || "Code";
    moreBtn.hidden = !hasIndex();
    if (!hasIndex()) closeMenu();
    renderStatus();
    renderFilters();
  }

  function renderStatus() {
    reindexBtn.hidden = !hasIndex();
    reindexBtn.disabled = state.reindexing;
    reindexBtn.textContent = state.reindexing ? "Rebuilding…" : "Reindex";
    statusEl.classList.toggle("error", Boolean(state.statusError));
    if (state.statusError) { statusEl.textContent = state.statusError; return; }
    if (!hasIndex()) { statusEl.textContent = ""; return; }
    const parts = [`${state.status.files.toLocaleString()} files`];
    const fns = (state.status.kinds ?? []).find((k) => k.kind === "function");
    const tys = (state.status.kinds ?? []).filter((k) => ["class", "struct", "enum", "interface", "type"].includes(k.kind)).reduce((n, k) => n + k.symbols, 0);
    if (fns?.symbols) parts.push(`${fns.symbols.toLocaleString()} functions`);
    if (tys) parts.push(`${tys.toLocaleString()} types`);
    if (state.status.lastIndexedAt) parts.push(`updated ${relativeTime(state.status.lastIndexedAt)}`);
    if (state.reindexing) parts.push("rebuilding…");
    statusEl.textContent = parts.join(" · ");
  }

  function hasIndex() { return Boolean(state.status?.available) && !state.indexOff; }

  function relativeTime(ms) {
    const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  reindexBtn.addEventListener("click", () => void reindex());

  store.subscribe(refreshComputers);
  refreshComputers();

  // ── Index status ───────────────────────────────────────────────────────
  async function loadStatus() {
    if (!state.project) { renderStatus(); return; }
    state.statusError = null;
    let canCode = false;
    try { canCode = (await store.capabilities(state.computer)).code === true; } catch { canCode = false; }
    if (!canCode) {
      state.status = null;
      state.indexOff = true;
      state.gate = true;
      renderFilters();
      renderStatus();
      return;
    }
    state.gate = false;
    try {
      const body = await hookGet(state.computer, "/v1/code/status", { project: state.project });
      state.status = body;
      state.indexOff = body.available !== true;
      state.statusError = null;
    } catch (error) {
      if (error.status === 404 || /No code index/i.test(error.message)) { state.indexOff = true; state.status = null; state.statusError = null; }
      else { state.status = null; state.statusError = error.message; }
    }
    renderFilters();
    renderStatus();
  }

  async function reindex() {
    if (!state.project || state.reindexing) return;
    state.reindexing = true;
    renderStatus();
    try {
      const body = await hookPost(state.computer, "/v1/code/reindex", { project: state.project });
      if (body && typeof body === "object" && "available" in body) state.status = body;
      state.indexOff = false;
      state.statusError = null;
      await loadSegment();
    } catch (error) {
      state.statusError = error.message || "The index could not be rebuilt.";
    } finally {
      state.reindexing = false;
      renderFilters();
      renderStatus();
    }
  }

  // ── ⋯ menu (Turn off code index) ────────────────────────────────────────
  function renderMenu() {
    menuEl.replaceChildren();
    if (!state.project || !hasIndex()) { closeMenu(); return; }
    const off = el("button", "cd-menu-item", "Turn off code index");
    off.type = "button";
    off.addEventListener("click", renderConfirm);
    menuEl.append(off);
  }

  function renderConfirm() {
    menuEl.replaceChildren();
    menuEl.append(el("div", "cd-menu-note", `Turn off the code index for ${state.project}?`));
    const row = el("div", "cd-menu-actions");
    const cancel = el("button", "cd-btn", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", renderMenu);
    const off = el("button", "cd-btn danger", state.disabling ? "Turning off…" : "Turn off");
    off.type = "button";
    off.disabled = state.disabling;
    off.addEventListener("click", () => void turnOffIndex());
    row.append(cancel, off);
    menuEl.append(row);
  }

  function openMenu() { renderMenu(); menuEl.hidden = false; moreBtn.setAttribute("aria-expanded", "true"); }
  function closeMenu() { menuEl.hidden = true; moreBtn.setAttribute("aria-expanded", "false"); }
  function toggleMenu() { if (menuEl.hidden) openMenu(); else closeMenu(); }

  moreBtn.addEventListener("click", (ev) => { ev.stopPropagation(); toggleMenu(); });
  document.addEventListener("mousedown", (ev) => {
    if (!menuEl.hidden && !menuEl.contains(ev.target) && ev.target !== moreBtn) closeMenu();
  });

  async function turnOffIndex() {
    if (!state.project || state.disabling) return;
    const project = state.project;
    state.disabling = true;
    renderConfirm();
    try {
      await hookPost(state.computer, "/v1/code/disable", { project });
      if (state.project !== project) return;
      state.indexOff = true;
      state.status = null;
      state.statusError = null;
      state.files = freshFiles();
      closeMenu();
      renderAll();
    } catch (error) {
      state.disabling = false;
      renderConfirm();
      setToast(error.status === 404
        ? `Update Phren on ${state.computer} to turn the index off.`
        : (error.message || "The index could not be turned off."));
    } finally {
      state.disabling = false;
    }
  }

  // ── Segments and filters ───────────────────────────────────────────────
  function renderFilters() {
    filtersEl.replaceChildren();
    if (!state.project || !hasIndex()) return;
    const segs = el("div", "segments");
    for (const s of SEGMENTS) {
      const b = el("button", `segment${s.id === state.segment ? " selected" : ""}`, s.label);
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(s.id === state.segment));
      b.addEventListener("click", () => selectSegment(s.id));
      segs.append(b);
    }
    filtersEl.append(segs, el("span", "spacer"));
    if (state.segment === "usage") {
      const kind = el("select", "cd-select");
      kind.setAttribute("aria-label", "Filter by kind");
      for (const k of KIND_FILTERS) {
        const o = el("option", undefined, k.label);
        o.value = k.value;
        o.selected = k.value === state.usageKind;
        kind.append(o);
      }
      kind.addEventListener("change", () => { state.usageKind = kind.value; state.usage = null; void loadUsage(); });
      const file = el("input", "cd-input");
      file.type = "text";
      file.placeholder = "File path";
      file.value = state.usageFile;
      file.setAttribute("aria-label", "Filter by file");
      file.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter") return;
        state.usageFile = file.value.trim();
        state.usage = null;
        void loadUsage();
      });
      filtersEl.append(kind, file);
    }
  }

  function selectSegment(id) {
    if (id === state.segment) return;
    state.segment = id;
    renderFilters();
    void loadSegment();
  }

  // ── Loads ──────────────────────────────────────────────────────────────
  let loadToken = 0;

  async function loadSegment() {
    if (!state.project) { renderBody(); return; }
    if (!hasIndex()) { renderBody(); return; }
    paneEmpty("Loading index…");
    if (state.segment === "files") {
      renderBody();
      if (!state.files.dirs.has("")) await ensureDir("");
      return;
    }
    if (state.segment === "changed") await loadChanged();
    else if (state.segment === "usage") await loadUsage();
    else await loadNotes();
  }

  async function loadChanged() {
    const token = ++loadToken;
    try {
      const body = await hookGet(state.computer, "/v1/code/changed", { project: state.project });
      if (token !== loadToken) return;
      state.changed = Array.isArray(body.files) ? body.files : [];
    } catch (error) { if (token === loadToken) showError(error); return; }
    renderBody();
  }

  async function loadUsage(offset = 0, end = false) {
    const token = ++loadToken;
    const query = { project: state.project, offset: String(offset), limit: String(USAGE_LIMIT) };
    if (state.usageKind) query.kind = state.usageKind;
    if (state.usageFile) query.file = state.usageFile;
    if (end) query.end = "1";
    try {
      const body = await hookGet(state.computer, "/v1/code/usage-page", query);
      if (token !== loadToken) return;
      state.usage = body;
    } catch (error) { if (token === loadToken) showError(error); return; }
    renderBody();
  }

  async function loadNotes() {
    const token = ++loadToken;
    try {
      const body = await apiGet(state.computer, "/findings", { project: state.project });
      if (token !== loadToken) return;
      state.notes = (Array.isArray(body.items) ? body.items : [])
        .map((item) => ({ item, cite: citation(item) }))
        .filter((note) => note.cite && note.cite.file);
    } catch (error) { if (token === loadToken) showError(error); return; }
    renderBody();
  }

  // ── Body shell ─────────────────────────────────────────────────────────
  function innerPane() {
    bodyEl.replaceChildren();
    const inner = el("div", "cd-inner");
    bodyEl.append(inner);
    return inner;
  }

  function paneEmpty(text) {
    const inner = innerPane();
    inner.append(el("div", "cd-empty", text));
  }

  function showError(error) {
    const inner = innerPane();
    inner.append(el("div", "cd-empty cd-error", error?.message || "The request failed."));
  }

  function sectionLabel(inner, title, count) {
    const row = el("div", "cd-section-label");
    row.append(el("span", "section-label", title));
    if (count != null) row.append(el("span", "cd-count", String(count)));
    inner.append(row);
    return row;
  }

  function renderBody() {
    const files = state.segment === "files" && Boolean(state.computer) && Boolean(state.project) && hasIndex();
    bodyEl.hidden = files;
    splitEl.hidden = !files;
    if (files) { renderFiles(); return; }
    splitEl.replaceChildren();
    if (!state.computer) { paneEmpty("No computer is online."); return; }
    if (!state.project) { paneEmpty("Pick a project to browse its code."); return; }
    if (!hasIndex()) { renderOff(); return; }
    if (state.segment === "changed") renderChanged();
    else if (state.segment === "usage") renderUsage();
    else renderNotes();
  }

  function renderOff() {
    const inner = innerPane();
    if (state.gate) {
      inner.append(el("div", "cd-gate", `Update Phren on ${state.computer} to use the code index here.`));
      return;
    }
    const card = el("div", "cd-off");
    card.append(el("div", "cd-off-glyph", "{}"));
    card.append(el("div", "cd-off-title", "Code intelligence is off"));
    card.append(el("div", "cd-off-text",
      "Turn it on to find functions and types, jump to where they are defined and see where they are used. Phren keeps it up to date as files change."));
    if (state.statusError) card.append(el("div", "cd-error", state.statusError));
    const btn = el("button", "cd-btn accent", state.reindexing ? "Turning on…" : "Turn on");
    btn.type = "button";
    btn.disabled = state.reindexing;
    btn.addEventListener("click", () => void reindex());
    card.append(btn);
    inner.append(card);
  }

  // ── What changed ───────────────────────────────────────────────────────
  function renderChanged() {
    const inner = innerPane();
    if (!state.changed.length) { inner.append(el("div", "cd-empty", "Nothing changed today or in the last 10 commits.")); return; }
    const total = state.changed.reduce((n, file) => n + (file.items?.length ?? 0), 0);
    sectionLabel(inner, "What changed", total);
    for (const file of state.changed) {
      const head = el("div", "cd-filehead");
      head.append(el("span", undefined, file.path));
      if (file.items.length) head.append(el("span", "cd-count", String(file.items.length)));
      inner.append(head);
      for (const item of file.items) inner.append(changedRow(file.path, item));
    }
  }

  function changedRow(file, item) {
    const row = el("button", "cd-item");
    row.type = "button";
    const main = el("div", "cd-item-main");
    const nameRow = el("div", "cd-item-name");
    nameRow.append(el("span", "nm", item.parent ? `${item.parent}.${item.name}` : item.name));
    if (item.isNew) nameRow.append(el("span", "cd-chip", "new"));
    main.append(nameRow);
    main.append(el("div", "cd-item-sub", `${familyWord(item.family)} · line ${item.line}`));
    row.append(main, usesBox(item.uses));
    row.addEventListener("click", () => openDossier(qualified(file, item.parent, item.name)));
    return row;
  }

  function qualified(file, parent, name) {
    return `${file}::${parent ? `${parent}.` : ""}${name}`;
  }

  // ── Most used ──────────────────────────────────────────────────────────
  function renderUsage() {
    const inner = innerPane();
    const usage = state.usage;
    if (!usage) { inner.append(el("div", "cd-empty", "Loading…")); return; }
    sectionLabel(inner, usageTitle(), usage.total);
    if (!usage.entries.length) { inner.append(el("div", "cd-empty", "Nothing here yet.")); return; }
    const top = el("div", "cd-pagebar");
    top.append(el("span", "cd-range", `Ranks ${usage.offset + 1}–${usage.offset + usage.entries.length} of ${usage.total} · by places used`));
    const hot = el("button", "cd-btn", "Most used");
    hot.type = "button";
    hot.addEventListener("click", () => { state.usage = null; void loadUsage(0, false); });
    const cold = el("button", "cd-btn", "Least used");
    cold.type = "button";
    cold.addEventListener("click", () => { state.usage = null; void loadUsage(0, true); });
    top.append(hot, cold);
    inner.append(top);
    usage.entries.forEach((entry, i) => inner.append(usageRow(entry, usage.offset + i + 1, usage.maxUses)));
    const foot = el("div", "cd-pagebar");
    const prev = el("button", "cd-btn", "Previous");
    prev.type = "button";
    prev.disabled = usage.offset <= 0;
    prev.addEventListener("click", () => { state.usage = null; void loadUsage(Math.max(0, usage.offset - usage.limit)); });
    const next = el("button", "cd-btn", "Next");
    next.type = "button";
    next.disabled = usage.offset + usage.entries.length >= usage.total;
    next.addEventListener("click", () => { state.usage = null; void loadUsage(usage.offset + usage.entries.length); });
    foot.append(prev, el("span", "cd-range"), next);
    inner.append(foot);
  }

  function usageTitle() {
    switch (state.usageKind) {
      case "function": return "Most used functions";
      case "method": return "Most used methods";
      case "types": return "Most used types";
      case "variable": return "Most used variables";
      default: return "Most used";
    }
  }

  function usageRow(entry, rank, max) {
    const row = el("button", "cd-item");
    row.type = "button";
    row.append(el("span", "cd-rank", String(rank)));
    const main = el("div", "cd-item-main");
    const nameRow = el("div", "cd-item-name");
    nameRow.append(el("span", "nm", entry.name));
    nameRow.append(el("span", "cd-chip kind", kindWord(entry.kind)));
    main.append(nameRow);
    main.append(el("div", "cd-item-sub", `${entry.file}:${entry.line}`));
    row.append(main, usesBox(entry.uses, max));
    row.addEventListener("click", () => openDossier(qualified(entry.file, entry.parent, entry.name)));
    return row;
  }

  function usesBox(uses, max) {
    const box = el("div", "cd-uses");
    box.append(el("span", "cd-uses-n", String(uses ?? 0)));
    const bar = el("div", "cd-uses-bar");
    const fill = el("span");
    const pct = max
      ? Math.max(2, Math.round(((uses ?? 0) / Math.max(1, max)) * 100))
      : Math.max(2, Math.min(100, Math.round(Math.log2((uses ?? 0) + 1) * 24)));
    fill.style.width = `${pct}%`;
    bar.append(fill);
    box.append(bar);
    box.title = usedIn(uses ?? 0);
    return box;
  }

  // ── Notes ──────────────────────────────────────────────────────────────
  function renderNotes() {
    const inner = innerPane();
    sectionLabel(inner, "Notes linked to code", state.notes.length);
    if (!state.notes.length) { inner.append(el("div", "cd-empty", "No findings cite a place in the code yet.")); return; }
    for (const { item, cite } of state.notes) {
      const card = el("div", "cd-note");
      card.append(el("div", "cd-note-text", findingText(item) || "(empty note)"));
      const foot = el("div", "cd-note-foot");
      const type = String(item?.type ?? "").trim().toLowerCase();
      if (type) foot.append(el("span", "cd-chip kind", type));
      const open = el("button", "cd-copy", `${cite.file}${cite.line != null ? `:${cite.line}` : ""}`);
      open.type = "button";
      open.title = "Open in the editor";
      open.addEventListener("click", () => void openLocation(cite.file, cite.line));
      foot.append(open);
      card.append(foot);
      inner.append(card);
    }
  }

  // ── Opening a file at a line ───────────────────────────────────────────
  // The Agents section owns the centre tabs; a file document there opens the
  // editor at the line. A project with no live session cannot host one, so the
  // caller falls back to the copyable file:line.
  function matchingSession(computer, project) {
    return store.sessions().find((row) => row.computer === computer && projectOf(row.child) === project) ?? null;
  }

  function openAtLine(computer, project, file, line) {
    const row = matchingSession(computer, project);
    if (!row) return false;
    const agents = sectionHandle("agents");
    if (!agents?.tiles) return false;
    showSection("agents");
    const id = `file:${row.computer}/${row.child.id}/${file}`;
    const title = basename(file);
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    const subtitle = [dir, project].filter(Boolean).join(" · ");
    const doc = {
      id, kind: "file", computer: row.computer, child: row.child, path: file, title, subtitle,
      persist: { computer: row.computer, id: row.child.id, path: file, diff: false },
      mount(elHost) {
        return openEditorDoc(elHost, {
          computer: row.computer, child: row.child, path: file, line,
          openFile: (p, o) => openAtLine(row.computer, project, p, o?.line),
          ask: () => {},
          onDirty: (dirty) => agents.tiles.setTitle(id, (dirty ? "\u25cf " : "") + title, subtitle),
          onCloseRequest: () => agents.tiles.close(id),
        });
      },
    };
    const handle = agents.tiles.open(doc);
    if (line != null) handle?.reveal?.(line);
    return true;
  }

  async function openLocation(file, line) {
    if (openAtLine(state.computer, state.project, file, line)) return;
    const loc = `${file}${line != null ? `:${line}` : ""}`;
    try { await navigator.clipboard.writeText(loc); } catch { /* clipboard unavailable */ }
    setToast(`No open session for ${state.project}. Copied ${loc}`);
  }

  let toastEl = null;
  function setToast(text) {
    if (!toastEl) { toastEl = el("div", "cd-toast"); root.append(toastEl); }
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(setToast.timer);
    setToast.timer = setTimeout(() => { toastEl.hidden = true; }, 4500);
  }

  // ── Files (a lazy tree beside one file's outline) ──────────────────────
  let navNodes = [];   // the visible rows, in order, for the keyboard
  let countEls = new Map();
  let dotEls = new Map();

  function renderFiles() {
    navNodes = [];
    countEls = new Map();
    dotEls = new Map();
    const keepFocus = splitEl.contains(document.activeElement);
    splitEl.replaceChildren();
    const tree = el("div", "cd-tree");
    tree.tabIndex = 0;
    tree.setAttribute("role", "tree");
    tree.setAttribute("aria-label", "Project files");
    tree.addEventListener("keydown", onTreeKey);
    renderTree(tree, "", 0);
    const outline = el("div", "cd-outline");
    renderOutline(outline);
    splitEl.append(tree, outline);
    if (!keepFocus) queueMicrotask(() => { if (!splitEl.hidden) tree.focus({ preventScroll: true }); });
    void loadChangeCounts();
  }

  function renderTree(container, dir, depth) {
    const entry = state.files.dirs.get(dir);
    if (!entry) return;
    const indent = 8 + depth * 14;
    if (entry.status === "loading") {
      const note = el("div", "cd-tree-note", "Loading…");
      note.style.paddingLeft = `${indent + 22}px`;
      container.append(note);
      return;
    }
    if (entry.status === "error") {
      const note = el("div", "cd-tree-note cd-error", entry.error?.message || "This folder could not be loaded.");
      note.style.paddingLeft = `${indent + 22}px`;
      container.append(note);
      return;
    }
    for (const item of entry.entries) {
      const row = treeRow(item, depth);
      container.append(row);
      navNodes.push({ path: item.path, directory: item.directory, row });
      if (item.directory && state.files.expanded.has(item.path)) renderTree(container, item.path, depth + 1);
    }
  }

  function treeRow(item, depth) {
    const row = el("button", "cd-tree-row");
    row.type = "button";
    row.dataset.path = item.path;
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.setAttribute("role", "treeitem");
    const open = item.directory && state.files.expanded.has(item.path);
    if (item.directory) row.setAttribute("aria-expanded", String(open));
    if (item.path === state.files.selected) row.classList.add("selected");
    const chev = el("span", "cd-tree-chev");
    if (item.directory) chev.append(chevron(open));
    row.append(chev, glyph(item.directory ? (open ? "folderOpen" : "folder") : "file"));
    row.append(el("span", "cd-tree-name", basename(item.path)));
    row.append(el("span", "spacer"));
    if (item.directory) {
      row.append(el("span", "cd-tree-files", `${item.files}${item.files === 1 ? " file" : " files"}`));
    } else {
      const counts = el("span", "cd-tree-counts");
      const dot = el("span", "cd-tree-dot");
      dot.hidden = true;
      countEls.set(item.path, counts);
      dotEls.set(item.path, dot);
      row.append(counts, dot);
      applyCount(item.path);
    }
    const node = { path: item.path, directory: item.directory, row };
    row.addEventListener("click", () => { selectNode(node); activateNode(node); });
    return row;
  }

  function selectNode(node) {
    if (!node) return;
    state.files.selected = node.path;
    for (const n of navNodes) n.row.classList.toggle("selected", n.path === node.path);
    node.row.scrollIntoView({ block: "nearest" });
  }

  function activateNode(node) {
    if (node.directory) toggleDir(node.path);
    else void openFile(node.path);
  }

  function onTreeKey(ev) {
    if (!navNodes.length) return;
    const i = navNodes.findIndex((n) => n.path === state.files.selected);
    const node = i < 0 ? navNodes[0] : navNodes[i];
    if (ev.key === "ArrowDown") { ev.preventDefault(); selectNode(navNodes[i < 0 ? 0 : Math.min(navNodes.length - 1, i + 1)]); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); selectNode(navNodes[i < 0 ? 0 : Math.max(0, i - 1)]); }
    else if (ev.key === "ArrowRight") {
      ev.preventDefault();
      if (node.directory && !state.files.expanded.has(node.path)) toggleDir(node.path);
      else if (node.directory) { const child = navNodes[i + 1]; if (child && child.path.startsWith(node.path + "/")) selectNode(child); }
    } else if (ev.key === "ArrowLeft") {
      ev.preventDefault();
      if (node.directory && state.files.expanded.has(node.path)) toggleDir(node.path);
      else { const slash = node.path.lastIndexOf("/"); if (slash > 0) selectNode(navNodes.find((n) => n.path === node.path.slice(0, slash))); }
    } else if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); activateNode(node); }
  }

  function toggleDir(path) {
    if (state.files.expanded.has(path)) {
      state.files.expanded.delete(path);
      renderBody();
      void loadChangeCounts();
      return;
    }
    state.files.expanded.add(path);
    renderBody();
    if (!state.files.dirs.has(path)) void ensureDir(path);
    else void loadChangeCounts();
  }

  async function ensureDir(dir) {
    if (state.files.dirs.has(dir)) return;
    const computer = state.computer;
    const project = state.project;
    state.files.dirs.set(dir, { status: "loading", entries: [] });
    renderBody();
    try {
      const query = { project };
      if (dir) query.directory = dir;
      const body = await hookGet(computer, "/v1/code/tree", query);
      if (state.project !== project || state.computer !== computer) return;
      state.files.dirs.set(dir, { status: "ready", entries: Array.isArray(body.entries) ? body.entries : [] });
    } catch (error) {
      if (state.project !== project || state.computer !== computer) return;
      state.files.dirs.set(dir, { status: "error", entries: [], error });
    }
    if (state.segment === "files") renderBody();
    void loadChangeCounts();
  }

  async function loadChangeCounts() {
    if (state.segment !== "files" || !hasIndex() || !state.project) return;
    const project = state.project;
    const paths = [];
    for (const node of navNodes) {
      if (node.directory) continue;
      if (state.files.counts.has(node.path) || state.files.countsPending.has(node.path)) continue;
      paths.push(node.path);
      if (paths.length >= COUNT_BATCH) break;
    }
    if (!paths.length) return;
    for (const p of paths) state.files.countsPending.add(p);
    let ok = false;
    try {
      const body = await hookGet(state.computer, "/v1/code/change-counts", { project, paths: JSON.stringify(paths) });
      if (state.project !== project) return;
      for (const entry of (body.entries ?? [])) if (entry?.path) state.files.counts.set(entry.path, entry);
      ok = true;
    } catch {
      // The chips are an extra; a failure leaves the tree usable without numbers.
    } finally {
      for (const p of paths) state.files.countsPending.delete(p);
      if (state.project === project) { for (const p of paths) applyCount(p); }
      if (ok && paths.length >= COUNT_BATCH) void loadChangeCounts();
    }
  }

  function applyCount(path) {
    const countsEl = countEls.get(path);
    if (!countsEl) return;
    const dot = dotEls.get(path);
    const entry = state.files.counts.get(path);
    if (!entry) { countsEl.textContent = ""; if (dot) dot.hidden = true; return; }
    const { functions, types, recent } = countTotals(entry);
    const parts = [];
    if (functions) parts.push(`${functions} fn`);
    if (types) parts.push(`${types} ty`);
    countsEl.textContent = parts.join(" · ");
    if (dot) { dot.hidden = recent === 0; dot.title = recent ? `${recent} changed since the last commit` : ""; }
  }

  // The right half: one file's outline, in source order, its names open a dossier.
  function renderOutline(pane) {
    pane.replaceChildren();
    const outline = state.files.outline;
    const head = el("div", "cd-outline-head");
    head.append(el("span", "section-label", "Outline"));
    if (outline?.path) head.append(el("span", "cd-outline-path", outline.path));
    pane.append(head);
    if (!outline) { pane.append(el("div", "cd-empty", "Pick a file to see its functions, types and variables.")); return; }
    if (outline.loading) { pane.append(el("div", "cd-empty", "Reading the outline…")); return; }
    if (outline.error) { pane.append(el("div", "cd-empty cd-error", outline.error.message || "The outline could not be loaded.")); return; }
    if (!outline.entries.length) { pane.append(el("div", "cd-empty", "No functions, types or variables in this file.")); return; }
    const list = el("div", "cd-outline-list");
    addOutline(list, outline.path, outline.entries, "", 0);
    pane.append(list);
  }

  function addOutline(container, file, entries, parent, depth) {
    for (const entry of entries) {
      const row = el("button", "cd-outline-row");
      row.type = "button";
      row.style.paddingLeft = `${8 + depth * 14}px`;
      row.append(el("span", "cd-outline-name", entry.name));
      row.append(el("span", "cd-chip kind", kindWord(entry.kind)));
      row.append(el("span", "spacer"));
      row.append(el("span", "cd-outline-line", `line ${entry.line}`));
      row.addEventListener("click", () => openDossier(qualified(file, parent, entry.name)));
      container.append(row);
      if (entry.children?.length) addOutline(container, file, entry.children, entry.name, depth + 1);
    }
  }

  async function openFile(path) {
    state.files.selected = path;
    state.files.outline = { path, entries: [], loading: true, error: null };
    renderBody();
    const computer = state.computer;
    const project = state.project;
    try {
      const body = await hookGet(computer, "/v1/code/outline", { project, path });
      if (state.files.outline?.path !== path || state.project !== project || state.computer !== computer) return;
      state.files.outline = { path, entries: Array.isArray(body.entries) ? body.entries : [], loading: false, error: null };
    } catch (error) {
      if (state.files.outline?.path !== path || state.project !== project || state.computer !== computer) return;
      state.files.outline = { path, entries: [], loading: false, error };
    }
    if (state.segment === "files") renderBody();
  }

  // ── Dossier ────────────────────────────────────────────────────────────
  const dossier = { open: false, name: null, definition: null, loading: false, error: null, selectedLine: null, note: "", sending: false, noteStatus: null, noteOk: false };
  let dossierEl = null;

  function ensureDossier() {
    if (dossierEl) return;
    dossierEl = el("div", "cd-backdrop");
    dossierEl.hidden = true;
    dossierEl.addEventListener("mousedown", (ev) => { if (ev.target === dossierEl) closeDossier(); });
    root.append(dossierEl);
  }

  function openDossier(name) {
    dossier.open = true;
    dossier.name = name;
    dossier.definition = null;
    dossier.loading = true;
    dossier.error = null;
    dossier.selectedLine = null;
    dossier.note = "";
    dossier.noteStatus = null;
    renderDossier();
    void loadDossier();
  }

  function closeDossier() {
    dossier.open = false;
    if (dossierEl) dossierEl.hidden = true;
  }

  async function loadDossier() {
    const name = dossier.name;
    try {
      const body = await hookGet(state.computer, "/v1/code/definition", { project: state.project, name });
      if (dossier.name !== name || !dossier.open) return;
      dossier.definition = body.definition ?? null;
      if (!dossier.definition) dossier.error = "Nothing named that in this project.";
      dossier.selectedLine = dossier.definition?.symbol?.line ?? null;
    } catch (error) {
      if (dossier.name !== name || !dossier.open) return;
      dossier.error = error.message || "The definition could not be loaded.";
    }
    dossier.loading = false;
    renderDossier();
  }

  function renderDossier() {
    ensureDossier();
    if (!dossier.open) { dossierEl.hidden = true; return; }
    dossierEl.hidden = false;
    dossierEl.replaceChildren();
    const sheet = el("div", "cd-sheet");
    const def = dossier.definition;
    const sym = def?.symbol;

    const head = el("div", "cd-sheet-head");
    const title = el("div", "cd-sheet-title");
    const nameRow = el("div", "cd-sheet-name");
    nameRow.append(el("span", "nm", sym?.name ?? (dossier.name ?? "").split("::").pop() ?? ""));
    if (sym?.kind) nameRow.append(el("span", "cd-chip kind", kindWord(sym.kind)));
    title.append(nameRow);
    if (sym?.file) title.append(el("div", "cd-sheet-loc", `${sym.file}:${sym.line}`));
    head.append(title, el("span", "spacer"));
    if (sym) {
      head.append(usesBox(sym.uses, null));
      const go = el("button", "cd-btn", "Open file");
      go.type = "button";
      go.addEventListener("click", () => { closeDossier(); void openLocation(sym.file, sym.line); });
      head.append(go);
    }
    const close = el("button", "cd-sheet-close", "\u00d7");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", closeDossier);
    head.append(close);

    const body = el("div", "cd-sheet-body");
    if (dossier.error) body.append(el("div", "cd-empty cd-error", dossier.error));
    else if (dossier.loading && !def) body.append(el("div", "cd-empty", "Loading…"));
    else if (def) {
      if (def.symbol.signature) {
        const label = el("div", "cd-block-label");
        label.append(el("span", "section-label", "Signature"));
        body.append(label, el("div", "cd-sig", def.symbol.signature));
      }
      renderSnippet(body, def);
      renderDossierFindings(body, def);
    }

    sheet.append(head, body);
    dossierEl.append(sheet);
  }

  function renderSnippet(body, def) {
    const lines = String(def.snippet ?? "").split("\n");
    if (!def.snippet || !lines.length) return;
    const start = def.symbol.line;
    const last = Math.min(def.symbol.endLine ?? start, start + lines.length - 1);
    const label = el("div", "cd-block-label");
    label.append(el("span", "section-label", "Definition"));
    label.append(el("span", "cd-count", `${lines.length} line${lines.length === 1 ? "" : "s"}`));
    body.append(label);
    const snippet = el("div", "cd-snippet");
    lines.forEach((text, i) => {
      const number = start + i;
      const selectable = number <= last;
      const row = el("button", `cd-line${dossier.selectedLine === number ? " selected" : ""}`);
      row.type = "button";
      row.disabled = !selectable;
      row.append(el("span", "cd-line-n", String(number)), el("span", "cd-line-t", text || " "));
      if (selectable) row.addEventListener("click", () => { dossier.selectedLine = number; renderDossier(); });
      snippet.append(row);
    });
    body.append(snippet);
    renderNoteForm(body, def);
  }

  function renderNoteForm(body, def) {
    const name = def.symbol.name;
    const label = el("div", "cd-block-label");
    label.append(el("span", "section-label", "Add a note"));
    body.append(label);
    const field = el("div", "cd-field");
    const ta = el("textarea", "cd-textarea");
    ta.placeholder = `Remember this about ${name}`;
    ta.value = dossier.note;
    ta.setAttribute("aria-label", `Note about ${name}`);
    ta.addEventListener("input", () => { dossier.note = ta.value; saveBtn.disabled = dossier.sending || !dossier.note.trim() || dossier.selectedLine == null; });
    const actions = el("div", "cd-note-actions");
    if (dossier.noteStatus) actions.append(el("span", `cd-note-status ${dossier.noteOk ? "done" : "error"}`, dossier.noteStatus));
    actions.append(el("span", "cd-range"));
    const saveBtn = el("button", "cd-btn accent", dossier.sending ? "Remembering…" : "Remember");
    saveBtn.type = "button";
    saveBtn.disabled = dossier.sending || !dossier.note.trim() || dossier.selectedLine == null;
    saveBtn.addEventListener("click", () => void saveNote());
    actions.append(saveBtn);
    field.append(ta, actions);
    body.append(field);
  }

  function renderDossierFindings(body, def) {
    const findings = def.findings ?? [];
    const label = el("div", "cd-block-label");
    label.append(el("span", "section-label", "Findings"));
    label.append(el("span", "cd-count", String(findings.length)));
    body.append(label);
    if (!findings.length) { body.append(el("div", "cd-empty", "No finding cites this yet.")); return; }
    for (const finding of findings) body.append(el("div", "cd-finding", findingText(finding)));
  }

  async function saveNote() {
    const def = dossier.definition;
    if (!def?.symbol || dossier.selectedLine == null) return;
    const text = dossier.note.trim();
    if (!text) return;
    const name = dossier.name;
    dossier.sending = true;
    dossier.noteStatus = null;
    renderDossier();
    try {
      const body = await hookPost(state.computer, "/v1/code/note", {
        project: state.project, name, file: def.symbol.file, line: dossier.selectedLine, text,
      });
      if (dossier.name !== name || !dossier.open) return;
      if (!body.saved) { dossier.noteStatus = "The computer did not confirm it was remembered."; dossier.noteOk = false; }
      else {
        dossier.definition = { ...def, findings: body.findings ?? def.findings };
        dossier.note = "";
        dossier.noteStatus = "Remembered.";
        dossier.noteOk = true;
        if (state.segment === "notes") void loadNotes();
      }
    } catch (error) {
      if (dossier.name === name && dossier.open) { dossier.noteStatus = error.message || "The note could not be saved."; dossier.noteOk = false; }
    }
    dossier.sending = false;
    renderDossier();
  }

  window.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && dossier.open) closeDossier(); });

  return { show: renderAll, hide() {}, focus() {} };
}

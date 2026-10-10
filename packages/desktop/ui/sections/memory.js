// Memory: the phone's Memory screen at desktop scale. A rail of online
// computers and their projects (review counts in amber) beside one segment
// control over Findings, Review, Notes, Truths, Topics and the 3D graph.
// Reads the daemon's /api/memory and /api/graph routes; review counts are
// the only writes here, and only through POST /api/memory/<computer>/review.
import { store } from "../shell/store.js";

const CSS_ID = "memory-css";
const SEGMENTS = [
  { id: "findings", label: "Findings" },
  { id: "review", label: "Review" },
  { id: "notes", label: "Notes" },
  { id: "truths", label: "Truths" },
  { id: "topics", label: "Topics" },
  { id: "graph", label: "Graph" },
];
const FINDING_TYPES = new Set(["pattern", "decision", "pitfall", "workaround", "bug", "context"]);
const LIFECYCLE_CHIP = {
  superseded: { label: "Superseded", cls: "life" },
  retracted: { label: "Retracted", cls: "life" },
  stale: { label: "Stale", cls: "life" },
  contradicted: { label: "Contradicted", cls: "danger" },
  invalid_citation: { label: "Invalid citation", cls: "danger" },
};
const DIM_STATES = new Set(["superseded", "retracted", "stale"]);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const GRAPH_MISSING = "The graph needs a newer desktop build";

function ensureCss() {
  if (document.getElementById(CSS_ID)) return;
  const link = document.createElement("link");
  link.id = CSS_ID;
  link.rel = "stylesheet";
  link.href = "./sections/memory.css";
  document.head.append(link);
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
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

async function apiFetch(path, query) {
  const qs = query ? new URLSearchParams(query).toString() : "";
  return parseResponse(await fetch(path + (qs ? `?${qs}` : ""), { cache: "no-store" }));
}

const apiGet = (computer, route, query) =>
  apiFetch(`/api/memory/${encodeURIComponent(computer)}${route}`, query);

async function apiPost(computer, route, body) {
  const res = await fetch(`/api/memory/${encodeURIComponent(computer)}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Phren-Desktop": "1" },
    body: JSON.stringify(body),
  });
  return parseResponse(res);
}

/** A finding's type tag: `[pitfall]` in text or the parsed metadata type. */
function findingTag(item) {
  const raw = String(item?.type ?? "").trim().toLowerCase();
  if (FINDING_TYPES.has(raw)) return raw;
  const match = String(item?.text ?? "").match(/\[([A-Za-z][A-Za-z0-9_-]*)\]/);
  const tag = match ? match[1].toLowerCase() : null;
  return tag && FINDING_TYPES.has(tag) ? tag : null;
}

/** Display text: HTML comments removed and the leading `[type]` tag stripped. */
function findingBody(item) {
  return String(item?.text ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^\[[A-Za-z][A-Za-z0-9_-]*\]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The parsed citation meta, from citationData or by reading the raw comment. */
function citationData(item) {
  if (item?.citationData && typeof item.citationData === "object") return item.citationData;
  const match = String(item?.citation ?? "").match(/phren:cite\s+(\{[\s\S]*\})/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

function citeInfo(item) {
  const data = citationData(item);
  const file = String(data?.file ?? "").trim();
  const line = data?.line;
  const commit = String(data?.commit ?? "").trim();
  if (!file) return commit ? { label: commit.slice(0, 7), title: commit, copy: commit, commit: "" } : null;
  const base = file.split("/").filter(Boolean).pop() || file;
  const full = line != null ? `${file}:${line}` : file;
  return { label: line != null ? `${base}:${line}` : base, title: full, copy: full, commit };
}

/** "Oct 7" from an ISO date or a YYYY-MM-DD heading date. */
function shortDate(value) {
  const match = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return "";
  return `${MONTHS[Number(match[2]) - 1] ?? "?"} ${Number(match[3])}`;
}

function itemText(item) {
  return String(item?.text ?? item?.summary ?? item?.label ?? item?.memory ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function topicLabel(item) {
  const label = String(item?.label ?? item?.title ?? "").trim();
  if (label) return label;
  const slug = String(item?.slug ?? item?.topic ?? item?.id ?? "").trim();
  return slug ? slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "Topic";
}

function byDateDesc(a, b) {
  const da = String(a?.date ?? "");
  const db = String(b?.date ?? "");
  return da === db ? 0 : (da < db ? 1 : -1);
}

function graphKindLabel(node) {
  if (!node) return "";
  if (node.kind === "task") return node.group === "task-done" ? "Done task" : node.group === "task-queue" ? "Backlog task" : "Active task";
  const map = { finding: "Finding", project: "Project", entity: "Fragment", reference: "Reference", topic: "Topic", note: "Note" };
  return map[node.kind] ?? "Node";
}

export function mountMemory(root) {
  ensureCss();
  root.innerHTML = `
    <div class="mem">
      <aside class="mem-rail">
        <div class="mem-computer" data-computer></div>
        <div class="mem-rail-head">
          <span class="section-label">Projects</span>
          <span class="mem-rail-count" data-pcount></span>
        </div>
        <div class="mem-projects" data-projects></div>
        <div class="mem-rail-note" data-note hidden></div>
      </aside>
      <section class="mem-main">
        <div class="mem-head">
          <div class="mem-title-row">
            <div class="mem-title" data-title>Memory</div>
            <div class="mem-sub" data-sub hidden></div>
          </div>
          <div class="segments" data-segments role="tablist"></div>
        </div>
        <div class="mem-body" data-body></div>
      </section>
    </div>`;

  const computerEl = root.querySelector("[data-computer]");
  const projectsEl = root.querySelector("[data-projects]");
  const noteEl = root.querySelector("[data-note]");
  const pcountEl = root.querySelector("[data-pcount]");
  const titleEl = root.querySelector("[data-title]");
  const subEl = root.querySelector("[data-sub]");
  const segmentsEl = root.querySelector("[data-segments]");
  const bodyEl = root.querySelector("[data-body]");

  const state = {
    computers: [],
    computer: null,
    projects: [],
    project: null,
    segment: "findings",
    findings: [],
    review: [],
    search: "",
    type: null,
    reviewIndex: 0,
    editingLine: null,
    generation: 0,
    graph: { mounted: false },
  };

  // ── Rail ───────────────────────────────────────────────────────────────
  let lastComputerSig = null;
  function refreshComputers() {
    const names = (store.merged?.computers ?? []).filter((c) => c.state === "online").map((c) => c.computer);
    const sig = names.join("|");
    if (sig === lastComputerSig) return;
    lastComputerSig = sig;
    state.computers = names;
    if (!names.includes(state.computer)) {
      state.computer = names[0] ?? null;
      state.project = null;
    }
    renderComputer();
    if (state.computer) void loadProjects();
    else { renderRail(); renderBody(); }
  }

  function renderComputer() {
    computerEl.replaceChildren();
    if (!state.computers.length) {
      computerEl.append(el("div", "mem-rail-note", "No computer is online."));
      return;
    }
    if (state.computers.length === 1) {
      computerEl.append(el("div", "mem-computer-name", state.computers[0]), el("div", "mem-computer-host", "online"));
      return;
    }
    const select = el("select", "mem-computer-select");
    select.setAttribute("aria-label", "Computer");
    for (const name of state.computers) {
      const option = el("option", undefined, name);
      option.value = name;
      option.selected = name === state.computer;
      select.append(option);
    }
    select.addEventListener("change", () => {
      state.computer = select.value;
      state.project = null;
      state.findings = [];
      state.review = [];
      void loadProjects();
    });
    computerEl.append(select);
  }

  async function loadProjects() {
    const generation = ++state.generation;
    noteEl.hidden = true;
    try {
      const body = await apiGet(state.computer, "/projects");
      if (generation !== state.generation) return;
      state.projects = Array.isArray(body.projects) ? body.projects : [];
      noteEl.textContent = "";
      if (!state.projects.some((p) => p.name === state.project)) state.project = state.projects[0]?.name ?? null;
    } catch (error) {
      if (generation !== state.generation) return;
      state.projects = [];
      noteEl.textContent = error.message || "The projects could not be loaded.";
      noteEl.hidden = false;
    }
    renderRail();
    if (state.project) void loadSegment();
    else renderBody();
  }

  function renderRail() {
    renderComputer();
    pcountEl.textContent = state.projects.length ? String(state.projects.length) : "";
    projectsEl.replaceChildren();
    if (!state.computer) return;
    if (!state.projects.length) {
      noteEl.textContent = "No projects in this store.";
      noteEl.hidden = false;
    }
    for (const project of state.projects) {
      const row = el("button", `mem-project${project.name === state.project ? " selected" : ""}`);
      row.type = "button";
      row.append(el("span", "mem-project-name", project.name));
      const counts = el("span", "mem-project-counts");
      if (project.findings) counts.append(el("span", "mem-count", String(project.findings)));
      if (project.review) counts.append(el("span", "mem-count pending", String(project.review)));
      row.append(counts);
      row.addEventListener("click", () => {
        state.project = project.name;
        state.search = "";
        state.type = null;
        state.reviewIndex = 0;
        state.findings = [];
        state.review = [];
        renderRail();
        void loadSegment();
      });
      projectsEl.append(row);
    }
  }

  // ── Segment control ────────────────────────────────────────────────────
  function renderSegments() {
    segmentsEl.replaceChildren();
    for (const segment of SEGMENTS) {
      const button = el("button", `segment${segment.id === state.segment ? " selected" : ""}`, segment.label);
      button.type = "button";
      button.dataset.segment = segment.id;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(segment.id === state.segment));
      button.addEventListener("click", () => selectSegment(segment.id));
      segmentsEl.append(button);
    }
  }

  function selectSegment(id) {
    if (id === state.segment) return;
    if (state.segment === "graph") destroyGraph();
    state.segment = id;
    state.search = "";
    state.type = null;
    state.reviewIndex = 0;
    state.editingLine = null;
    renderSegments();
    void loadSegment();
  }

  let segToken = 0; // guards a stale segment load from overwriting a newer one

  // ── Body ───────────────────────────────────────────────────────────────
  function renderTitle() {
    const project = state.projects.find((p) => p.name === state.project);
    titleEl.textContent = project ? project.name : "Memory";
    const parts = [];
    if (project) {
      if (project.findings) parts.push(`${project.findings} finding${project.findings === 1 ? "" : "s"}`);
      if (project.review) parts.push(`${project.review} to review`);
      if (project.notes) parts.push(`${project.notes} note${project.notes === 1 ? "" : "s"}`);
    }
    subEl.textContent = parts.join(" · ");
    subEl.hidden = !parts.length;
  }

  function pane() {
    bodyEl.replaceChildren();
    const wrap = el("div", "mem-pane");
    const inner = el("div", "mem-inner");
    wrap.append(inner);
    bodyEl.append(wrap);
    return inner;
  }

  function renderBody() {
    if (!state.computer || !state.project) {
      const inner = pane();
      inner.append(el("div", "mem-empty", state.computer ? "Pick a project to see its memory." : "No computer is online."));
      return;
    }
    if (state.segment === "graph") { void renderGraph(); return; }
  }

  function renderError(error) {
    const inner = pane();
    inner.append(el("div", "mem-error", error?.message || "The request failed."));
  }

  async function loadSegment() {
    const token = ++segToken;
    renderTitle();
    renderSegments();
    if (!state.project || !state.computer) { renderBody(); return; }
    if (state.segment === "graph") { void renderGraph(); return; }
    const inner = pane();
    inner.append(el("div", "mem-empty", "Loading…"));
    try {
      if (state.segment === "findings") {
        const body = await apiGet(state.computer, "/findings", { project: state.project });
        if (token !== segToken) return;
        state.findings = Array.isArray(body.items) ? body.items : [];
        renderFindings();
      } else if (state.segment === "review") {
        const body = await apiGet(state.computer, "/review", { project: state.project });
        if (token !== segToken) return;
        state.review = Array.isArray(body.items) ? body.items : [];
        renderReview();
      } else if (state.segment === "notes") {
        const body = await apiGet(state.computer, "/notes", { project: state.project });
        if (token !== segToken) return;
        renderNotes(Array.isArray(body.items) ? body.items : []);
      } else if (state.segment === "truths") {
        const body = await apiGet(state.computer, "/truths", { project: state.project });
        if (token !== segToken) return;
        renderTruths(Array.isArray(body.items) ? body.items : []);
      } else if (state.segment === "topics") {
        const body = await apiGet(state.computer, "/topics", { project: state.project });
        if (token !== segToken) return;
        renderTopics(Array.isArray(body.items) ? body.items : []);
      }
    } catch (error) {
      if (token !== segToken) return;
      renderError(error);
    }
  }

  // ── Findings ───────────────────────────────────────────────────────────
  function renderFindings() {
    const inner = pane();
    const toolbar = el("div", "mem-toolbar");
    const search = el("input", "mem-search");
    search.type = "search";
    search.placeholder = "Search findings";
    search.value = state.search;
    toolbar.append(search);
    const tags = [...new Set(state.findings.map(findingTag).filter(Boolean))].sort();
    if (tags.length) {
      const chips = el("div", "mem-chips");
      const all = el("button", `mem-chip${state.type === null ? " on" : ""}`, "all");
      all.type = "button";
      all.addEventListener("click", () => { state.type = null; renderFindings(); });
      chips.append(all);
      for (const tag of tags) {
        const chip = el("button", `mem-chip tag-${tag}${state.type === tag ? " on" : ""}`, tag);
        chip.type = "button";
        chip.addEventListener("click", () => { state.type = state.type === tag ? null : tag; renderFindings(); });
        chips.append(chip);
      }
      toolbar.append(chips);
    }
    inner.append(toolbar);
    const listEl = el("div", "mem-list");
    inner.append(listEl);
    search.addEventListener("input", () => { state.search = search.value; renderFindingList(listEl); });
    renderFindingList(listEl);
  }

  function renderFindingList(listEl) {
    listEl.replaceChildren();
    const query = state.search.trim().toLowerCase();
    let items = state.findings.slice().sort(byDateDesc);
    if (state.type) items = items.filter((item) => findingTag(item) === state.type);
    if (query) items = items.filter((item) => `${findingBody(item)} ${item.citation ?? ""}`.toLowerCase().includes(query));
    if (!items.length) {
      listEl.append(el("div", "mem-empty", state.findings.length ? "No matches." : "No findings in this project yet."));
      return;
    }
    for (const item of items) listEl.append(findingRow(item));
  }

  function findingRow(item) {
    const status = String(item.status ?? "active");
    const row = el("div", `mem-row${DIM_STATES.has(status) ? " dim" : ""}`);
    row.append(el("div", "mem-row-text", findingBody(item)));
    const meta = el("div", "mem-row-meta");
    const tag = findingTag(item);
    if (tag) meta.append(el("span", `mem-tag type ${tag}`, tag));
    const life = LIFECYCLE_CHIP[status];
    if (life) meta.append(el("span", `mem-tag ${life.cls}`, life.label));
    if (item.confidence != null) meta.append(confidenceTag(item.confidence));
    if (item.machine) meta.append(el("span", "mem-meta-dim", item.machine));
    const cite = citeInfo(item);
    if (cite) {
      const chip = el("button", "mem-cite", cite.label);
      chip.type = "button";
      chip.title = cite.title;
      chip.addEventListener("click", () => copyText(cite.copy));
      meta.append(chip);
      if (cite.commit) {
        const commit = el("span", "mem-tag commit", cite.commit.slice(0, 7));
        commit.title = cite.commit;
        meta.append(commit);
      }
    }
    const when = shortDate(item.date) || shortDate(citationData(item)?.created_at);
    if (when) meta.append(el("span", "mem-date", when));
    row.append(meta);
    return row;
  }

  function confidenceTag(conf) {
    const pct = Math.round(Number(conf) * 100);
    return el("span", `mem-tag conf${pct < 70 ? " low" : ""}`, `${pct}%`);
  }

  // ── Review ─────────────────────────────────────────────────────────────
  const REVIEW_SECTIONS = ["Review", "Stale", "Conflicts"];

  function renderReview() {
    const inner = pane();
    if (!state.review.length) {
      inner.append(el("div", "mem-empty", "No maintenance entries for this project."));
      return;
    }
    const bySection = new Map(REVIEW_SECTIONS.map((s) => [s, []]));
    for (const item of state.review) {
      const section = REVIEW_SECTIONS.includes(item.section) ? item.section : "Review";
      bySection.get(section).push(item);
    }
    state.reviewRows = [];
    for (const section of REVIEW_SECTIONS) {
      const items = bySection.get(section);
      if (!items.length) continue;
      const label = el("div", "mem-section-label", section);
      label.append(el("span", "mem-section-count", String(items.length)));
      inner.append(label);
      const list = el("div", "mem-list");
      for (const item of items) {
        const row = reviewRow(item);
        list.append(row);
        state.reviewRows.push({ item, row });
      }
      inner.append(list);
    }
    state.reviewIndex = 0;
    updateReviewFocus();
  }

  function reviewRow(item) {
    const row = el("div", `mem-row mem-review-row${item.risky ? " risky" : ""}`);
    row.tabIndex = 0;
    row.append(el("div", "mem-row-text", item.text ?? ""));
    const meta = el("div", "mem-row-meta");
    if (item.confidence != null) meta.append(confidenceTag(item.confidence));
    if (item.machine) meta.append(el("span", "mem-meta-dim", item.machine));
    if (item.model) meta.append(el("span", "mem-meta-dim", item.model));
    meta.append(el("span", "mem-date", String(item.date ?? "")));
    row.append(meta);
    const actions = el("div", "mem-review-actions");
    const approve = el("button", "mem-btn approve", "Approve");
    const edit = el("button", "mem-btn", "Edit");
    const reject = el("button", "mem-btn reject", "Reject");
    approve.type = edit.type = reject.type = "button";
    approve.addEventListener("click", () => void decide(item, "approve"));
    edit.addEventListener("click", () => beginReviewEdit(row, item));
    reject.addEventListener("click", () => void decide(item, "reject"));
    actions.append(approve, edit, reject);
    row.append(actions);
    row.addEventListener("focus", () => {
      state.reviewIndex = state.reviewRows.findIndex((r) => r.item === item);
      updateReviewFocus();
    });
    return row;
  }

  function updateReviewFocus() {
    if (!state.reviewRows) return;
    state.reviewIndex = Math.max(0, Math.min(state.reviewIndex, state.reviewRows.length - 1));
    state.reviewRows.forEach((r, i) => r.row.classList.toggle("on", i === state.reviewIndex));
  }

  async function decide(item, action) {
    const index = state.reviewRows.findIndex((r) => r.item === item);
    const entry = state.reviewRows[index];
    if (entry) { entry.row.remove(); state.reviewRows.splice(index, 1); }
    const at = state.review.indexOf(item);
    if (at !== -1) state.review.splice(at, 1);
    updateReviewFocus();
    try {
      await apiPost(state.computer, "/review", { project: state.project, action, line: item.line });
      toast(action === "approve" ? "Approved" : "Rejected");
      if (!state.review.length) renderReview();
    } catch (error) {
      if (error.status !== 409) toast(error.message || "The change failed.");
      void loadSegment();
    }
  }

  function beginReviewEdit(row, item) {
    if (state.editingLine) return;
    state.editingLine = item.line;
    const textEl = row.querySelector(".mem-row-text");
    const area = el("textarea", "mem-edit");
    area.value = item.text ?? "";
    const actions = el("div", "mem-edit-actions");
    const cancel = el("button", "mem-btn", "Cancel");
    const save = el("button", "mem-btn approve", "Save");
    cancel.type = save.type = "button";
    cancel.addEventListener("click", () => { state.editingLine = null; renderReview(); });
    save.addEventListener("click", () => void saveReviewEdit(item, area.value));
    actions.append(cancel, save);
    textEl.replaceWith(area);
    row.querySelector(".mem-review-actions")?.replaceWith(actions);
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }

  async function saveReviewEdit(item, text) {
    const value = String(text ?? "").trim();
    state.editingLine = null;
    try {
      await apiPost(state.computer, "/review", { project: state.project, action: "edit", line: item.line, text: value });
      toast("Saved");
    } catch (error) {
      if (error.status === 409) toast("This entry changed; reloaded.");
      else toast(error.message || "The edit failed.");
    }
    void loadSegment();
  }

  let toastHost = null;
  function toast(text) {
    if (!toastHost || !toastHost.isConnected) {
      toastHost = el("div");
      toastHost.style.cssText = "position:fixed;right:20px;bottom:20px;z-index:100;display:grid;gap:8px";
      document.body.append(toastHost);
    }
    const note = el("div", undefined, text);
    note.style.cssText = "padding:8px 14px;background:var(--card);border:1px solid var(--border-strong);"
      + "border-radius:999px;color:var(--text);font:12.5px system-ui;box-shadow:0 8px 24px rgba(0,0,0,.4)";
    toastHost.append(note);
    setTimeout(() => note.remove(), 2200);
  }

  function copyText(text) {
    try { void navigator.clipboard?.writeText(text); } catch { /* clipboard may be unavailable */ }
    toast("Copied");
  }

  /** A row's Delete… control with an inline confirm. `file` and `sha` both come
   * from the daemon's listing, so the delete can compare-and-swap. */
  function memoryDelete(item, ask, remove) {
    const actions = el("div", "mem-row-actions");
    const del = el("button", "mem-btn danger", "Delete\u2026");
    del.type = "button";
    del.addEventListener("click", () => {
      const confirm = el("div", "mem-del-confirm");
      confirm.append(el("span", "mem-del-ask", ask));
      const go = el("button", "mem-btn danger", "Delete");
      go.type = "button";
      go.addEventListener("click", () => void deleteMemoryFile(item, actions, remove));
      const cancel = el("button", "mem-btn", "Cancel");
      cancel.type = "button";
      cancel.addEventListener("click", () => actions.replaceChildren(del));
      confirm.append(go, cancel);
      actions.replaceChildren(confirm);
    });
    actions.append(del);
    return actions;
  }

  async function deleteMemoryFile(item, actions, remove) {
    const go = actions.querySelector(".mem-btn.danger");
    if (go) { go.disabled = true; go.textContent = "Deleting\u2026"; }
    try {
      if (remove) await remove();
      else await apiPost(state.computer, "/delete", { path: item.file, sha: item.sha });
      toast("Deleted");
    } catch (error) {
      if (error.status === 409) toast("This file changed; reloaded.");
      else toast(error.message || "The delete failed.");
    }
    void loadSegment();
  }

  // ── Notes, truths, topics ──────────────────────────────────────────────
  const asItem = (item) => (typeof item === "string" ? { text: item } : (item ?? {}));

  function renderNotes(raw) {
    const inner = pane();
    const items = raw.map(asItem).sort(byDateDesc);
    if (!items.length) { inner.append(el("div", "mem-empty", "No notes in this project yet.")); return; }
    const list = el("div", "mem-list");
    for (const item of items) {
      const row = el("div", "mem-row");
      row.append(el("div", "mem-row-text", itemText(item)));
      const meta = el("div", "mem-row-meta");
      if (item.promoted) meta.append(el("span", "mem-tag conf", "promoted"));
      const when = [item.date, item.time].filter(Boolean).join(" ");
      if (when) meta.append(el("span", "mem-date", when));
      const cite = String(item.path ?? "").trim();
      if (cite) {
        const chip = el("button", "mem-cite", cite);
        chip.type = "button";
        chip.title = "Copy path";
        chip.addEventListener("click", () => copyText(cite));
        meta.append(chip);
      }
      row.append(meta);
      if (item.stableId) row.append(memoryDelete(item, "Delete this note?", () => apiPost(state.computer, "/notes/remove", { project: item.project ?? state.project, id: item.stableId })));
      list.append(row);
    }
    inner.append(list);
  }

  function renderTruths(raw) {
    const inner = pane();
    const items = raw.map(asItem);
    if (!items.length) { inner.append(el("div", "mem-empty", "No truths pinned for this project yet.")); return; }
    const list = el("div", "mem-list");
    for (const item of items) {
      const row = el("div", "mem-row");
      row.append(el("div", "mem-row-text", itemText(item)));
      const date = String(item.date ?? item.added ?? "").trim();
      if (date) {
        const meta = el("div", "mem-row-meta");
        meta.append(el("span", "mem-date", date));
        row.append(meta);
      }
      list.append(row);
    }
    inner.append(list);
  }

  function renderTopics(raw) {
    const inner = pane();
    const items = raw.map(asItem);
    if (!items.length) { inner.append(el("div", "mem-empty", "No topics in this project yet.")); return; }
    const list = el("div", "mem-list");
    for (const item of items) {
      const row = el("div", "mem-row");
      row.append(el("div", "mem-row-text", topicLabel(item)));
      const now = String(item.summary ?? item.now ?? "").trim();
      if (now) row.append(el("div", "mem-topic-summary", now));
      const count = typeof item.bullets === "number" ? item.bullets
        : typeof item.findings === "number" ? item.findings : null;
      const meta = el("div", "mem-row-meta");
      meta.append(el("span", "mem-tag type", "topic"));
      if (count != null) meta.append(el("span", "mem-meta-dim", `${count} finding${count === 1 ? "" : "s"}`));
      const date = String(item.date ?? "").trim();
      if (date) meta.append(el("span", "mem-date", date));
      row.append(meta);
      if (item.file && item.sha) row.append(memoryDelete(item, "Delete this topic?"));
      list.append(row);
    }
    inner.append(list);
  }

  // ── Graph ──────────────────────────────────────────────────────────────
  async function renderGraph() {
    const token = ++segToken;
    if (state.graph.mounted) {
      state.graph.mounted = false;
      try { window.phrenGraph?.destroy?.(); } catch { /* older bundle */ }
    }
    bodyEl.replaceChildren();
    const wrap = el("div", "mem-graph");
    const container = el("div", "graph-container");
    const canvas = el("div");
    canvas.id = "graph-canvas";
    canvas.setAttribute("aria-label", "Memory graph");
    container.append(canvas);
    const controls = el("div", "mem-graph-controls");
    const zoomIn = el("button", undefined, "+");
    const zoomOut = el("button", undefined, "\u2212");
    const reset = el("button", undefined, "\u2922");
    zoomIn.type = zoomOut.type = reset.type = "button";
    zoomIn.title = "Zoom in";
    zoomOut.title = "Zoom out";
    reset.title = "Fit graph";
    zoomIn.addEventListener("click", () => window.graphZoom?.(1.4));
    zoomOut.addEventListener("click", () => window.graphZoom?.(1 / 1.4));
    reset.addEventListener("click", () => window.graphReset?.());
    controls.append(zoomIn, zoomOut, reset);
    wrap.append(container, controls);
    bodyEl.append(wrap);

    let graph;
    try {
      graph = await loadGraphScript();
    } catch {
      wrap.replaceChildren(el("div", "mem-graph-missing", GRAPH_MISSING));
      return;
    }

    let payload;
    try {
      payload = await apiFetch(`/api/graph/${encodeURIComponent(state.computer)}`, { project: state.project });
    } catch (error) {
      if (token !== segToken) return;
      container.replaceChildren(el("div", "mem-graph-missing", error.message || "The graph could not be loaded."));
      return;
    }
    if (token !== segToken) return;

    ensureGraphHooks(graph);
    graphSelectListener = (node) => renderGraphNode(wrap, graph, node);
    try {
      if (typeof graph.mount === "function" && graph.mount.length >= 2) graph.mount(container, payload);
      else graph.mount(payload);
      state.graph.mounted = true;
    } catch {
      wrap.replaceChildren(el("div", "mem-graph-missing", GRAPH_MISSING));
    }
  }

  function renderGraphNode(wrap, graph, node) {
    wrap.querySelector(".mem-graph-side")?.remove();
    if (!node) return;
    const side = el("div", "mem-graph-side");
    const head = el("div", "mem-graph-side-head");
    const title = el("div");
    title.append(el("div", "mem-graph-kind", graphKindLabel(node)));
    title.append(el("div", "mem-graph-name", node.displayLabel || node.fullLabel || node.label || node.id || ""));
    head.append(title);
    const close = el("button", "mem-graph-close", "\u00d7");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => {
      side.remove();
      try { graph.clearSelection?.(); } catch { /* older bundle */ }
    });
    head.append(close);
    side.append(head);

    const where = [node.projectName || node.project, node.date].filter(Boolean).join(" \u00b7 ");
    if (where) side.append(el("div", "mem-graph-sub", where));
    const text = String(node.text || node.fullLabel || "").trim();
    if (text) side.append(el("div", "mem-graph-text", text));
    const docs = Array.isArray(node.docs) ? node.docs : [];
    if (docs.length) {
      const list = el("div", "mem-graph-docs");
      for (const doc of docs) {
        const cite = el("button", "mem-cite", doc);
        cite.type = "button";
        cite.title = "Copy citation";
        cite.addEventListener("click", () => copyText(doc));
        list.append(cite);
      }
      side.append(list);
    }
    const total = node.connections?.total;
    if (total) side.append(el("div", "mem-graph-sub", `${total} connection${total === 1 ? "" : "s"}`));
    wrap.append(side);
  }

  function destroyGraph() {
    if (!state.graph.mounted) return;
    state.graph.mounted = false;
    graphSelectListener = null;
    try { window.phrenGraph?.destroy?.(); } catch { /* older bundle */ }
    bodyEl.replaceChildren();
  }

  // ── Wiring ─────────────────────────────────────────────────────────────
  function onKey(ev) {
    if (root.hidden || state.segment !== "review" || state.editingLine) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const target = ev.target;
    const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA"
      || target.tagName === "SELECT" || target.isContentEditable);
    if (typing) return;
    const entry = state.reviewRows?.[state.reviewIndex];
    if (!entry) return;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      state.reviewIndex += ev.key === "ArrowDown" ? 1 : -1;
      updateReviewFocus();
      state.reviewRows[state.reviewIndex]?.row.focus();
      return;
    }
    const key = ev.key.toLowerCase();
    if (key === "a") { ev.preventDefault(); void decide(entry.item, "approve"); }
    else if (key === "e") { ev.preventDefault(); beginReviewEdit(entry.row, entry.item); }
    else if (key === "r") { ev.preventDefault(); void decide(entry.item, "reject"); }
  }
  window.addEventListener("keydown", onKey);
  store.subscribe(() => refreshComputers());

  renderSegments();
  refreshComputers();

  return {
    show() {
      if (!state.computer) { refreshComputers(); return; }
      if (state.segment === "graph" && !state.graph.mounted) void loadSegment();
    },
    hide() { if (state.segment === "graph") destroyGraph(); },
    focus() { /* the rail owns first focus */ },
    reload() { void loadProjects(); },
  };
}

let graphPromise = null;
let graphSelectListener = null;
let graphHooksReady = false;

function loadGraphScript() {
  if (window.phrenGraph) return Promise.resolve(window.phrenGraph);
  if (!graphPromise) {
    graphPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "/vendor/phren-graph.js";
      script.addEventListener("load", () => {
        if (window.phrenGraph) resolve(window.phrenGraph);
        else reject(new Error("missing"));
      });
      script.addEventListener("error", () => { graphPromise = null; reject(new Error("missing")); });
      document.head.append(script);
    });
  }
  return graphPromise;
}

function ensureGraphHooks(graph) {
  if (graphHooksReady) return;
  graphHooksReady = true;
  graph.onNodeSelect?.((node) => graphSelectListener?.(node));
  graph.onSelectionClear?.(() => graphSelectListener?.(null));
}


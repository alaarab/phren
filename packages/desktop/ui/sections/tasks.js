// Tasks: every online computer's Phren stores, their projects, and each
// project's tasks grouped Active / Queue / Done with readiness lanes. Create,
// inline edit, complete, move, pin and "Launch as agent" are written through
// the Hook's task routes. This is the phone's Tasks screen, drawn with the
// desktop shell's CSS.
import { hookGet, hookPost } from "../api.js";
import { store } from "../shell/store.js";
import { sectionHandle } from "../shell/sections.js";

const CSS_ID = "tasks-css";
const HARNESSES = [["claude", "Claude"], ["codex", "Codex"], ["opencode", "OpenCode"]];
const READINESS = {
  ready: { label: "ready", cls: "ready" },
  "waiting-on-human": { label: "waiting on human", cls: "human" },
  "waiting-on-task": { label: "waiting on task", cls: "task" },
};
const PRIORITY_CLS = { high: "high", medium: "medium", low: "low" };
const DONE_LIMIT = 20;

/** Add this section's stylesheet once (index.html does not load it). */
function ensureCss() {
  if (document.getElementById(CSS_ID)) return;
  const link = document.createElement("link");
  link.id = CSS_ID;
  link.rel = "stylesheet";
  link.href = "./sections/tasks.css";
  document.head.append(link);
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function hex8() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The editable text of a line: its priority/pinned tags removed. */
function stripTags(line) {
  return String(line ?? "")
    .replace(/\s*\[pinned\]/gi, "")
    .replace(/(\s*\[(high|medium|low)\])+\s*$/gi, "")
    .trim();
}

/** The full line a save should write back, re-appending preserved tags. */
function withTags(text, item) {
  let out = String(text ?? "").trim();
  if (item.priority) out += ` [${item.priority}]`;
  if (item.pinned) out += " [pinned]";
  return out;
}

function sourceKey(source) {
  return `${source.computer}\u0000${source.id}`;
}

function projectCounts(doc) {
  const active = doc?.items?.Active?.length ?? 0;
  const queue = doc?.items?.Queue?.length ?? 0;
  const done = doc?.items?.Done?.length ?? 0;
  return { active, queue, done };
}

let toastHost = null;
function toast(text, kind = "") {
  if (!toastHost) {
    toastHost = el("div", "tasks-toasts");
    document.body.append(toastHost);
  }
  const note = el("div", `tasks-toast${kind ? ` ${kind}` : ""}`, text);
  toastHost.append(note);
  setTimeout(() => note.remove(), 4000);
}

export function mountTasks(root) {
  ensureCss();
  root.innerHTML = `
    <div class="tasks">
      <aside class="tasks-rail">
        <div class="tasks-store" data-store></div>
        <div class="tasks-rail-head">
          <span class="section-label">Projects</span>
          <span class="tasks-rail-count" data-project-count></span>
        </div>
        <div class="tasks-projects" data-projects></div>
        <div class="tasks-rail-note" data-rail-note hidden></div>
      </aside>
      <section class="tasks-main" data-main></section>
    </div>`;

  const storeEl = root.querySelector("[data-store]");
  const projectsEl = root.querySelector("[data-projects]");
  const railNote = root.querySelector("[data-rail-note]");
  const projectCountEl = root.querySelector("[data-project-count]");
  const mainEl = root.querySelector("[data-main]");

  const state = {
    sources: [],              // { computer, id, name, role, primary, metadataWritable, projects, readonly }
    activeKey: null,
    docs: new Map(),          // project -> doc (for the active source)
    selectedProject: null,
    selectedId: null,         // task stableId/id under the cursor
    rows: [],                 // flattened visible rows for keyboard nav
    doneOpen: false,
    loading: false,
    createDraft: "",
  };

  const activeSource = () => state.sources.find((s) => sourceKey(s) === state.activeKey) ?? null;
  const activeDoc = () => state.docs.get(state.selectedProject) ?? null;

  // ---------------------------------------------------------------- stores
  async function loadStores() {
    const computers = (store.merged?.computers ?? []).filter((c) => c.state === "online");
    const found = [];
    await Promise.all(computers.map(async (c) => {
      try {
        const body = await hookGet(c.computer, "/v1/tasks/stores");
        for (const s of body.stores ?? []) {
          if (!s.id || s.available === false || s.identityReady === false || s.ambiguous) continue;
          found.push({
            computer: c.computer,
            id: s.id,
            name: s.name || s.id,
            role: s.role,
            primary: !!s.primary,
            readonly: s.role === "readonly",
            metadataWritable: !!s.metadataWritable,
            projects: Array.isArray(s.projects) ? s.projects : [],
          });
        }
      } catch {
        // An older Hook without the tasks module: it just contributes nothing.
      }
    }));
    found.sort((a, b) => (b.primary - a.primary) || a.computer.localeCompare(b.computer) || a.name.localeCompare(b.name));
    state.sources = found;
    if (!found.some((s) => sourceKey(s) === state.activeKey)) {
      state.activeKey = found.length ? sourceKey(found[0]) : null;
      state.selectedProject = null;
      state.docs.clear();
    }
    renderStore();
    renderRailNote();
    if (state.activeKey) await loadDocs();
  }

  async function loadDocs() {
    const source = activeSource();
    if (!source) return;
    state.loading = true;
    renderProjects();
    const entries = await Promise.all(source.projects.map(async (project) => {
      try {
        const doc = await hookGet(source.computer, "/v1/tasks", { storeId: source.id, project });
        return [project, doc];
      } catch {
        return [project, null];
      }
    }));
    state.docs = new Map(entries.filter(([, doc]) => doc));
    state.loading = false;
    if (state.selectedProject && !source.projects.includes(state.selectedProject)) state.selectedProject = null;
    renderProjects();
    renderMain();
  }

  async function reloadProject(project) {
    const source = activeSource();
    if (!source || !project) return;
    try {
      state.docs.set(project, await hookGet(source.computer, "/v1/tasks", { storeId: source.id, project }));
    } catch { /* keep the last good copy */ }
    renderProjects();
    renderMain();
  }

  // ---------------------------------------------------------------- rail
  function renderStore() {
    storeEl.replaceChildren();
    if (!state.sources.length) {
      storeEl.append(el("div", "tasks-empty", "No task store is reachable."));
      return;
    }
    if (state.sources.length === 1) {
      const only = state.sources[0];
      storeEl.append(el("div", "tasks-store-name", only.name), el("div", "tasks-store-host", only.computer));
      return;
    }
    const select = el("select", "tasks-store-select");
    select.setAttribute("aria-label", "Task store");
    for (const source of state.sources) {
      const option = el("option", undefined, `${source.name} · ${source.computer}`);
      option.value = sourceKey(source);
      option.selected = sourceKey(source) === state.activeKey;
      select.append(option);
    }
    select.addEventListener("change", () => {
      state.activeKey = select.value;
      state.selectedProject = null;
      state.selectedId = null;
      state.docs.clear();
      void loadDocs();
    });
    storeEl.append(select);
  }

  function renderRailNote() {
    const source = activeSource();
    const note = !state.sources.length
      ? "No computer running Phren with the tasks module is online."
      : source?.readonly ? "Read-only store: editing is disabled." : "";
    railNote.textContent = note;
    railNote.hidden = !note;
  }

  function renderProjects() {
    projectsEl.replaceChildren();
    const source = activeSource();
    projectCountEl.textContent = source?.projects?.length ? String(source.projects.length) : "";
    if (!source) return;
    if (state.loading && !state.docs.size) {
      projectsEl.append(el("div", "tasks-empty", "Loading projects…"));
      return;
    }
    const names = [...source.projects].sort((a, b) => {
      const ca = projectCounts(state.docs.get(a));
      const cb = projectCounts(state.docs.get(b));
      return (cb.active + cb.queue) - (ca.active + ca.queue) || a.localeCompare(b);
    });
    if (!names.length) {
      projectsEl.append(el("div", "tasks-empty", "This store subscribes to no projects."));
      return;
    }
    for (const project of names) {
      const doc = state.docs.get(project);
      const counts = projectCounts(doc);
      const row = el("button", `tasks-project${project === state.selectedProject ? " selected" : ""}`);
      row.type = "button";
      row.dataset.project = project;
      row.append(el("span", "tasks-project-name", project));
      const chips = el("span", "tasks-project-counts");
      if (counts.active) chips.append(el("span", "tasks-count active", `${counts.active}`));
      if (counts.queue) chips.append(el("span", "tasks-count queue", `${counts.queue}`));
      if (!counts.active && !counts.queue && counts.done) chips.append(el("span", "tasks-count done", `${counts.done} done`));
      row.append(chips);
      row.addEventListener("click", () => {
        state.selectedProject = project;
        state.selectedId = null;
        renderProjects();
        renderMain();
      });
      projectsEl.append(row);
    }
  }

  // ---------------------------------------------------------------- main
  function renderMain() {
    mainEl.replaceChildren();
    state.rows = [];
    const source = activeSource();
    if (!source) {
      mainEl.append(el("div", "tasks-empty", "Select a task store."));
      return;
    }
    const project = state.selectedProject;
    if (!project) {
      mainEl.append(el("div", "tasks-empty", "Pick a project to see its tasks."));
      return;
    }
    // A project with no tasks.md yet still gets the composer, so its first
    // task can be created.
    const doc = activeDoc() ?? { project, revision: null, metadataWritable: source.metadataWritable, items: { Active: [], Queue: [], Done: [] } };
    const canMeta = !source.readonly && (doc.metadataWritable ?? source.metadataWritable);
    const write = !source.readonly;

    const counts = projectCounts(doc);
    const head = el("div", "tasks-main-head");
    head.append(el("h2", "tasks-main-title", project));
    head.append(el("div", "tasks-main-sub", `${counts.active} active · ${counts.queue} queue · ${counts.done} done`));
    mainEl.append(head);

    mainEl.append(createRow(source, project, canMeta));

    const body = el("div", "tasks-body");
    for (const section of ["Active", "Queue", "Done"]) {
      body.append(sectionBlock(section, doc, source, { canMeta, write }));
    }
    mainEl.append(body);

    syncSelection();
  }

  function sectionBlock(section, doc, source, perms) {
    const items = doc.items?.[section] ?? [];
    const block = el("div", `tasks-section tasks-section-${section.toLowerCase()}`);
    const head = el("div", "tasks-section-head");
    const label = el("span", "tasks-section-label", section === "Queue" ? "Queue" : section);
    const count = el("span", "tasks-section-count", String(items.length));
    head.append(label, count);
    if (section === "Done") {
      const toggle = el("button", "tasks-done-toggle", state.doneOpen ? "Hide" : "Show");
      toggle.type = "button";
      toggle.addEventListener("click", () => { state.doneOpen = !state.doneOpen; renderMain(); });
      head.append(toggle);
    }
    block.append(head);

    if (!items.length) {
      block.append(el("div", "tasks-empty", section === "Done" ? "Nothing completed yet." : `No ${section.toLowerCase()} tasks.`));
      return block;
    }
    const shown = section === "Done" && !state.doneOpen ? [] : (section === "Done" ? items.slice(0, DONE_LIMIT) : items);
    if (!shown.length) return block;
    const list = el("div", "tasks-list");
    for (const item of shown) list.append(taskRow(section, item, doc, source, perms));
    block.append(list);
    if (section === "Done" && state.doneOpen && items.length > DONE_LIMIT) {
      block.append(el("div", "tasks-empty", `${items.length - DONE_LIMIT} older done tasks`));
    }
    return block;
  }

  function readyChip(item) {
    const info = READINESS[item.readiness] ?? READINESS.ready;
    return el("span", `tasks-chip readiness ${info.cls}`, info.label);
  }

  function taskRow(section, item, doc, source, perms) {
    const id = item.stableId ?? item.id;
    const row = el("div", `tasks-row${state.selectedId === id ? " selected" : ""}`);
    row.dataset.id = id;
    row.dataset.project = doc.project;
    row.dataset.section = section;
    state.rows.push({ id, project: doc.project, section, item });

    const check = el("button", `tasks-check${item.checked || section === "Done" ? " on" : ""}`);
    check.type = "button";
    check.setAttribute("role", "checkbox");
    check.setAttribute("aria-checked", String(!!(item.checked || section === "Done")));
    check.setAttribute("aria-label", section === "Done" ? "Reopen task" : "Complete task");
    check.disabled = !perms.write;
    check.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void completeTask(doc, item, section);
    });

    const main = el("div", "tasks-row-main");
    const text = el("div", "tasks-text", stripTags(item.line));
    if (section === "Done" || item.checked) text.classList.add("done");
    main.append(text);

    const chips = el("div", "tasks-chips");
    if (item.priority) chips.append(el("span", `tasks-chip priority ${PRIORITY_CLS[item.priority] ?? ""}`, item.priority));
    if (item.pinned) chips.append(el("span", "tasks-chip pinned", "pinned"));
    chips.append(readyChip(item));
    if (item.responsibility === "human") chips.append(el("span", "tasks-chip human", "human"));
    if (item.identityAmbiguous || (item.identity === null && item.stableId)) chips.append(el("span", "tasks-chip warn", "identity ambiguous"));
    main.append(chips);

    main.addEventListener("dblclick", () => { if (perms.canMeta) beginEdit(row, text, doc, item, section); });
    row.append(check, main);

    const menu = el("button", "tasks-row-menu", "\u22ef");
    menu.type = "button";
    menu.setAttribute("aria-label", "Task actions");
    menu.addEventListener("click", (ev) => { ev.stopPropagation(); openMenu(row, doc, item, section, perms); });
    row.append(menu);

    row.addEventListener("click", () => {
      state.selectedId = id;
      syncSelection();
    });
    return row;
  }

  function syncSelection() {
    for (const row of mainEl.querySelectorAll(".tasks-row")) {
      row.classList.toggle("selected", row.dataset.id === state.selectedId);
    }
    const active = mainEl.querySelector(".tasks-row.selected");
    active?.scrollIntoView({ block: "nearest" });
  }

  // ---------------------------------------------------------------- create
  function createRow(source, project, canMeta) {
    const wrap = el("div", "tasks-create");
    const input = el("input", "tasks-create-input");
    input.type = "text";
    input.placeholder = canMeta ? "Add a task to Queue… (N)" : "This store is read-only.";
    input.disabled = !canMeta;
    input.value = state.createDraft;
    input.setAttribute("aria-label", "New task");
    input.addEventListener("input", () => { state.createDraft = input.value; });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); void createTask(source, project); }
    });
    state.createInput = input;
    wrap.append(input);
    if (canMeta && state.createDraft.trim()) wrap.append(el("span", "tasks-create-hint", "Enter to add"));
    return wrap;
  }

  async function createTask(source, project) {
    const text = state.createDraft.trim();
    if (!text) return;
    const stableId = hex8();
    try {
      const doc = await hookPost(source.computer, "/v1/tasks/create", {
        storeId: source.id, project, stableId, responsibility: "agent", text,
      });
      state.docs.set(project, doc);
      state.createDraft = "";
      toast("Added to Queue");
      renderProjects();
      renderMain();
    } catch (error) {
      if (error.status === 409) {
        toast("This list changed; reloaded.", "warn");
        await reloadProject(project);
        return;
      }
      toast(error.message || "The task could not be added.", "error");
    }
  }

  // ---------------------------------------------------------------- edit
  function beginEdit(row, textEl, doc, item, section) {
    const input = el("input", "tasks-edit-input");
    input.type = "text";
    input.value = stripTags(item.line);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); void saveText(doc, item, input.value); }
      else if (ev.key === "Escape") { ev.preventDefault(); renderMain(); }
    });
    input.addEventListener("blur", () => { if (input.isConnected) renderMain(); });
    textEl.replaceWith(input);
    input.focus();
    input.select();
  }

  async function saveText(doc, item, value) {
    const text = String(value ?? "").trim();
    if (!text || text === stripTags(item.line)) { renderMain(); return; }
    const source = activeSource();
    await write("save", source, {
      storeId: source.id, project: doc.project, stableId: item.stableId ?? item.id,
      expectedRevision: doc.revision, updates: { text: withTags(text, item) },
    });
  }

  /** Apply one write route; refresh the project's document from its reply, or
   * reload on a revision conflict. */
  async function write(route, source, body) {
    try {
      const doc = await hookPost(source.computer, `/v1/tasks/${route}`, body);
      if (body.project) state.docs.set(body.project, doc);
      renderProjects();
      renderMain();
      return true;
    } catch (error) {
      if (error.status === 409) {
        toast("This list changed; reloaded.", "warn");
        await reloadProject(body.project);
        return false;
      }
      toast(error.message || "The write failed.", "error");
      return false;
    }
  }

  async function completeTask(doc, item, section) {
    const source = activeSource();
    const target = section === "Done" ? "Active" : "Done";
    await write("update", source, {
      storeId: source.id, project: doc.project, stableId: item.stableId ?? item.id,
      updates: { section: target },
    });
    toast(target === "Done" ? "Completed" : "Reopened");
  }

  async function moveTask(doc, item, section, target) {
    if (section === target) return;
    const source = activeSource();
    await write("update", source, {
      storeId: source.id, project: doc.project, stableId: item.stableId ?? item.id,
      updates: { section: target },
    });
    toast(`Moved to ${target}`);
  }

  async function pinTask(doc, item) {
    const source = activeSource();
    let text = stripTags(item.line);
    if (item.priority) text += ` [${item.priority}]`;
    if (!item.pinned) text += " [pinned]";
    await write("save", source, {
      storeId: source.id, project: doc.project, stableId: item.stableId ?? item.id,
      expectedRevision: doc.revision, updates: { text },
    });
    toast(item.pinned ? "Unpinned" : "Pinned");
  }

  async function deleteTask(doc, item) {
    const source = activeSource();
    try {
      await hookPost(source.computer, "/v1/tasks/remove", {
        storeId: source.id, project: doc.project, stableId: item.stableId ?? item.id,
      });
      toast("Deleted");
      await reloadProject(doc.project);
    } catch {
      toast(`Deleting needs a newer Phren on ${source.computer}.`, "error");
    }
  }

  // ---------------------------------------------------------------- menu
  let openMenuEl = null;
  function closeMenu() {
    openMenuEl?.remove();
    openMenuEl = null;
  }

  function menuButton(label, onClick, { disabled = false, danger = false, title = "" } = {}) {
    const b = el("button", `tasks-menu-item${danger ? " danger" : ""}`, label);
    b.type = "button";
    b.disabled = disabled;
    if (title) b.title = title;
    b.addEventListener("click", (ev) => { ev.stopPropagation(); onClick(); });
    return b;
  }

  function openMenu(rowEl, doc, item, section, perms) {
    closeMenu();
    const menu = el("div", "tasks-menu");
    const launchable = item.responsibility !== "human" && !item.checked && section !== "Done"
      && item.readiness === "ready" && !!item.identity && !item.identityAmbiguous;
    menu.append(menuButton("Launch as agent", () => { closeMenu(); openLaunch(rowEl, doc, item); },
      { disabled: !launchable, title: launchable ? "" : "Only ready agent tasks can start an agent." }));
    for (const target of ["Active", "Queue", "Done"]) {
      if (target === section) continue;
      menu.append(menuButton(target === "Queue" ? "Move to Backlog" : `Move to ${target}`,
        () => { closeMenu(); void moveTask(doc, item, section, target); }));
    }
    menu.append(menuButton(item.pinned ? "Unpin" : "Pin", () => { closeMenu(); void pinTask(doc, item); },
      { disabled: !perms.canMeta }));
    menu.append(menuButton("Edit", () => {
      closeMenu();
      const text = rowEl.querySelector(".tasks-text");
      if (text) beginEdit(rowEl, text, doc, item, section);
    }, { disabled: !perms.canMeta }));
    menu.append(menuButton("Delete", () => {
      confirm.hidden = false;
      menu.replaceChildren(confirm);
    }, { disabled: !perms.canMeta, danger: true }));

    const normalItems = [...menu.children];
    const confirm = el("div", "tasks-menu-confirm");
    confirm.hidden = true;
    confirm.append(
      el("span", "tasks-menu-ask", "Delete this task?"),
      menuButton("Delete", () => { closeMenu(); void deleteTask(doc, item); }, { danger: true }),
      menuButton("Cancel", () => { confirm.hidden = true; menu.replaceChildren(...normalItems); }),
    );

    rowEl.append(menu);
    openMenuEl = menu;
    setTimeout(() => { document.addEventListener("click", closeMenu, { once: true }); }, 0);
  }

  function openLaunch(rowEl, doc, item) {
    closeMenu();
    const source = activeSource();
    const panel = el("div", "tasks-menu tasks-launch");
    panel.append(el("div", "tasks-launch-title", "Launch as agent"));
    const computers = (store.merged?.computers ?? []).filter((c) => c.state === "online").map((c) => c.computer);
    if (!computers.includes(source.computer)) computers.unshift(source.computer);

    const computer = el("select", "tasks-launch-select");
    computer.setAttribute("aria-label", "Computer");
    for (const name of computers) {
      const o = el("option", undefined, name);
      o.value = name;
      o.selected = name === source.computer;
      computer.append(o);
    }
    const harness = el("select", "tasks-launch-select");
    harness.setAttribute("aria-label", "Harness");
    for (const [kind, label] of HARNESSES) {
      const o = el("option", undefined, label);
      o.value = kind;
      harness.append(o);
    }
    const go = menuButton("Launch", () => { closeMenu(); void launchTask(source, doc, item, computer.value, harness.value); });
    go.classList.add("tasks-launch-go");
    panel.append(el("label", "tasks-launch-field", "Computer"), computer, el("label", "tasks-launch-field", "Harness"), harness, go);
    rowEl.append(panel);
    openMenuEl = panel;
    setTimeout(() => { document.addEventListener("click", closeMenu, { once: true }); }, 0);
  }

  // ---------------------------------------------------------------- launch
  async function launchTask(source, doc, item, computer, kind) {
    try {
      const result = await hookPost(computer, "/v1/tasks/launch", {
        storeId: source.id, project: doc.project, stableId: item.stableId ?? item.id,
        expectedRevision: doc.revision, kind,
      });
      const session = result.sessionId ?? result.target?.session;
      const label = session ? `Launched · ${String(session).slice(0, 18)}` : "Launched";
      toast(result.state === "uncertain" ? `${label} (unconfirmed)` : label);
      await reloadProject(doc.project);
      if (session) watchSession(computer, result.target, session);
    } catch (error) {
      if (error.status === 409) {
        toast("This list changed; reloaded.", "warn");
        await reloadProject(doc.project);
        return;
      }
      toast(error.message || "The launch failed.", "error");
    }
  }

  /** Open the new session in Agents once the overview lists it, or say so. */
  function watchSession(computer, target, session) {
    const deadline = Date.now() + 10000;
    const tick = () => {
      const row = store.sessions().find((s) => s.computer === computer
        && ((target?.session && s.child.target?.session === target.session)
          || s.child.target?.session === session
          || (target?.pane && s.child.target?.pane === target.pane)));
      if (row) {
        sectionHandle("agents").openSession(computer, row.child);
        return;
      }
      if (Date.now() > deadline) { toast("Launched, but its session has not appeared yet."); return; }
      setTimeout(tick, 500);
    };
    tick();
  }

  // ---------------------------------------------------------------- wiring
  let lastComputers = "";
  store.subscribe((merged) => {
    const sig = (merged?.computers ?? []).map((c) => `${c.computer}:${c.state}`).join("|");
    if (sig !== lastComputers) {
      lastComputers = sig;
      void loadStores();
    }
  });

  function onKey(ev) {
    if (root.hidden) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const target = ev.target;
    const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA"
      || target.tagName === "SELECT" || target.isContentEditable);
    if (ev.key === "Escape") { closeMenu(); return; }
    if (typing) return;
    const key = ev.key;
    if (key === "ArrowDown" || key === "ArrowUp") {
      if (!state.rows.length) return;
      ev.preventDefault();
      let idx = state.rows.findIndex((r) => r.id === state.selectedId);
      if (idx === -1) idx = key === "ArrowDown" ? -1 : state.rows.length;
      idx += key === "ArrowDown" ? 1 : -1;
      state.selectedId = state.rows[Math.max(0, Math.min(state.rows.length - 1, idx))].id;
      syncSelection();
      return;
    }
    if (key === " ") {
      const row = state.rows.find((r) => r.id === state.selectedId);
      if (!row || !activeDoc()) return;
      ev.preventDefault();
      void completeTask(activeDoc(), row.item, row.section);
      return;
    }
    if (key === "Enter") {
      const rowEl = mainEl.querySelector(".tasks-row.selected");
      const row = state.rows.find((r) => r.id === state.selectedId);
      if (!rowEl || !row || !activeDoc()) return;
      ev.preventDefault();
      const text = rowEl.querySelector(".tasks-text");
      if (text) beginEdit(rowEl, text, activeDoc(), row.item, row.section);
      return;
    }
    if (key.toLowerCase() === "n" && state.createInput && !state.createInput.disabled) {
      ev.preventDefault();
      state.createInput.focus();
    }
  }
  window.addEventListener("keydown", onKey);

  return {
    show() { if (state.activeKey) void loadDocs(); },
    hide() { closeMenu(); },
    focus() { /* the create field owns first focus */ },
    reload() { void loadStores(); },
  };
}

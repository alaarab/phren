import { el } from "../dom.js";
// Projects: every project across the computers as a grid of cards. Each card
// opens a detail page with the project's memory (summary, open work, live
// sessions, skills, knobs). Add a repository to a computer, or launch an agent
// straight into a project. The store routes read a computer's phren store;
// the phone's Projects screen is the base, drawn with the desktop's variables.
import { hookGet } from "../api.js";
import { openLaunchSheet } from "../shell/launch.js";
import { sessions as allSessions, projectOf, store } from "../shell/store.js";
import { sectionHandle, showSection } from "../shell/sections.js";
import { storeBlobText, storeTree } from "../store-cache.js";
import { clear, countActiveFindings, countOpenTasks, firstLine, parseKnows, projectFiles } from "./projects/data.js";
import { createSheets } from "./projects/sheets.js";
import { createDialogs } from "./projects/dialogs.js";
import { createForge } from "./projects/forge.js";
import { createToday } from "./projects/today.js";
import { createDetail } from "./projects/detail.js";
import { createGrid } from "./projects/grid.js";

const STYLE_ID = "projects-styles";

function installStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const link = document.createElement("link");
  link.id = STYLE_ID;
  link.rel = "stylesheet";
  link.href = new URL("projects.css", import.meta.url).href;
  document.head.append(link);
}

export function mountProjects(root) {
  installStyles();
  root.classList.add("section-projects");

  const state = {
    merged: null,
    query: "",
    computer: "all",
    view: "grid",
    detail: null, // { computer, name }
    data: new Map(), // computer -> { projects: Map, tree, at }
    loading: new Set(),
    todayOpen: new Set(), // Today groups expanded past TODAY_ROWS on the open page
    failures: new Map(), // computer -> message
  };

  const shell = el("div", "pj");
  const header = el("div", "pj-header");
  const body = el("div", "pj-body");
  shell.append(header, body);
  root.replaceChildren(shell);

  function openInAgents(computer, child) {
    showSection("agents");
    sectionHandle("agents")?.openSession?.(computer, child);
  }

  function onlineComputers() {
    return (state.merged?.computers ?? []).filter((c) => c.state === "online");
  }

  function sessionsFor(computer, name) {
    return allSessions(state.merged).filter((row) => row.computer === computer && projectOf(row.child) === name);
  }

  // ------------------------------------------------------------- loading

  /** One project's card facts: the summary line, the counts. Assigned together, so a render mid-read keeps the last values. */
  async function hydrate(computer, project) {
    const files = project.files;
    const counts = { findings: null, tasks: null };
    let knowsText = null, summaryLine;
    const summaryNode = files.get("summary.md");
    if (summaryNode) {
      try {
        const summary = await storeBlobText(computer, summaryNode.sha);
        const knows = parseKnows(summary);
        knowsText = knows?.text ?? null;
        summaryLine = knows?.summaryLine || firstLine(summary);
        if (knows?.counts.findings !== null && knows?.counts.findings !== undefined) counts.findings = knows.counts.findings;
        if (knows?.counts.tasks !== null && knows?.counts.tasks !== undefined) counts.tasks = knows.counts.tasks;
      } catch { /* summary is optional detail */ }
    }
    const tasks = files.get("tasks.md"), findings = files.get("FINDINGS.md");
    const [taskText, findingText] = await Promise.all([
      counts.tasks === null && tasks ? storeBlobText(computer, tasks.sha).catch(() => null) : null,
      counts.findings === null && findings ? storeBlobText(computer, findings.sha).catch(() => null) : null,
    ]);
    if (taskText !== null) counts.tasks = countOpenTasks(taskText);
    if (findingText !== null) counts.findings = countActiveFindings(findingText);
    Object.assign(project, { knows: knowsText, summaryLine, counts, hydrated: true });
    return project;
  }


  // The read in flight per computer, so a second caller (⌘K) waits for it instead of returning early.
  const inflight = new Map();
  function loadComputer(computer, options = {}) {
    if (inflight.has(computer)) return inflight.get(computer);
    const read = readComputer(computer, options).finally(() => inflight.delete(computer));
    inflight.set(computer, read);
    return read;
  }

  async function readComputer(computer, { force = false } = {}) {
    if (state.loading.has(computer)) return;
    if (state.data.has(computer) && !force) return;
    state.loading.add(computer);
    state.failures.delete(computer);
    render();
    try {
      const caps = await store.capabilities(computer);
      const projects = new Map();
      let tree = [];
      try {
        const body = await hookGet(computer, "/v1/projects/repos");
        for (const repo of body.repos ?? []) {
          if (repo.registered) projects.set(repo.name, { name: repo.name, directory: repo.directory, computer, lastSeen: repo.lastSeen });
        }
      } catch { /* a Hook without the route still lists projects from its store */ }
      if (caps.memoryStore) {
        try {
          const head = await hookGet(computer, "/v1/store/head");
          tree = await storeTree(computer, head.sha);
          for (const node of tree) {
            if (node.type !== "blob") continue;
            // A project is a top-level folder of the store; skip loose files and dot folders.
            const slash = node.path.indexOf("/");
            if (slash <= 0) continue;
            const name = node.path.slice(0, slash);
            // Only folders holding Phren's own files are projects (not profiles/, scripts/, templates/).
            const file = node.path.slice(slash + 1);
            if (!/^(FINDINGS\.md|tasks\.md|summary\.md|phren\.project\.yaml)$/.test(file)) continue;
            if (name !== "global" && !name.startsWith(".") && !projects.has(name)) projects.set(name, { name, computer });
          }
        } catch { /* the store is unavailable; repos remain */ }
      }
      const wasDetail = state.detail && state.detail.computer === computer ? state.detail.name : null;
      // Show the cards as soon as the list is known; summaries and counts fill in after.
      const previous = state.data.get(computer)?.projects;
      for (const project of projects.values()) {
        const before = previous?.get(project.name);
        if (before?.hydrated) Object.assign(project, { summaryLine: before.summaryLine, knows: before.knows, counts: before.counts });
        project.files = projectFiles(tree, project.name);
      }
      state.data.set(computer, { projects, tree, at: Date.now() });
      if (wasDetail) state.detail = { computer, name: wasDetail };
      render();
      await Promise.all([...projects.values()].map((project) => hydrate(computer, project)));
    } catch (err) {
      state.failures.set(computer, err?.message ?? String(err));
    } finally {
      state.loading.delete(computer);
      render();
    }
  }

  function ensureLoaded({ force = false } = {}) {
    for (const c of onlineComputers()) {
      if (force || !state.data.has(c.computer)) void loadComputer(c.computer, { force });
    }
  }

  // ------------------------------------------------------------- rendering

  function render() {
    renderHeader();
    if (state.view === "detail" && state.detail) renderDetail();
    else renderGrid();
  }

  function renderHeader() {
    clear(header);
    if (state.view === "detail" && state.detail) {
      const back = el("button", "pj-back", "\u2039 Projects");
      back.addEventListener("click", () => { state.view = "grid"; state.detail = null; render(); });
      const title = el("h1", "pj-title", state.detail.name);
      const host = el("span", "pj-host", state.detail.computer);
      const spacer = el("span", "pj-spacer");
      const launch = el("button", "pj-btn accent", "New agent");
      launch.addEventListener("click", () => openLaunchSheet({ project: state.detail.name, computer: state.detail.computer, title: `New agent in ${state.detail.name}` }));
      header.append(back, title, host, spacer);
      const knobsBtn = el("button", "pj-btn", "Knobs");
      knobsBtn.addEventListener("click", () => openKnobs(state.detail));
      // Ask phren about this project from its memory, without tools.
      const chat = el("button", "pj-btn", "Quick chat");
      chat.addEventListener("click", () => openLaunchSheet({ chat: true, project: state.detail.name, computer: state.detail.computer, title: `Quick chat about ${state.detail.name}` }));
      header.append(knobsBtn, chat, launch);
      return;
    }
    const title = el("h1", "pj-title", "Projects");
    const spacer = el("span", "pj-spacer");
    const search = document.createElement("input");
    search.type = "search";
    search.className = "pj-search";
    search.placeholder = "Filter projects";
    search.setAttribute("aria-label", "Filter projects");
    search.value = state.query;
    search.addEventListener("input", () => { state.query = search.value; renderGrid(); });
    const filter = document.createElement("select");
    filter.className = "pj-select";
    filter.setAttribute("aria-label", "Computer");
    const all = el("option", null, "All computers");
    all.value = "all";
    filter.append(all);
    for (const c of onlineComputers()) {
      const option = el("option", null, c.computer);
      option.value = c.computer;
      filter.append(option);
    }
    if (state.computer !== "all" && !onlineComputers().some((c) => c.computer === state.computer)) state.computer = "all";
    filter.value = state.computer;
    filter.addEventListener("change", () => { state.computer = filter.value; renderGrid(); });
    const add = el("button", "pj-btn", "Add project");
    add.addEventListener("click", openAddProject);
    const refresh = el("button", "pj-icon", "\u21bb");
    refresh.title = "Refresh";
    refresh.setAttribute("aria-label", "Refresh projects");
    refresh.addEventListener("click", () => ensureLoaded({ force: true }));
    header.append(title, spacer, search, filter, add, refresh);
  }

  // Each feature is a factory over this context; every one adds what the next needs.
  const ctx = { state, body, onlineComputers, sessionsFor, openInAgents, loadComputer, render, renderDetail: () => ctx.detail.renderDetail() };
  ctx.sheets = createSheets();
  Object.assign(ctx, createDialogs(ctx));
  Object.assign(ctx, createForge(ctx), createToday(ctx));
  ctx.detail = createDetail(ctx);
  Object.assign(ctx, ctx.detail);
  const { renderGrid } = createGrid(ctx);
  const { renderDetail, loadToday, scheduleMidnight, stopMidnight, loadForge, loadDetailFiles } = ctx;
  const { openKnobs, openAddProject } = ctx;
  const { closeSheet } = ctx.sheets;

  // ------------------------------------------------------------- lifecycle

  const unsubscribe = store.subscribe((merged) => {
    state.merged = merged;
    if (state.view === "detail" && state.detail) renderDetail();
    else renderGrid();
    ensureLoaded();
  });
  ensureLoaded();
  render();

  return {
    show() {
      ensureLoaded();
      render();
      if (state.view === "detail" && state.detail) void loadToday(); // cache-respecting: a read only when stale or failed
      scheduleMidnight();
    },
    hide() { stopMidnight(); },
    /** Every project loaded so far, across computers (⌘K lists them). */
    projects() {
      return [...state.data.values()].flatMap((entry) => [...entry.projects.values()].map((p) => ({ computer: p.computer, name: p.name, lastSeen: p.lastSeen })));
    },
    /** Load the online computers not loaded yet; resolves once those reads finish. */
    load() {
      return Promise.all(onlineComputers().filter((c) => !state.data.has(c.computer)).map((c) => loadComputer(c.computer)));
    },
    /** Open one project's page. */
    open({ computer, name }) {
      state.view = "detail";
      state.detail = { computer, name };
      loadDetailFiles();
      loadForge();
      state.todayOpen.clear();
      loadToday();
      render();
    },
    destroy() { unsubscribe(); closeSheet(); },
  };
}

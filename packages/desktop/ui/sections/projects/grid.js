// The Projects grid: filtered project cards.
import { el } from "../../dom.js";
import { skeleton } from "../../shell/skeleton.js";
import { age, clear } from "./data.js";

export function createGrid(ctx) {
  const { state, body, onlineComputers, sessionsFor, loadDetailFiles, loadForge, loadToday, render } = ctx;

  /** Every card row for the current computer filter and search text. */
  function visibleProjects() {
    const query = state.query.trim().toLowerCase();
    const rows = [];
    const computers = state.computer === "all" ? onlineComputers().map((c) => c.computer) : [state.computer];
    for (const computer of computers) {
      const entry = state.data.get(computer);
      if (!entry) continue;
      for (const project of entry.projects.values()) {
        if (query && !project.name.toLowerCase().includes(query)) continue;
        rows.push(project);
      }
    }
    rows.sort((a, b) => a.name.localeCompare(b.name) || a.computer.localeCompare(b.computer));
    return rows;
  }
  function renderGrid() {
    clear(body);
    const rows = visibleProjects();
    const loading = onlineComputers().some((c) => state.loading.has(c.computer));
    const failures = [...state.failures.values()];
    if (!rows.length && (loading || !state.data.size)) {
      body.append(loading
        ? skeleton({ count: 6, wrapClass: "pj-grid", itemClass: "pj-card", widths: ["40%", "22%", "92%", "68%"], label: "Reading projects\u2026" })
        : el("div", "pj-empty", "No computers are online."));
      return;
    }
    if (!rows.length) {
      body.append(el("div", "pj-empty", state.query.trim() ? "No matching projects." : "No projects yet. Add one from a computer."));
      return;
    }
    const grid = el("div", "pj-grid");
    for (const project of rows) grid.append(projectCard(project));
    body.append(grid);
    for (const message of failures) body.append(el("div", "pj-error", message));
  }

  function projectCard(project) {
    const card = el("button", "pj-card");
    const head = el("div", "pj-card-head");
    head.append(el("span", "pj-card-name", project.name));
    const sessions = sessionsFor(project.computer, project.name);
    const working = sessions.filter((row) => row.child.agentStatus === "working").length;
    if (working) head.append(el("span", "pj-dot working"));
    else if (sessions.some((row) => row.child.agentStatus === "blocked" || row.child.approvalPending)) head.append(el("span", "pj-dot waiting"));
    card.append(head);
    card.append(el("div", "pj-card-sub muted", project.computer));
    const summary = el("div", "pj-card-summary", project.summaryLine || (project.hydrated ? "No summary yet." : "\u00a0"));
    card.append(summary);
    const stats = el("div", "pj-card-stats");
    if (typeof project.counts?.findings === "number") stats.append(el("span", "pj-stat", `${project.counts.findings} findings`));
    if (typeof project.counts?.tasks === "number") stats.append(el("span", "pj-stat", `${project.counts.tasks} open tasks`));
    if (sessions.length) stats.append(el("span", "pj-stat", `${sessions.length} session${sessions.length === 1 ? "" : "s"}`));
    const last = sessions.map((row) => row.child.lastChangedAt).filter(Boolean).sort().pop() || project.lastSeen;
    if (last) stats.append(el("span", "pj-stat", `active ${age(last)}`));
    card.append(stats);
    card.addEventListener("click", () => { state.view = "detail"; state.detail = { computer: project.computer, name: project.name }; state.todayOpen.clear(); loadDetailFiles(); loadForge(); loadToday(); render(); });
    return card;
  }

  return { renderGrid };
}

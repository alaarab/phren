import { el } from "../../dom.js";
import { loadTaskSources, loadTaskDoc, taskSourceKey, TASK_FRESH_MS } from "../../shell/task-cache.js";
import { openLaunchSheet } from "../../shell/launch.js";
import { showSection } from "../../shell/sections.js";

export function createActiveTasks({ block, state }) {
  const scope = block("active-tasks");
  const list = scope.querySelector(".home-list");
  const more = el("button", "home-more");
  more.type = "button";
  more.addEventListener("click", () => showSection("tasks")?.filterSection("Active"));
  scope.append(more);
  let entries = [];
  let rows = new Map();
  let timer = null;
  let visible = false;
  let generation = 0;
  let onlineKey = "";
  function render() {
    const online = new Set((state.merged?.computers ?? []).filter((c) => c.state === "online").map((c) => c.computer));
    const key = [...online].sort().join("\n");
    if (visible && key !== onlineKey) { onlineKey = key; void refresh(); }
    const sorted = entries.filter((e) => online.has(e.source.computer)).sort((a, b) =>
      (Date.parse(b.item.createdAt) || 0) - (Date.parse(a.item.createdAt) || 0) || a.key.localeCompare(b.key));
    scope.hidden = !sorted.length;
    scope.querySelector(".count").textContent = String(sorted.length);
    more.hidden = sorted.length <= 6;
    more.textContent = `+${Math.max(0, sorted.length - 6)} more`;
    const next = new Map();
    const active = document.activeElement;
    let focused;
    const nodes = sorted.slice(0, 6).map((entry) => {
      let row = rows.get(entry.key);
      if (!row) {
        const node = el("div", "home-row home-active-task");
        const main = el("div", "home-row-main");
        const title = el("span", "home-row-title");
        const meta = el("span", "home-row-meta");
        const project = el("span", "home-upnext-label");
        const computer = el("span", "home-upnext-label");
        meta.append(project, computer);
        main.append(title, meta);
        const launch = el("button", "home-task-launch", "Launch");
        launch.type = "button";
        row = { node, title, project, computer, launch, entry };
        launch.addEventListener("click", () => {
          const { item, source, project } = row.entry;
          void openLaunchSheet({ project, computer: source.computer, prompt: item.line, title: "Launch as agent" });
        });
        node.append(main, launch);
      }
      row.entry = entry;
      row.title.textContent = entry.item.line;
      row.title.title = entry.item.line;
      row.project.textContent = row.project.title = entry.project;
      row.computer.textContent = row.computer.title = entry.source.computer;
      row.launch.setAttribute("aria-label", `Launch ${entry.item.line}`);
      if (row.launch === active) focused = row.launch;
      next.set(entry.key, row);
      return row.node;
    });
    rows = next;
    if (nodes.length !== list.children.length || nodes.some((node, i) => node !== list.children[i])) {
      list.replaceChildren(...nodes);
      focused?.focus();
    }
  }
  async function refresh() {
    const mine = ++generation;
    const sources = await loadTaskSources(state.merged?.computers ?? []);
    const groups = await Promise.all(sources.flatMap((source) => source.projects.map(async (project) => {
      try {
        const doc = await loadTaskDoc(source, project);
        return (doc.items?.Active ?? []).filter((item) => !item.checked).map((item) => ({
          source, project, item, key: `${taskSourceKey(source)}:${project}:${item.stableId ?? item.id}`,
        }));
      } catch { return []; }
    })));
    if (!visible || mine !== generation) return;
    entries = groups.flat();
    render();
  }
  return {
    render,
    show() {
      visible = true;
      onlineKey = (state.merged?.computers ?? []).filter((c) => c.state === "online").map((c) => c.computer).sort().join("\n");
      void refresh();
      timer = setInterval(() => { void refresh(); }, TASK_FRESH_MS);
    },
    hide() { visible = false; generation++; clearInterval(timer); timer = null; },
  };
}

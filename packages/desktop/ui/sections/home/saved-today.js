import { el } from "../../dom.js";
import { hookGet } from "../../api.js";
import { loadTaskSources, loadTaskDoc, TASK_FRESH_MS } from "../../shell/task-cache.js";
import { showSection } from "../../shell/sections.js";
import { savedToday, savedAgo, SAVED_TODAY_ROWS } from "../../shell/saved-today.js";

// One memory read per computer and project, shared and kept for a minute, four at a time.
const FINDINGS_PARALLEL = 4;
const reads = new Map();
function loadFindings(computer, project) {
  const key = JSON.stringify([computer, project]);
  const cached = reads.get(key);
  if (cached && (cached.pending || Date.now() - cached.at < TASK_FRESH_MS)) return cached.promise;
  const entry = { at: Date.now(), pending: true };
  entry.promise = hookGet(computer, `/v1/projects/${encodeURIComponent(project)}/memory`).then((body) => {
    entry.pending = false;
    return Array.isArray(body?.findings) ? body.findings : [];
  }, (error) => { if (reads.get(key) === entry) reads.delete(key); throw error; });
  reads.set(key, entry);
  return entry.promise;
}

async function inBatches(jobs, run) {
  const out = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(FINDINGS_PARALLEL, jobs.length) }, async () => {
    while (next < jobs.length) out.push(...await run(jobs[next++]));
  }));
  return out;
}

export function openSaved(entry) {
  if (entry.kind === "task") {
    showSection("tasks")?.openTask?.({ computer: entry.computer, storeId: entry.storeId, project: entry.project, id: entry.id });
  } else {
    showSection("memory")?.open?.({ computer: entry.computer, project: entry.project, segment: "findings", search: entry.text.slice(0, 40).trim() });
  }
}

export function createSavedToday({ block, state }) {
  const scope = block("saved-today");
  const list = scope.querySelector(".home-list");
  const more = el("button", "home-more");
  more.type = "button";
  more.addEventListener("click", () => { expanded = !expanded; render(); });
  scope.append(more);
  let entries = [];
  let rows = new Map();
  let expanded = false;
  let timer = null;
  let visible = false;
  let generation = 0;
  let onlineKey = "";

  function render() {
    const online = new Set((state.merged?.computers ?? []).filter((c) => c.state === "online").map((c) => c.computer));
    const key = [...online].sort().join("\n");
    if (visible && key !== onlineKey) { onlineKey = key; void refresh(); }
    const now = Date.now();
    const sorted = savedToday(entries.filter((e) => online.has(e.computer)), now);
    scope.hidden = !sorted.length;
    scope.querySelector(".count").textContent = String(sorted.length);
    const shown = expanded ? sorted : sorted.slice(0, SAVED_TODAY_ROWS);
    more.hidden = sorted.length <= SAVED_TODAY_ROWS;
    more.textContent = expanded ? "Show fewer" : `Show all ${sorted.length}`;
    const next = new Map();
    const active = document.activeElement;
    let focused;
    const nodes = shown.map((entry) => {
      let row = rows.get(entry.key);
      if (!row) {
        const node = el("button", "home-row home-saved-row");
        node.type = "button";
        const main = el("div", "home-row-main");
        const title = el("span", "home-row-title");
        const meta = el("span", "home-row-meta");
        const kind = el("span", "home-saved-kind");
        const project = el("span", "home-upnext-label");
        const computer = el("span", "home-upnext-label");
        const when = el("span", "home-age");
        meta.append(kind, project, computer, when);
        main.append(title, meta);
        node.append(main);
        row = { node, title, kind, project, computer, when, entry };
        node.addEventListener("click", () => openSaved(row.entry));
      }
      row.entry = entry;
      row.title.textContent = row.title.title = entry.text;
      row.kind.textContent = entry.kind;
      row.project.textContent = row.project.title = entry.project;
      row.computer.textContent = row.computer.title = entry.computer;
      row.when.textContent = savedAgo(entry.at, now);
      if (row.node === active) focused = row.node;
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
    const tasks = (await Promise.all(sources.flatMap((source) => source.projects.map(async (project) => {
      try {
        const doc = await loadTaskDoc(source, project);
        return [...(doc.items?.Active ?? []), ...(doc.items?.Queue ?? [])].filter((item) => !item.checked && item.createdAt).map((item) => {
          const id = item.stableId ?? item.id;
          return { kind: "task", key: `task:${source.computer}:${source.id}:${project}:${id}`, text: String(item.line ?? ""), created: item.createdAt, computer: source.computer, storeId: source.id, project, id };
        });
      } catch { return []; }
    })))).flat();
    const jobs = [...new Map(sources.flatMap((s) => s.projects.map((project) => [JSON.stringify([s.computer, project]), { computer: s.computer, project }]))).values()];
    const findings = await inBatches(jobs, async ({ computer, project }) => {
      try {
        return (await loadFindings(computer, project)).filter((f) => f.created).map((f) => ({
          kind: "finding", key: `finding:${computer}:${project}:${f.id}`, text: String(f.text ?? "").replace(/\s+/g, " ").trim(), created: f.created, computer, project, id: f.id,
        }));
      } catch { return []; }
    });
    if (!visible || mine !== generation) return;
    entries = [...tasks, ...findings];
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

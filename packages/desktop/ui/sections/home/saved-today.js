import { el } from "../../dom.js";
import { hookGet } from "../../api.js";
import { loadTaskSources, loadTaskDoc, TASK_FRESH_MS } from "../../shell/task-cache.js";
import { showSection } from "../../shell/sections.js";
import { savedToday, dayBounds, SAVED_TODAY_ROWS } from "../../shell/saved-today.js";
import { savedAgo } from "../../time.js";

// Findings are read once per computer and project and kept five minutes. Each read parses FINDINGS.md and
// checks citation freshness on the Hook, so they are fetched only when Home is shown (or a computer first
// comes online), never on a timer.
const FINDINGS_TTL_MS = 5 * 60_000;
const PER_COMPUTER = 2;
const ONLINE_DEBOUNCE_MS = 1500;
const WINDOW_DAYS = 3;
const reads = new Map();
const readKey = (computer, project) => JSON.stringify([computer, project]);

/** Keep only findings recent enough to be "today" in any zone; the card filters them by the live day. */
function recent(findings) {
  const floor = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  return findings.filter((f) => f && f.id && typeof f.created === "string" && f.created >= floor)
    .map((f) => ({ id: String(f.id), text: String(f.text ?? "").replace(/\s+/g, " ").trim(), created: f.created }));
}

export function loadFindings(computer, project, { fetchStale }) {
  const key = readKey(computer, project);
  const cached = reads.get(key);
  if (cached?.pending) return cached.promise;
  if (cached && (!fetchStale || Date.now() - cached.at < FINDINGS_TTL_MS)) return Promise.resolve(cached.value);
  const entry = { at: Date.now(), pending: true, value: cached?.value ?? [] };
  entry.promise = hookGet(computer, `/v1/projects/${encodeURIComponent(project)}/memory`).then((body) => {
    entry.pending = false;
    entry.at = Date.now();
    entry.value = recent(Array.isArray(body?.findings) ? body.findings : []);
    return entry.value;
  }, (error) => {
    if (reads.get(key) === entry) { if (cached) reads.set(key, cached); else reads.delete(key); }
    throw error;
  });
  reads.set(key, entry);
  return entry.promise;
}

/** Run `run` over the jobs with at most `limit` in flight; `alive()` false stops starting new ones. */
async function pool(jobs, limit, alive, run) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (alive() && next < jobs.length) await run(jobs[next++]);
  }));
}

const rankOf = (computer) => (computer === "This computer" ? 0 : 1);
const PRIORITY = { tick: 0, online: 1, show: 2 };

/** What Memory's own filter matches: comments and the leading [type] tag removed, whitespace collapsed. */
export function memorySearchFor(text) {
  return String(text ?? "").replace(/<!--[\s\S]*?-->/g, " ").replace(/^\s*\[[A-Za-z][A-Za-z0-9_-]*\]\s*/, "").replace(/\s+/g, " ").trim().slice(0, 40).trim();
}

export function openSaved(entry) {
  if (entry.kind === "task") {
    showSection("tasks")?.openTask?.({ computer: entry.computer, storeId: entry.storeId, project: entry.project, id: entry.id });
  } else {
    // Memory targets a finding by project and text filter, not by id.
    showSection("memory")?.open?.({ computer: entry.computer, project: entry.project, segment: "findings", search: memorySearchFor(entry.text) });
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
  let failed = false;
  let rows = new Map();
  let expanded = false;
  let tick = null;
  let midnight = null;
  let debounce = null;
  let visible = false;
  let generation = 0;
  let running = false;
  let queued = null;
  let onlineKey = "";

  const onlineKeyNow = () => (state.merged?.computers ?? []).filter((c) => c.state === "online").map((c) => c.computer).sort().join("\n");

  function render() {
    const online = new Set((state.merged?.computers ?? []).filter((c) => c.state === "online").map((c) => c.computer));
    const key = [...online].sort().join("\n");
    if (visible && key !== onlineKey) {
      onlineKey = key;
      clearTimeout(debounce);
      debounce = setTimeout(() => { void refresh("online"); }, ONLINE_DEBOUNCE_MS);
    }
    const now = Date.now();
    const sorted = savedToday(entries.filter((e) => online.has(e.computer)), now);
    if (!sorted.length && failed) {
      scope.hidden = false;
      scope.querySelector(".count").textContent = "";
      more.hidden = true;
      rows = new Map();
      list.replaceChildren(el("div", "home-empty", "Couldn't read what was saved today."));
      return;
    }
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

  // mode "show" fetches missing and stale findings, "online" only missing ones (a computer just came
  // online), "tick" none: tasks come from the shared task cache, findings from what is already read.
  // One burst runs at a time; a request that arrives meanwhile runs once after it.
  async function refresh(mode) {
    if (running) { if (queued === null || PRIORITY[mode] > PRIORITY[queued]) queued = mode; return; }
    running = true;
    const mine = ++generation;
    const alive = () => visible && mine === generation;
    let attempts = 0;
    let ok = 0;
    try {
      const sources = await loadTaskSources(state.merged?.computers ?? []);
      const tasks = (await Promise.all(sources.flatMap((source) => source.projects.map(async (project) => {
        attempts++;
        try {
          const doc = await loadTaskDoc(source, project);
          ok++;
          return [...(doc.items?.Active ?? []), ...(doc.items?.Queue ?? [])].filter((item) => !item.checked && item.createdAt).map((item) => {
            const id = item.stableId ?? item.id;
            return {
              kind: "task", key: `task:${source.computer}:${source.id}:${project}:${id}`, dedupe: `task|${source.id}|${project}|${id}`, rank: rankOf(source.computer),
              text: String(item.line ?? ""), created: item.createdAt, computer: source.computer, storeId: source.id, project, id,
            };
          });
        } catch { return []; }
      })))).flat();
      // One read per store and project: a store synced to several computers is read from the preferred one.
      const jobs = new Map();
      for (const source of sources) {
        for (const project of source.projects) {
          const key = JSON.stringify([source.id, project]);
          const kept = jobs.get(key);
          if (!kept || rankOf(source.computer) < rankOf(kept.computer)) jobs.set(key, { computer: source.computer, storeId: source.id, project });
        }
      }
      const byComputer = new Map();
      for (const job of jobs.values()) byComputer.set(job.computer, [...(byComputer.get(job.computer) ?? []), job]);
      const findings = [];
      await Promise.all([...byComputer.values()].map((group) => pool(group, PER_COMPUTER, alive, async ({ computer, storeId, project }) => {
        const known = reads.get(readKey(computer, project));
        if (mode === "tick" && !known) return;
        attempts++;
        try {
          const read = mode === "tick" ? known.value : await loadFindings(computer, project, { fetchStale: mode === "show" });
          ok++;
          for (const f of read) {
            findings.push({
              kind: "finding", key: `finding:${computer}:${project}:${f.id}`, dedupe: `finding|${storeId}|${project}|${f.id}`, rank: rankOf(computer),
              text: f.text, created: f.created, computer, storeId, project, id: f.id,
            });
          }
        } catch { /* counted by attempts */ }
      })));
      if (alive()) {
        entries = [...tasks, ...findings];
        failed = attempts > 0 && ok === 0;
        render();
      }
    } finally {
      running = false;
      const again = queued;
      queued = null;
      if (again && visible) void refresh(again);
    }
  }

  function scheduleMidnight() {
    clearTimeout(midnight);
    const [, end] = dayBounds(Date.now());
    midnight = setTimeout(() => { render(); scheduleMidnight(); }, Math.max(1000, end - Date.now() + 1000));
  }

  return {
    render,
    show() {
      visible = true;
      onlineKey = onlineKeyNow();
      void refresh("show");
      tick = setInterval(() => { void refresh("tick"); }, TASK_FRESH_MS);
      scheduleMidnight();
    },
    hide() {
      visible = false;
      generation++;
      clearInterval(tick);
      clearTimeout(midnight);
      clearTimeout(debounce);
      tick = midnight = debounce = null;
    },
  };
}

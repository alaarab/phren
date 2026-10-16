import { el } from "../dom.js";
// ⌘K command palette: one ranked list across sessions (every computer), the
// open pull requests the CI watch last saw, the projects on every computer, the
// active session's repository files, registered commands and top-level
// sections, operated entirely by keyboard; `?` searches the opened project's
// memory, or every project without a scope; `??` always searches everywhere.
// Opened by the `palette` action in keys.js. Plain DOM
// only, never innerHTML with data.

import { hookGet, hookPost, targetQuery } from "../api.js";
import { sectionHandle, sectionIds, sectionLabel, showSection } from "./sections.js";
import { projectOf, store } from "./store.js";
import { checksStrip, lastChecks } from "./ci-watch.js";
import { checksWord } from "../git-review.js";
import { blend, clearRecent, readRecent, recentRows, recordPick, weights } from "./palette-recent.js";

// ------------------------------------------------------------ commands
const commands = new Map(); // id -> { id, title, keys?, run, group?, meta?, when? }

/** Register a command for the palette. Returns an unregister function.
 * `when()` hides it while false; `meta` may be a function, read on open. */
export function registerCommand(cmd) {
  if (!cmd || !cmd.id || typeof cmd.run !== "function") throw new Error("registerCommand needs { id, run }");
  commands.set(cmd.id, cmd);
  return () => commands.delete(cmd.id);
}

const PROVIDER = { claude: "C", codex: "X", opencode: "O", copilot: "G", phren: "P" };
const GROUP_ORDER = { Recent: -1, Sessions: 0, "Pull requests": 1, Projects: 2, "Go to": 3, Commands: 4, Files: 5 };
const CHECK_ICON = { failing: "✕", pending: "●", passing: "✓" };
const MAX_ROWS = 200;
const MEMORY_LIMIT = 20;
const MEMORY_DEBOUNCE_MS = 250;

/** What the typed text asks for: `>` commands only, `?` the project's memory. */
export function paletteMode(raw) {
  const text = raw ?? "";
  if (text.startsWith(">")) return { mode: "commands", query: text.slice(1).trim() };
  if (text.startsWith("??")) return { mode: "memory", query: text.slice(2).trim(), everywhere: true };
  if (text.startsWith("?")) return { mode: "memory", query: text.slice(1).trim() };
  return { mode: "all", query: text.trim() };
}

// ------------------------------------------------------------ matching
/** Subsequence match with bonuses for consecutive runs and word starts.
 * Returns -1 when the query is not a subsequence of the text. */
export function fuzzyScore(query, text) {
  const q = query.toLowerCase();
  const t = (text || "").toLowerCase();
  if (!q) return 0;
  let ti = 0, score = 0, prev = -2;
  for (let i = 0; i < q.length; i++) {
    let at = -1;
    for (; ti < t.length; ti++) { if (t[ti] === q[i]) { at = ti; break; } }
    if (at < 0) return -1;
    if (at === prev + 1) score += 9;
    if (at === 0 || /[\s/\\_.-]/.test(t[at - 1])) score += 7;
    score -= at * 0.15;
    prev = at; ti++;
  }
  // A match never scores below 1, so -1 means "no match" without ambiguity.
  return Math.max(1, score - (t.length - q.length) * 0.01);
}

function bestScore(query, item) {
  if (!query) return 0;
  let best = Math.max(fuzzyScore(query, item.title), fuzzyScore(query, item.meta || ""));
  if (item.path) best = Math.max(best, fuzzyScore(query, item.path));
  return best;
}

function kindOf(child) {
  const s = child.agentStatus;
  if (s === "blocked" || s === "waiting" || child.approvalPending === true) return "needs";
  if (s === "working") return "working";
  return "idle";
}

// ------------------------------------------------------------ sources
function sessionItems() {
  return store.sessions({ includeOffline: true }).map((row) => {
    const { computer, child } = row;
    const kind = kindOf(child);
    const project = projectOf(child);
    return {
      id: `session:${row.key}`,
      group: "Sessions",
      kind,
      boost: kind === "needs" ? 1000 : kind === "working" ? 500 : 0,
      icon: PROVIDER[child.target?.source] || "?",
      title: child.title || child.label || project || "Session",
      meta: [project, computer].filter(Boolean).join(" · "),
      run() {
        showSection("agents");
        sectionHandle("agents")?.openSession(computer, child);
      },
    };
  });
}

/** Palette rows for the open requests the CI watch last saw (failing first);
 * Enter opens the session's Changes › PRs. No Hook call of its own. */
export function pullItems(pulls, openPulls) {
  return checksStrip(pulls ?? []).map((pull) => ({
    id: `pull:${pull.computer}:${pull.project}:${pull.number}`,
    group: "Pull requests",
    kind: pull.checks === "failing" ? "needs" : "idle",
    boost: pull.checks === "failing" ? 400 : 0,
    icon: CHECK_ICON[pull.checks] ?? "#",
    title: `${pull.ref}${pull.number} ${pull.title}`,
    meta: [checksWord(pull.checks) || "No checks", pull.project, pull.computer].filter(Boolean).join(" · "),
    run() { openPulls(pull.computer, store.find(pull.computer, pull.child.id)?.child ?? pull.child); },
  }));
}

/** Palette rows for the projects the Projects section has loaded; Enter opens
 * that project's page (its Code block, tasks and memory). */
export function projectItems(projects, openProject) {
  return (projects ?? []).map((p) => ({
    id: `project:${p.computer}:${p.name}`,
    group: "Projects",
    kind: "idle",
    icon: "▣",
    title: p.name,
    meta: `Project · ${p.computer}`,
    run() { openProject(p); },
  }));
}

function openProjectPage(project) {
  showSection("projects");
  sectionHandle("projects")?.open?.(project);
}

function openPullsTab(computer, child) {
  showSection("agents");
  sectionHandle("agents")?.openPulls(computer, child);
}

registerCommand({
  id: "palette.clear-recent",
  title: "Clear recent",
  meta: "Forget what the palette remembers you using",
  when: () => (opened ? picksNow() : readRecent()).length > 0,
  run: () => clearRecent(),
});

function sectionItems() {
  return sectionIds().map((id) => ({
    id: `section:${id}`,
    group: "Go to",
    kind: "idle",
    icon: "→",
    title: `Go to ${sectionLabel(id)}`,
    meta: "Section",
    run() { showSection(id); },
  }));
}

function commandItems() {
  return [...commands.values()].filter((cmd) => !cmd.when || cmd.when()).map((cmd) => ({
    id: `command:${cmd.id}`,
    group: cmd.group || "Commands",
    kind: "idle",
    icon: "⌘",
    title: cmd.title,
    meta: (typeof cmd.meta === "function" ? cmd.meta() : cmd.meta) || "",
    shortcut: cmd.keys || "",
    run: () => cmd.run(),
  }));
}

function fileItems(files) {
  return files.map((path) => {
    const cut = path.lastIndexOf("/");
    return {
      id: `file:${path}`,
      group: "Files",
      kind: "idle",
      icon: "▤",
      title: cut < 0 ? path : path.slice(cut + 1),
      meta: cut < 0 ? "" : path.slice(0, cut),
      path,
      run() { openFileInPane(path); },
    };
  });
}

// ------------------------------------------------------------ memory
/** Palette rows for `/memory/search` results, in the Hook's ranked order. */
export function memoryItems(results, { computer, project }) {
  return (results ?? []).map((hit, i) => {
    const truth = hit.kind === "truth";
    const type = hit.finding?.type;
    return {
      id: `memory:${computer}:${project}:${hit.finding?.id ?? `${hit.kind}:${i}`}`,
      group: "Memory",
      kind: "idle",
      wrap: true,
      icon: truth ? "★" : "◆",
      title: hit.text,
      meta: [project, computer, truth ? "truth" : type || "finding", `${Math.round((hit.score ?? 0) * 100)}%`].join(" · "),
      run() {
        showSection("memory");
        sectionHandle("memory")?.open?.({ computer, project, segment: truth ? "truths" : "findings", search: truth ? "" : hit.text.slice(0, 80) });
      },
    };
  });
}

/** The row under `?` results that asks the typed question in a quick chat on
 * that project (phren's agent with no tools, answering from its memory). */
export function askItem(query, scope, openChat) {
  if (!query || !scope) return null;
  return {
    id: "ask-quick-chat",
    group: "Ask",
    kind: "idle",
    icon: "✦",
    title: `Ask in a quick chat: ${query}`,
    meta: `${scope.project} · ${scope.computer}`,
    run() { openChat({ chat: true, project: scope.project, computer: scope.computer, prompt: query, title: `Quick chat about ${scope.project}` }); },
  };
}

// launch.js registers its commands here at load, so it is imported only when used.
const openQuickChat = (options) => { void import("./launch.js").then((m) => m.openLaunchSheet(options)); };

// Each query owns its timer, controller and answer; late answers cannot repaint.
let memory = { key: "", state: "idle", items: [], timer: null, controller: null };
let openedScope = null;
// Shared across superseded queries; the daemon also holds four SSH slots until
// hookRequest confirms completion/abort, since fetch can reject sooner.
const memoryReads = new Set();

function memoryScope() { return openedScope; }

function cancelMemory() {
  clearTimeout(memory.timer);
  memory.controller?.abort();
  memory = { key: "", state: "idle", items: [], timer: null, controller: null };
}

function memoryProjects(everywhere) {
  const scope = memoryScope();
  if (scope && !everywhere) return [{ ...scope, name: scope.project }];
  const online = new Set((store.merged?.computers ?? []).filter((c) => c.state === "online").map((c) => c.computer));
  const projects = sectionHandle("projects")?.projects?.() ?? [];
  return projects.filter((p) => online.has(p.computer))
    .sort((a, b) => (Date.parse(b.lastSeen) || 0) - (Date.parse(a.lastSeen) || 0));
}

function askMemory(sources, query, everywhere) {
  const projects = memoryProjects(everywhere);
  const targets = projects.slice(0, 12);
  const key = query ? JSON.stringify([query, everywhere, targets.map((p) => [p.computer, p.name]), projects.length]) : "";
  if (key === memory.key) return;
  cancelMemory();
  if (!key) return;
  const request = memory = { key, state: "loading", items: [], timer: null, controller: new AbortController(), total: projects.length, searched: 0 };
  request.timer = setTimeout(async () => {
    const hits = [];
    let cursor = 0, failures = 0;
    async function worker() {
      while (!request.controller.signal.aborted && cursor < targets.length) {
        const p = targets[cursor++];
        const scope = { computer: p.computer, project: p.name };
        try {
          while (memoryReads.size >= 4) {
            await Promise.race([...memoryReads].map((read) => read.catch(() => {})));
          }
          if (request.controller.signal.aborted) return;
          const read = hookGet(p.computer, `/v1/projects/${encodeURIComponent(p.name)}/memory/search`, { q: query, limit: String(MEMORY_LIMIT) }, { signal: request.controller.signal });
          memoryReads.add(read);
          let body;
          try { body = await read; }
          finally { memoryReads.delete(read); }
          hits.push(...memoryItems(body.results, scope).map((item, i) => ({ item, matched: body.results[i].matched ?? 0, score: body.results[i].score ?? 0, recency: Date.parse(p.lastSeen) || 0 })));
          request.searched++;
        } catch { failures++; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker));
    if (request.controller.signal.aborted || memory !== request || !overlayEl) return;
    hits.sort((a, b) => b.matched - a.matched || b.score - a.score || b.recency - a.recency || a.item.id.localeCompare(b.item.id));
    request.items = hits.slice(0, MEMORY_LIMIT).map((hit) => hit.item);
    request.state = failures === targets.length && failures ? "error" : "done";
    request.error = failures ? `${failures} project searches failed.` : "";
    render(sources);
  }, MEMORY_DEBOUNCE_MS);
}

function memoryNote(query, everywhere) {
  const scope = everywhere ? null : memoryScope();
  const where = scope?.project || "all projects";
  if (!query) return `Ask what Phren remembers about ${where}.`;
  if (memory.state === "loading") return `Searching ${where}…`;
  if (memory.state === "error") return memory.error;
  return `Phren has nothing on that in ${where}.`;
}

// ------------------------------------------------------------ file list
const fileCache = new Map(); // "computer/child" -> { at, files }
const FILE_TTL = 60_000;

function activeSession() {
  return sectionHandle("agents")?.currentSession?.() ?? null;
}

/** A query names a file when it looks like a path, so a bare word stays quiet. */
function isPathLike(query) {
  return query.length > 0 && (/[/\\._-]/.test(query) || query.length >= 3);
}

async function loadFiles(session) {
  const key = `${session.computer}/${session.child.id}`;
  const hit = fileCache.get(key);
  if (hit && Date.now() - hit.at < FILE_TTL) return hit.files;
  const target = session.child.target;
  let files = [];
  try {
    files = (await hookGet(session.computer, `/v1/files/list?${targetQuery(target)}`)).files || [];
  } catch {
    try { files = (await hookPost(session.computer, "/v1/files/list", { target })).files || []; }
    catch { files = []; }
  }
  fileCache.set(key, { at: Date.now(), files });
  return files;
}

/** The Files pane owns openFile but does not expose it; drive its quick open
 * the same way keys.js openQuickFile reaches it. */
function openFileInPane(path) {
  sectionHandle("agents")?.showPane("files");
  const pane = document.querySelector(".bench-files");
  const quick = pane?.querySelector(".ed-quick");
  const input = pane?.querySelector(".ed-quick-input");
  if (!quick || !input) return;
  pane.querySelector(".ed-qp")?.click();
  input.value = path;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  // The quick open fills its list asynchronously; retry Enter until it opens.
  let tries = 0;
  const timer = setInterval(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    if (!quick.classList.contains("open") || ++tries > 20) clearInterval(timer);
  }, 40);
}

// ------------------------------------------------------------ overlay
let returnFocus = null;
let overlayEl = null;
let inputEl = null;
let listEl = null;
let items = []; // the ranked items currently shown
let rowEls = []; // one row node per item, same order
let keyedRows = new Map();
let selected = 0;
let lastQuery = "";
let filePool = [];
let opened = false;
let picksCache = null; // readRecent() once per open
function picksNow() { return (picksCache ??= readRecent(Date.now())); }

export function isPaletteOpen() { return !!overlayEl; }

/** Open the palette. `sources` adds custom sources: { label, items() -> items }.
 * Each item is { id, title, meta?, icon?, kind?, shortcut?, run() }. */
export function openPalette({ sources = [] } = {}) {
  closePalette();
  opened = true;
  picksCache = null;
  returnFocus = document.activeElement;
  filePool = [];
  const session = activeSession();
  const project = session?.child ? projectOf(session.child) : "";
  openedScope = project ? { computer: session.computer, project } : null;

  const backdrop = el("div", "palette-backdrop");
  backdrop.addEventListener("mousedown", (ev) => { if (ev.target === backdrop) closePalette(); });

  const card = el("div", "palette");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", "Command palette");

  inputEl = document.createElement("input");
  inputEl.className = "palette-input";
  inputEl.placeholder = "Go to a session, file, command or section";
  inputEl.setAttribute("autocomplete", "off");
  inputEl.setAttribute("spellcheck", "false");

  listEl = el("div", "palette-list");
  listEl.setAttribute("role", "listbox");

  const foot = el("div", "palette-foot");
  foot.append(el("span", "", "↑↓ move"), el("span", "", "↵ open"), el("span", "", "esc close"), el("span", "", "> commands"), el("span", "", "? memory · ?? all projects"));

  card.append(inputEl, listEl, foot);
  backdrop.append(card);
  document.body.append(backdrop);
  overlayEl = backdrop;

  inputEl.addEventListener("input", () => { selected = 0; render(sources); });
  inputEl.addEventListener("keydown", onPaletteKey);
  listEl.addEventListener("mousemove", (ev) => {
    const row = ev.target instanceof Element ? ev.target.closest(".palette-row") : null;
    const at = row ? rowEls.indexOf(row) : -1;
    if (at >= 0 && at !== selected) { selected = at; paintSelection(); }
  });

  render(sources);
  inputEl.focus();

  // Projects come from the Projects section; the first open loads them, then the list fills in.
  const projects = sectionHandle("projects");
  if (projects?.load) void projects.load().then(() => { if (overlayEl) render(sources); });

  if (session?.child?.target) {
    loadFiles(session).then((files) => {
      if (overlayEl && session === activeSession()) { filePool = files; render(sources); }
    });
  }
}

export function closePalette() {
  overlayEl?.remove();
  if (returnFocus?.isConnected) returnFocus.focus();
  returnFocus = null;
  opened = false; picksCache = null;
  overlayEl = null; inputEl = null; listEl = null;
  items = []; rowEls = []; keyedRows.clear(); selected = 0; lastQuery = ""; filePool = [];
  cancelMemory();
  openedScope = null;
}

function collect(sources, query, commandsOnly) {
  const all = [];
  if (!commandsOnly) {
    all.push(...sessionItems(), ...pullItems(lastChecks(), openPullsTab));
    all.push(...projectItems(sectionHandle("projects")?.projects?.() ?? [], openProjectPage), ...sectionItems());
  }
  all.push(...commandItems());
  for (const src of sources) {
    if (!src || typeof src.items !== "function") continue;
    for (const it of src.items() || []) all.push({ group: src.label || "More", kind: "idle", icon: "›", ...it });
  }
  if (!commandsOnly && isPathLike(query) && filePool.length) all.push(...fileItems(filePool));
  return all;
}

function render(sources) {
  const { mode, query, everywhere } = paletteMode(inputEl?.value);
  const commandsOnly = mode === "commands";
  lastQuery = query;
  if (mode === "memory") {
    askMemory(sources, query, everywhere);
    const ask = memory.state === "loading" ? null : askItem(query, everywhere ? null : memoryScope(), openQuickChat);
    items = ask ? [...memory.items, ask] : memory.items;
    if (selected >= items.length) selected = Math.max(0, items.length - 1);
    paint(memoryNote(query, everywhere));
    return;
  }

  if (memory.key) cancelMemory();
  const scored = [];
  const now = Date.now();
  const picks = picksNow();
  const heat = weights(picks, now);
  const pool = collect(sources, query, commandsOnly);
  for (const item of pool) {
    const score = bestScore(query, item);
    if (score < 0) continue;
    scored.push({ item, score: query ? blend(score, item.id, heat) : score + (item.boost || 0) });
  }
  scored.sort((a, b) =>
    b.score - a.score
    || (GROUP_ORDER[a.item.group] ?? 9) - (GROUP_ORDER[b.item.group] ?? 9)
    || a.item.title.localeCompare(b.item.title));
  items = scored.slice(0, MAX_ROWS).map((s) => s.item);
  if (!query && !commandsOnly) {
    // Recent: copies under their own row ids; picking one still counts for the original.
    // Rows that already lead (needs you, failing PRs: boost > 0) stay first and out of Recent;
    // an item shown in Recent is not listed again below.
    const byId = new Map(pool.filter((it) => !(it.boost > 0)).map((it) => [it.id, it]));
    const recent = recentRows(picks, byId, now).map((it) => ({ ...it, id: `recent:${it.id}`, pickId: it.id, group: "Recent" }));
    const shown = new Set(recent.map((it) => it.pickId));
    const leading = items.filter((it) => it.boost > 0);
    items = [...leading, ...recent, ...items.filter((it) => !(it.boost > 0) && !shown.has(it.id))];
  }
  if (selected >= items.length) selected = Math.max(0, items.length - 1);
  paint();
}

function paint(emptyText = "No matches.") {
  if (!listEl) return;
  rowEls = [];
  const nodes = [];
  const nextRows = new Map();
  let group = null;
  items.forEach((item, i) => {
    if (item.group !== group) { group = item.group; nodes.push(el("div", "palette-group", group)); }
    const signature = JSON.stringify([item.title, item.meta, item.kind, item.icon, item.wrap, item.shortcut, lastQuery]);
    const prior = keyedRows.get(item.id);
    const row = prior?.signature === signature ? prior.row : el("div", `palette-row${item.wrap ? " wrap" : ""}`);
    row.classList.toggle("on", i === selected);
    if (row !== prior?.row) {
      row.setAttribute("role", "option");
      row.append(el("span", `palette-icon ${item.kind || "idle"}`, item.icon || ""));
      row.append(highlight("palette-title", item.title, lastQuery));
      const meta = el("span", "palette-meta");
      if (item.kind === "needs" || item.kind === "working") meta.append(el("span", `palette-dot ${item.kind}`));
      if (item.meta) meta.append(el("span", "", item.meta));
      if (meta.childNodes.length) row.append(meta);
      if (item.shortcut) row.append(el("span", "palette-shortcut", item.shortcut));
      row.addEventListener("click", () => activate(items.findIndex((candidate) => candidate.id === item.id)));
    }
    nextRows.set(item.id, { row, signature });
    rowEls.push(row);
    nodes.push(row);
  });
  if (!items.length) nodes.push(el("div", "palette-empty", emptyText));
  if (memory.total > 12 && memory.state !== "loading") nodes.push(el("div", "palette-empty", `Searched ${memory.searched} of ${memory.total} projects`));
  if (memory.error && items.length) nodes.push(el("div", "palette-empty", memory.error));
  keyedRows = nextRows;
  listEl.replaceChildren(...nodes);
}

function onPaletteKey(ev) {
  if (ev.key === "ArrowDown") { ev.preventDefault(); ev.stopPropagation(); move(1); }
  else if (ev.key === "ArrowUp") { ev.preventDefault(); ev.stopPropagation(); move(-1); }
  else if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); activate(selected); }
  else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closePalette(); }
}

function paintSelection() {
  rowEls.forEach((row, i) => row.classList.toggle("on", i === selected));
}

function move(delta) {
  if (!items.length) return;
  selected = (selected + delta + items.length) % items.length;
  paintSelection();
  rowEls[selected]?.scrollIntoView({ block: "nearest" });
}

function activate(i) {
  const item = items[i];
  if (!item) return;
  closePalette();
  recordPick(item.pickId ?? item.id);
  try { item.run(); } catch (err) { console.error(err); }
}

function highlight(className, text, query) {
  const node = el("div", className);
  node.textContent = text;
  const words = (query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return node;
  const lower = text.toLowerCase();
  const ranges = [];
  for (const w of words) {
    let at = lower.indexOf(w);
    while (at !== -1) { ranges.push([at, at + w.length]); at = lower.indexOf(w, at + w.length); }
  }
  if (!ranges.length) return node;
  ranges.sort((a, b) => a[0] - b[0]);
  const frag = document.createDocumentFragment();
  let cur = 0;
  for (const [start, end] of ranges) {
    if (start < cur) continue;
    if (start > cur) frag.append(document.createTextNode(text.slice(cur, start)));
    frag.append(el("mark", "", text.slice(start, end)));
    cur = end;
  }
  if (cur < text.length) frag.append(document.createTextNode(text.slice(cur)));
  node.replaceChildren(frag);
  return node;
}

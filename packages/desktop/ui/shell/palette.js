// ⌘K command palette: one ranked list across sessions (every computer), the
// active session's repository files, registered commands and top-level
// sections, operated entirely by keyboard. Opened by the `palette` action in
// keys.js. Plain DOM only, never innerHTML with data.

import { hookGet, hookPost, targetQuery } from "../api.js";
import { sectionHandle, sectionIds, showSection } from "./sections.js";
import { projectOf, store } from "./store.js";

// ------------------------------------------------------------ commands
const commands = new Map(); // id -> { id, title, keys?, run, group?, meta? }

/** Register a command for the palette. Returns an unregister function. */
export function registerCommand(cmd) {
  if (!cmd || !cmd.id || typeof cmd.run !== "function") throw new Error("registerCommand needs { id, run }");
  commands.set(cmd.id, cmd);
  return () => commands.delete(cmd.id);
}

const PROVIDER = { claude: "C", codex: "X", opencode: "O", copilot: "G", phren: "P" };
const GROUP_ORDER = { Sessions: 0, "Go to": 1, Commands: 2, Files: 3 };
const MAX_ROWS = 200;

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

function sectionLabel(id) {
  const pill = document.querySelector(`#section-pills .section-pill[data-section="${id}"]`);
  const text = pill && [...pill.childNodes].find((n) => n.nodeType === 3);
  return (text ? text.nodeValue : id).trim();
}

// ------------------------------------------------------------ sources
function sessionItems() {
  return store.sessions().map((row) => {
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
  return [...commands.values()].map((cmd) => ({
    id: `command:${cmd.id}`,
    group: cmd.group || "Commands",
    kind: "idle",
    icon: "⌘",
    title: cmd.title,
    meta: cmd.meta || "",
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
let overlayEl = null;
let inputEl = null;
let listEl = null;
let items = []; // the ranked items currently shown
let rowEls = []; // one row node per item, same order
let selected = 0;
let lastQuery = "";
let filePool = [];

export function isPaletteOpen() { return !!overlayEl; }

/** Open the palette. `sources` adds custom sources: { label, items() -> items }.
 * Each item is { id, title, meta?, icon?, kind?, shortcut?, run() }. */
export function openPalette({ sources = [] } = {}) {
  closePalette();
  filePool = [];
  const session = activeSession();

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
  foot.append(el("span", "", "↑↓ move"), el("span", "", "↵ open"), el("span", "", "esc close"), el("span", "", "> commands"));

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

  if (session?.child?.target) {
    loadFiles(session).then((files) => {
      if (overlayEl && session === activeSession()) { filePool = files; render(sources); }
    });
  }
}

export function closePalette() {
  overlayEl?.remove();
  overlayEl = null; inputEl = null; listEl = null;
  items = []; rowEls = []; selected = 0; lastQuery = ""; filePool = [];
}

function collect(sources, query, commandsOnly) {
  const all = [];
  if (!commandsOnly) all.push(...sessionItems(), ...sectionItems());
  all.push(...commandItems());
  for (const src of sources) {
    if (!src || typeof src.items !== "function") continue;
    for (const it of src.items() || []) all.push({ group: src.label || "More", kind: "idle", icon: "›", ...it });
  }
  if (!commandsOnly && isPathLike(query) && filePool.length) all.push(...fileItems(filePool));
  return all;
}

function render(sources) {
  const raw = inputEl?.value ?? "";
  const commandsOnly = raw.startsWith(">");
  const query = (commandsOnly ? raw.slice(1) : raw).trim();
  lastQuery = query;

  const scored = [];
  for (const item of collect(sources, query, commandsOnly)) {
    const score = bestScore(query, item);
    if (score < 0) continue;
    scored.push({ item, score: score + (query ? 0 : (item.boost || 0)) });
  }
  scored.sort((a, b) =>
    b.score - a.score
    || (GROUP_ORDER[a.item.group] ?? 9) - (GROUP_ORDER[b.item.group] ?? 9)
    || a.item.title.localeCompare(b.item.title));
  items = scored.slice(0, MAX_ROWS).map((s) => s.item);
  if (selected >= items.length) selected = Math.max(0, items.length - 1);
  paint();
}

function paint() {
  if (!listEl) return;
  rowEls = [];
  const nodes = [];
  let group = null;
  items.forEach((item, i) => {
    if (item.group !== group) { group = item.group; nodes.push(el("div", "palette-group", group)); }
    const row = el("div", `palette-row${i === selected ? " on" : ""}`);
    row.setAttribute("role", "option");
    row.append(el("span", `palette-icon ${item.kind || "idle"}`, item.icon || ""));
    row.append(highlight("palette-title", item.title, lastQuery));
    const meta = el("span", "palette-meta");
    if (item.kind === "needs" || item.kind === "working") meta.append(el("span", `palette-dot ${item.kind}`));
    if (item.meta) meta.append(el("span", "", item.meta));
    if (meta.childNodes.length) row.append(meta);
    if (item.shortcut) row.append(el("span", "palette-shortcut", item.shortcut));
    row.addEventListener("click", () => activate(i));
    rowEls.push(row);
    nodes.push(row);
  });
  if (!items.length) nodes.push(el("div", "palette-empty", "No matches."));
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

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Herdr-style keyboard shortcuts for Phren desktop. The daemon merges the
// defaults, the owner's Herdr [keys] and ~/.config/phren/desktop.toml into
// /api/keys; this module matches key presses against them. A terminal panel
// is a real Herdr or tmux client, so keys typed there are never intercepted.

import { hookPost } from "./api.js";
import { closePalette, isPaletteOpen, openPalette, registerCommand } from "./shell/palette.js";

let config = null; // { bindings, sources, files, errors, actions }
let app = null; // actions supplied by app.js
let prefixUntil = 0;
let hintEl = null;
const PREFIX_WINDOW_MS = 2500;

// ------------------------------------------------------------ key strings
const NAMED = { minus: "-", comma: ",", plus: "+", backtick: "`", ampersand: "&", space: " ", slash: "/", backslash: "\\" };
// Physical keys, for presses whose character a modifier changes (⌥H types "˙", ⇧\\ types "|").
const CODE_KEYS = { Minus: "-", Equal: "=", Backslash: "\\", Slash: "/", Comma: ",", Period: ".", Backquote: "`", BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'" };
function codeKey(ev) {
  const code = ev.code || "";
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return CODE_KEYS[code] ?? null;
}
const EVENT_NAMES = { arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right", escape: "esc", enter: "enter", tab: "tab", " ": " " };
const SYMBOLS = { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘", super: "⌘" };
// "cmd" in a binding means Command on macOS and Control everywhere else.
const IS_MAC = (typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent || navigator.platform || ""))
  || (typeof document !== "undefined" && document.documentElement.classList.contains("platform-darwin"));

/** "prefix+shift+t" → { prefix, ctrl, alt, shift, cmd, key, range? } */
export function parseBinding(text) {
  const parts = text.split("+");
  const spec = { prefix: false, ctrl: false, alt: false, shift: false, cmd: false, key: "" };
  // A trailing "+" means the plus key itself ("ctrl++").
  if (text.endsWith("++")) { parts.splice(parts.length - 2, 2, "+"); }
  for (const part of parts) {
    if (part === "prefix") spec.prefix = true;
    else if (part === "ctrl" || part === "alt" || part === "shift") spec[part] = true;
    else if (part === "cmd" || part === "super") spec.cmd = true;
    else spec.key = NAMED[part] ?? part;
  }
  const range = /^(\d)\.\.(\d)$/.exec(spec.key);
  if (range) spec.range = [Number(range[1]), Number(range[2])];
  return spec;
}

function eventKey(ev) {
  const raw = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key.toLowerCase();
  return EVENT_NAMES[raw] ?? raw;
}

/** Does this key press match the binding (ignoring the prefix part)? Returns
 * true, false, or the digit for a 1..9 range binding. */
export function matches(spec, ev) {
  if (spec.ctrl !== ev.ctrlKey || spec.alt !== ev.altKey || spec.cmd !== ev.metaKey) return false;
  const key = eventKey(ev);
  const letter = /^[a-z]$/.test(spec.key);
  // Letters and named keys care about shift; "?" or "&" already imply it.
  if ((letter || spec.key.length > 1) && spec.shift !== ev.shiftKey) return false;
  if (spec.range) {
    const n = Number(/^\d$/.test(key) ? key : codeKey(ev));
    return Number.isInteger(n) && n >= spec.range[0] && n <= spec.range[1] ? n : false;
  }
  if (key === spec.key) return true;
  // The character differs from the key's own (⌥ or ⇧ changed it): match the physical key, shift exactly.
  return codeKey(ev) === spec.key && spec.shift === ev.shiftKey;
}

/** How a binding reads on the shortcut sheet: "⌃B  ⇧T". */
function keycaps(binding) {
  return binding.split(/\s+/).map((text) => {
    const spec = parseBinding(text);
    const mods = ["ctrl", "alt", "shift", "cmd"].filter((m) => spec[m])
      .map((m) => (m === "cmd" && !IS_MAC ? SYMBOLS.ctrl : SYMBOLS[m])).join("");
    const key = spec.range ? `${spec.range[0]}…${spec.range[1]}` : (spec.key.length === 1 ? spec.key.toUpperCase() : spec.key);
    const own = mods + key;
    if (!spec.prefix) return own;
    const prefix = (config.bindings.prefix || ["ctrl+b"])[0];
    return `${keycaps(prefix)}  ${own}`;
  }).join(" ");
}

// ------------------------------------------------------------ dispatch
function inTerminal(target) {
  return target instanceof Element && !!target.closest(".xterm, .bench-terminal");
}
function typing(target) {
  return target instanceof Element && !!target.closest("input, textarea, [contenteditable='true'], .monaco-editor");
}

function findAction(ev, withPrefix) {
  for (const [action, list] of Object.entries(config.bindings)) {
    if (action === "prefix") continue;
    for (const text of list) {
      const spec = parseBinding(text);
      if (spec.prefix !== withPrefix) continue;
      const hit = matches(spec, ev);
      if (hit !== false) return { action, arg: typeof hit === "number" ? hit : undefined };
    }
  }
  return null;
}

/** Direct [keys.app] bindings: on macOS "cmd" is Command, elsewhere Control. */
function matchesApp(spec, ev) {
  const local = !IS_MAC && spec.cmd ? { ...spec, cmd: false, ctrl: true } : spec;
  return matches(local, ev);
}

function findAppAction(ev) {
  for (const [action, list] of Object.entries(config.appBindings || {})) {
    for (const text of list) {
      const hit = matchesApp(parseBinding(text), ev);
      if (hit !== false) return { action, arg: typeof hit === "number" ? hit : undefined };
    }
  }
  return null;
}

function showHint(on) {
  if (!hintEl) {
    hintEl = document.createElement("div");
    hintEl.className = "keys-hint";
    document.body.append(hintEl);
  }
  hintEl.textContent = `${keycaps(config.bindings.prefix[0])}  …   ? for shortcuts`;
  hintEl.classList.toggle("on", on);
}

function onKeyDown(ev) {
  if (!config || ev.isComposing) return;
  // While the palette is open its input owns the keyboard.
  if (isPaletteOpen()) return;
  if (ev.key === "Shift" || ev.key === "Control" || ev.key === "Alt" || ev.key === "Meta") return;
  // Direct Cmd/Ctrl shortcuts come first, so they work even inside a terminal.
  const appHit = findAppAction(ev);
  if (appHit) { ev.preventDefault(); ev.stopPropagation(); run(appHit.action, appHit.arg); return; }
  if (inTerminal(ev.target)) return;
  const now = Date.now();
  if (now < prefixUntil) {
    prefixUntil = 0; showHint(false);
    ev.preventDefault(); ev.stopPropagation();
    if (eventKey(ev) === "esc") return;
    const found = findAction(ev, true);
    if (found) run(found.action, found.arg);
    return;
  }
  if (config.bindings.prefix.some((text) => matches(parseBinding(text), ev) === true)) {
    ev.preventDefault(); ev.stopPropagation();
    prefixUntil = now + PREFIX_WINDOW_MS;
    showHint(true);
    setTimeout(() => { if (Date.now() >= prefixUntil) showHint(false); }, PREFIX_WINDOW_MS + 50);
    return;
  }
  // Direct (prefix-free) bindings; a bare key never fires while the user is typing.
  const found = findAction(ev, false);
  if (!found) return;
  if (typing(ev.target) && !(ev.ctrlKey || ev.altKey || ev.metaKey)) return;
  ev.preventDefault(); ev.stopPropagation();
  run(found.action, found.arg);
}

// ------------------------------------------------------------ actions
const rows = () => [...document.querySelectorAll("#sidebar .sb-row")];
const activeRow = () => rows().find((r) => r.classList.contains("sb-active")) ?? null;

function openRow(row) { if (row) { row.click(); markActive(row); } }
function markActive(row) {
  for (const r of rows()) r.classList.toggle("sb-active", r === row);
}
function step(delta) {
  const list = rows();
  if (!list.length) return;
  const at = list.indexOf(activeRow());
  openRow(list[(at + delta + list.length) % list.length]);
}

function run(action, arg) {
  switch (action) {
    case "help": return showSheet();
    case "reload_config": return load().then(() => { registerBuiltins(); flash("Key settings reloaded."); });
    case "goto": return showGoto();
    case "workspace_picker": return navigate();
    case "next_tab": return step(1);
    case "previous_tab": return step(-1);
    case "switch_tab": return openRow(rows()[(arg ?? 1) - 1]);
    case "next_agent":
    case "next_needs_you": return nextNeedsYou();
    case "rename_tab": return renameSession();
    case "toggle_sidebar":
    case "sidebar": return document.body.classList.toggle("sidebar-hidden");
    case "focus_pane_left": return app.tiles?.focusDir("left") || focusColumn(-1);
    case "focus_pane_right": return app.tiles?.focusDir("right") || focusColumn(1);
    case "focus_pane_up": return app.tiles?.focusDir("up");
    case "focus_pane_down": return app.tiles?.focusDir("down");
    case "split_vertical":
    case "split_right": return app.tiles?.split("right");
    case "split_horizontal":
    case "split_down": return app.tiles?.split("down");
    case "resize_pane_left": return app.tiles?.resize("left");
    case "resize_pane_right": return app.tiles?.resize("right");
    case "resize_pane_up": return app.tiles?.resize("up");
    case "resize_pane_down": return app.tiles?.resize("down");
    case "move_pane_left": return app.tiles?.moveDir("left");
    case "move_pane_right": return app.tiles?.moveDir("right");
    case "move_pane_up": return app.tiles?.moveDir("up");
    case "move_pane_down": return app.tiles?.moveDir("down");
    case "swap_pane_left": return app.tiles?.swapDir("left");
    case "swap_pane_right": return app.tiles?.swapDir("right");
    case "swap_pane_up": return app.tiles?.swapDir("up");
    case "swap_pane_down": return app.tiles?.swapDir("down");
    case "toggle_console":
    case "console": return app.toggleConsole?.();
    case "cycle_pane_next": return focusColumn(1, true);
    case "zoom": return app.tiles && app.tiles.tileCount() > 1 ? app.tiles.zoom() : app.toggleZoom();
    case "close_pane": return app.closeTab ? app.closeTab() : app.closePanel();
    case "close_tab": return app.closeTab ? app.closeTab() : app.closePanel();
    case "new_tab":
    case "terminal": return app.showPane("terminal");
    case "palette": return isPaletteOpen() ? closePalette() : openPalette();
    case "open_file": return openQuickFile();
    case "show_changes": return app.showPane("changes");
    case "show_files": return app.showPane("files");
    case "show_search": return app.showPane("search");
    default:
      if (/^session_[1-9]$/.test(action)) return openRow(rows()[Number(action.slice(8)) - 1]);
  }
}

/** next_agent / next_needs_you: open the next sidebar row waiting on the owner. */
function nextNeedsYou() {
  const needing = rows().filter((r) => r.querySelector(".sb-bar.needs, .sb-ring.needs"));
  if (!needing.length) return flash("No session needs you.");
  const at = needing.indexOf(activeRow());
  return openRow(needing[(at + 1) % needing.length]);
}

/** open_file: the Files pane's own quick open (its ⌘P control). */
function openQuickFile() {
  app.showPane("files");
  document.querySelector(".ed-qp")?.click();
}

// The three columns, left to right; hidden ones are skipped.
function columns() {
  return [document.getElementById("sidebar"), document.getElementById("main"), document.getElementById("side")]
    .filter((el) => el && !el.hidden && el.offsetParent !== null);
}
function focusColumn(delta, wrap = false) {
  const list = columns();
  const at = list.findIndex((el) => el.contains(document.activeElement));
  let next = at < 0 ? 0 : at + delta;
  if (wrap) next = (next + list.length) % list.length;
  const el = list[Math.max(0, Math.min(list.length - 1, next))];
  if (!el) return;
  if (el.id === "sidebar") return navigate();
  const target = el.querySelector("textarea, .monaco-editor textarea, input, button, [tabindex]") ?? el;
  target.focus();
}

/** workspace_picker: walk the sidebar with arrows or j/k, Enter opens, t opens its terminal, Esc leaves. */
function navigate() {
  document.body.classList.remove("sidebar-hidden");
  const list = rows();
  const row = activeRow() ?? list[0];
  row?.focus();
}
function onSidebarKey(ev) {
  const row = ev.target instanceof Element ? ev.target.closest(".sb-row") : null;
  if (!row || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const key = eventKey(ev);
  const list = rows();
  const at = list.indexOf(row);
  if (key === "down" || key === "j") { ev.preventDefault(); list[(at + 1) % list.length]?.focus(); }
  else if (key === "up" || key === "k") { ev.preventDefault(); list[(at - 1 + list.length) % list.length]?.focus(); }
  else if (key === "enter") { ev.preventDefault(); openRow(row); }
  else if (key === "t") { ev.preventDefault(); row.querySelector(".sb-term")?.click(); }
  else if (key === "esc") { ev.preventDefault(); row.blur(); document.querySelector("#main textarea")?.focus(); }
}

// ------------------------------------------------------------ overlays
function overlay(className) {
  closeOverlay();
  const back = document.createElement("div");
  back.className = "keys-overlay";
  back.addEventListener("click", (ev) => { if (ev.target === back) closeOverlay(); });
  const card = document.createElement("div");
  card.className = `keys-card ${className}`;
  back.append(card);
  document.body.append(back);
  back.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { ev.preventDefault(); closeOverlay(); } });
  return card;
}
function closeOverlay() { document.querySelector(".keys-overlay")?.remove(); }

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** help: every action, its keys and where the binding came from. */
function showSheet() {
  const card = overlay("keys-sheet");
  card.append(el("div", "keys-title", "Keyboard shortcuts"));
  card.append(el("div", "keys-sub", "Herdr's keys, in Phren. Inside a terminal panel they go to Herdr itself."));
  const groups = new Map();
  for (const a of config.actions) {
    if (!groups.has(a.group)) groups.set(a.group, []);
    groups.get(a.group).push(a);
  }
  const grid = el("div", "keys-grid");
  for (const [group, actions] of groups) {
    const box = el("div", "keys-group");
    box.append(el("div", "keys-group-label", group.toUpperCase()));
    for (const a of actions) {
      const row = el("div", "keys-row");
      row.append(el("span", "keys-label", a.label));
      const caps = el("span", "keys-caps");
      const list = (a.app ? config.appBindings?.[a.action] : config.bindings[a.action]) ?? [];
      if (!list.length) caps.append(el("span", "keys-unbound", "unbound"));
      for (const b of list) caps.append(el("kbd", "", keycaps(b)));
      const source = (a.app ? config.appSources : config.sources)[a.action];
      if (source && source !== "default") caps.append(el("span", "keys-source", source === "herdr" ? "Herdr" : "desktop.toml"));
      row.append(caps);
      box.append(row);
    }
    grid.append(box);
  }
  card.append(grid);
  const foot = el("div", "keys-foot");
  foot.append(el("div", "", `Change them in ${config.files.desktop} under [keys] or [keys.app], same names and syntax as Herdr's config. Your Herdr keys in ${config.files.herdr} apply too; the desktop file wins. "" unbinds.`));
  for (const error of config.errors) foot.append(el("div", "keys-error", error));
  card.append(foot);
  card.tabIndex = -1; card.focus();
}

/** goto: pick any session on any computer by typing part of its name. */
function showGoto() {
  const card = overlay("keys-goto");
  const input = el("input", "keys-input");
  input.placeholder = "Go to a session";
  const list = el("div", "keys-list");
  card.append(input, list);
  let items = [];
  let selected = 0;
  const render = () => {
    const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    items = rows().filter((r) => words.every((w) => sessionLabel(r).toLowerCase().includes(w)));
    selected = Math.min(selected, Math.max(0, items.length - 1));
    list.replaceChildren(...items.slice(0, 50).map((r, i) => {
      const item = el("div", `keys-item${i === selected ? " on" : ""}`);
      const f = rowFields(r);
      item.append(highlightLine("keys-item-title", f.title || f.project || "", words));
      const meta = [f.project, f.computer, f.branch].filter(Boolean);
      if (meta.length) item.append(highlightLine("keys-item-meta", meta.join(" · "), words));
      item.addEventListener("click", () => { closeOverlay(); openRow(r); });
      return item;
    }));
    if (!items.length) list.append(el("div", "keys-empty", "No session matches."));
  };
  input.addEventListener("input", () => { selected = 0; render(); });
  input.addEventListener("keydown", (ev) => {
    const key = eventKey(ev);
    if (key === "down") { ev.preventDefault(); selected = Math.min(selected + 1, items.length - 1); render(); }
    else if (key === "up") { ev.preventDefault(); selected = Math.max(selected - 1, 0); render(); }
    else if (key === "enter") { ev.preventDefault(); const r = items[selected]; closeOverlay(); openRow(r); }
  });
  render();
  input.focus();
}

function textOf(node, selector) {
  const child = node.querySelector(selector);
  return child ? child.textContent.trim() : "";
}
function rowFields(row) {
  return {
    title: textOf(row, ".sb-title"),
    project: textOf(row, ".sb-project"),
    computer: textOf(row, ".sb-computer"),
    branch: textOf(row, ".sb-branch"),
  };
}
function sessionLabel(row) {
  const f = rowFields(row);
  return [f.title, f.project, f.computer, f.branch].filter(Boolean).join(" ");
}

/** One picker line with every query-word match wrapped in <mark>, built as DOM. */
function highlightLine(className, text, words) {
  const line = el("div", className);
  line.textContent = text;
  if (!words.length || !text) return line;
  const lower = text.toLowerCase();
  const ranges = [];
  for (const w of words) {
    let at = lower.indexOf(w);
    while (at !== -1) { ranges.push([at, at + w.length]); at = lower.indexOf(w, at + w.length); }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const out = document.createDocumentFragment();
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start < cursor) continue;
    if (start > cursor) out.append(document.createTextNode(text.slice(cursor, start)));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(start, end);
    out.append(mark);
    cursor = end;
  }
  if (cursor < text.length) out.append(document.createTextNode(text.slice(cursor)));
  line.replaceChildren(out);
  return line;
}

/** rename_tab: rename the open session (pane label and the harness's own title). */
function renameSession() {
  const session = app.currentSession();
  if (!session?.child?.target) return flash("Open a session to rename it.");
  const { computer, child } = session;
  const card = overlay("keys-goto");
  const input = el("input", "keys-input");
  input.value = child.title ?? child.label ?? "";
  input.placeholder = "Session name";
  const note = el("div", "keys-sub", `Renames it on ${computer}, in the terminal and in the agent.`);
  card.append(input, note);
  input.addEventListener("keydown", async (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    const label = input.value.trim();
    if (!label) return;
    const t = child.target;
    try {
      await hookPost(computer, `/v1/sessions/rename?server=${encodeURIComponent(t.server)}`, { workspaceId: t.workspace, tabId: t.tab, paneId: t.pane, label });
      closeOverlay(); flash("Renamed.");
    } catch (error) { note.textContent = error.message; note.classList.add("keys-error"); }
  });
  input.select(); input.focus();
}

function flash(text) {
  showHint(false);
  const note = el("div", "keys-flash", text);
  document.body.append(note);
  setTimeout(() => note.remove(), 1800);
}

// ------------------------------------------------------------ palette commands
// The existing key actions as concise palette commands, showing their shortcuts.
const BUILTINS = [
  ["show_changes", "Show Changes"],
  ["show_files", "Show Files"],
  ["show_search", "Show Search"],
  ["terminal", "Show Terminal"],
  ["close_tab", "Close Tab"],
  ["next_tab", "Next Tab"],
  ["zoom", "Toggle Zoom"],
  ["toggle_sidebar", "Toggle Sidebar"],
];

function registerBuiltins() {
  for (const [action, title] of BUILTINS) {
    const binds = config.bindings[action] ?? config.appBindings?.[action] ?? [];
    registerCommand({ id: `keys.${action}`, title, group: "Commands", keys: binds.map(keycaps).join("  "), run: () => run(action) });
  }
}

// ------------------------------------------------------------ setup
async function load() {
  const response = await fetch("/api/keys", { cache: "no-store" });
  config = await response.json();
}

const STYLE = `
.keys-hint { position: fixed; left: 12px; bottom: 12px; padding: 6px 12px; border-radius: 999px; background: var(--raised); color: var(--text-2); font: 12px "JetBrains Mono", ui-monospace, monospace; border: 1px solid var(--border-strong); opacity: 0; transform: translateY(4px); transition: opacity .18s ease, transform .18s ease; pointer-events: none; z-index: 60; }
.keys-hint.on { opacity: 1; transform: none; }
.keys-flash { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); padding: 8px 16px; border-radius: 999px; background: var(--raised); color: var(--text); font: 13px system-ui; z-index: 70; }
.keys-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: flex; align-items: flex-start; justify-content: center; padding-top: 12vh; z-index: 80; }
.keys-card { background: var(--surface); border: 1px solid var(--border-strong); border-radius: 18px; padding: 16px; box-shadow: 0 24px 60px rgba(0,0,0,.5); outline: none; }
.keys-sheet { width: min(860px, 92vw); max-height: 76vh; overflow: auto; padding: 20px 24px; }
.keys-title { font: 600 16px system-ui; color: var(--text); }
.keys-sub { font: 12.5px system-ui; color: var(--muted); margin: 4px 0 16px; }
.keys-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 16px 28px; }
.keys-group-label { font: 600 11px system-ui; letter-spacing: .08em; color: var(--muted); margin-bottom: 6px; }
.keys-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 30px; border-bottom: 1px solid var(--border); }
.keys-label { font: 13px system-ui; color: var(--text-2); }
.keys-caps { display: flex; gap: 6px; align-items: center; flex: none; }
.keys-caps kbd { font: 12px "JetBrains Mono", ui-monospace, monospace; color: var(--accent); background: var(--raised); border-radius: 6px; padding: 2px 7px; white-space: pre; }
.keys-unbound { font: 12px system-ui; color: var(--dim); }
.keys-source { font: 11px system-ui; color: var(--done); }
.keys-foot { margin-top: 16px; font: 12px system-ui; color: var(--muted); line-height: 1.5; }
.keys-error { color: var(--danger); }
.keys-goto { width: min(560px, 90vw); }
.keys-input { width: 100%; box-sizing: border-box; background: var(--sunken); border: 1px solid var(--border); border-radius: 12px; padding: 10px 12px; color: var(--text); font: 14px system-ui; outline: none; }
.keys-input:focus { border-color: var(--accent); }
.keys-list { margin-top: 8px; max-height: 50vh; overflow: auto; }
.keys-item { padding: 8px 12px; border-radius: 10px; cursor: pointer; }
.keys-item.on, .keys-item:hover { background: var(--raised); }
.keys-item-title { font: 13px system-ui; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.keys-item.on .keys-item-title, .keys-item:hover .keys-item-title { color: var(--text); }
.keys-item-meta { margin-top: 2px; font: 12px "JetBrains Mono", ui-monospace, monospace; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.keys-item mark { background: transparent; color: var(--accent); font-weight: 600; }
.keys-empty { padding: 8px 12px; color: var(--muted); font: 13px system-ui; }
#sidebar .sb-row.sb-active { background: var(--surface); }
body.sidebar-hidden #sidebar { display: none; }
@media (prefers-reduced-motion: reduce) { .keys-hint { transition: none; } }
`;

/** Install once. `actions` comes from app.js: showPane, toggleZoom, closePanel, currentSession. */
export async function installKeys(actions) {
  app = actions;
  const style = document.createElement("style");
  style.id = "keys-style";
  style.textContent = STYLE;
  document.head.append(style);
  await load();
  registerBuiltins();
  // Capture phase, so Monaco and inputs do not swallow the prefix first.
  window.addEventListener("keydown", onKeyDown, true);
  document.getElementById("sidebar").addEventListener("keydown", onSidebarKey);
}

/** Mark the session the chat shows, so next/previous start from it. */
export function setActiveSession(computer, child) {
  for (const r of rows()) r.classList.toggle("sb-active", r.dataset.session === `${computer}/${child?.id}`);
}

// The Ctrl+Tab recent-chat switcher. Hold Ctrl and press Tab: the previous chat
// is selected (like an app switcher), more Tab / Shift+Tab move the selection,
// releasing Ctrl opens it, Esc cancels. A quick tap-and-release toggles to the
// previous chat without the overlay ever showing (it appears after SHOW_AFTER_MS).
// Data comes from the overview store's rows; no requests of its own.

import { el } from "../dom.js";
import { projectOf, sessionKind, store } from "./store.js";
import { RECENT_LIMIT, createMru, initialSelection, moveSelection } from "./recent-mru.js";

export const SHOW_AFTER_MS = 150;
const STORAGE_KEY = "phren.desktop.recent";
const STATUS = { needs: "Needs you", working: "Working", error: "Error", unknown: "Unknown", idle: "Idle", done: "Done" };

const keyOf = (computer, child) => `${computer}/${child.id}`;

function readSaved() {
  try { const list = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]"); return Array.isArray(list) ? list.filter((k) => typeof k === "string") : []; }
  catch { return []; }
}
function save(mru) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(mru.list())); } catch { /* storage unavailable */ }
}

const mru = createMru(RECENT_LIMIT, readSaved());

/** Record that this session's tab became active. Called from the one place tabs activate. */
export function noteActiveSession(computer, child) {
  if (!child?.id) return;
  mru.touch(keyOf(computer, child));
  save(mru);
}

/** The live rows for the MRU keys, newest first; sessions that disappeared are dropped. */
export function recentRows() {
  const rows = store.sessions({ includeOffline: true });
  if (store.merged) { mru.prune((k) => rows.some((r) => keyOf(r.computer, r.child) === k)); save(mru); }
  const byKey = new Map(rows.map((r) => [keyOf(r.computer, r.child), r]));
  return mru.list().map((k) => byKey.get(k)).filter(Boolean);
}

/** @param {{ open(computer, child): void, enabled?(): boolean }} options */
export function startRecentSwitcher({ open, enabled = () => true }) {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("recent.css", import.meta.url).href;
  document.head.append(link);

  let state = null; // { rows, index, shown, timer, backdrop, list, restore }

  function paint() {
    if (!state?.shown) return;
    state.list.setAttribute("aria-activedescendant", `mru-opt-${state.index}`);
    [...state.list.children].forEach((card, i) => {
      card.setAttribute("aria-selected", String(i === state.index));
    });
    state.list.children[state.index]?.scrollIntoView?.({ block: "nearest" });
  }

  function card(row, i) {
    const { child, computer } = row;
    const kind = sessionKind(child);
    const li = el("li", "mru-card");
    li.id = `mru-opt-${i}`;
    li.setAttribute("role", "option");
    li.append(el("span", `mru-dot ${kind}`), el("span", "mru-title", child.title || child.label || projectOf(child)));
    const meta = el("span", "mru-meta");
    meta.append(el("span", "mru-host", computer), el("span", "mru-status", STATUS[kind] ?? STATUS.unknown));
    li.append(meta);
    if (child.lastReply) li.append(el("span", "mru-reply", child.lastReply));
    // Ctrl is held, and on a Mac Ctrl+click is a context click that fires no "click": open on mousedown.
    li.addEventListener("mousedown", (ev) => {
      if (!state || ev.button !== 0) return;
      ev.preventDefault();
      state.index = i;
      commit();
    });
    li.addEventListener("contextmenu", (ev) => ev.preventDefault());
    return li;
  }

  function show() {
    if (!state || state.shown) return;
    clearTimeout(state.timer);
    state.shown = true;
    state.restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const backdrop = el("div", "mru-backdrop");
    const sheet = el("div", "mru-sheet");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-label", "Recent chats");
    const list = el("ul", "mru-list");
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Recent chats");
    list.tabIndex = -1;
    list.append(...state.rows.map(card));
    sheet.append(list, el("div", "mru-hint", "Tab to move, release Ctrl to open, Esc to cancel"));
    backdrop.append(sheet);
    backdrop.addEventListener("mousedown", (ev) => { if (ev.target === backdrop) cancel(); });
    document.body.append(backdrop);
    state.backdrop = backdrop;
    state.list = list;
    list.focus({ preventScroll: true });
    paint();
  }

  function close({ restoreFocus }) {
    if (!state) return null;
    const done = state;
    state = null;
    clearTimeout(done.timer);
    done.backdrop?.remove();
    if (restoreFocus && done.restore?.isConnected) done.restore.focus({ preventScroll: true });
    return done;
  }

  function cancel() { close({ restoreFocus: true }); }

  function commit() {
    const done = close({ restoreFocus: false });
    const row = done?.rows[done.index];
    if (row) open(row.computer, row.child);
  }

  function onKeyDown(ev) {
    if (state && ev.key === "Escape") {
      ev.preventDefault(); ev.stopPropagation(); cancel();
      return;
    }
    if (ev.key !== "Tab" || !ev.ctrlKey || ev.altKey || ev.metaKey || ev.isComposing) return;
    if (!state && !enabled()) return;
    ev.preventDefault(); ev.stopPropagation();
    if (!state) {
      const rows = recentRows();
      const index = initialSelection(rows.length, ev.shiftKey);
      if (index < 0) return;
      state = { rows, index, shown: false, timer: setTimeout(show, SHOW_AFTER_MS) };
      return;
    }
    state.index = moveSelection(state.index, state.rows.length, ev.shiftKey ? -1 : 1);
    show();
    paint();
  }

  function onKeyUp(ev) {
    if (state && ev.key === "Control") { ev.preventDefault(); commit(); }
  }

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  // Ctrl released outside the window never reaches keyup; treat leaving as cancel.
  window.addEventListener("blur", () => { if (state) cancel(); });
}

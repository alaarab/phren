// The Ctrl+Tab recent-chat switcher. Hold Ctrl and press Tab: the previous chat
// is selected (like an app switcher), more Tab / Shift+Tab move the selection,
// releasing Ctrl opens it, Esc cancels. A quick tap-and-release toggles to the
// previous chat without the overlay ever showing (it appears after SHOW_AFTER_MS).
// Data comes from the overview store's rows; no requests of its own.
//
// Terminals, editors and iframes keep Ctrl+Tab. If the Ctrl keyup is missed
// (focus moved into an iframe, a dialog, an IME) the next key or pointer event
// with Ctrl up settles the switcher: it opens the selection when the overlay is
// showing and cancels when it never showed. Hiding the page cancels.

import { el } from "../dom.js";
import { projectOf, sessionKind, store } from "./store.js";
import { RECENT_LIMIT, acceptTab, createMru, initialSelection, lostCtrl, moveSelection, ownsCtrlTab, validKeys } from "./recent-mru.js";

export const SHOW_AFTER_MS = 150;
const REPEAT_GAP_MS = 150;
const INPUT_WINDOW_MS = 1000;
const STORAGE_KEY = "phren.desktop.recent";
const STATUS = { needs: "Needs you", working: "Working", error: "Error", unknown: "Unknown", idle: "Idle", done: "Done" };

const keyOf = (computer, child) => `${computer}/${child.id}`;

function readSaved() {
  try { return validKeys(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]")); }
  catch { return []; }
}
let saved = "";
function save() {
  const text = JSON.stringify(mru.list());
  if (text === saved) return;
  saved = text;
  try { sessionStorage.setItem(STORAGE_KEY, text); } catch { /* storage unavailable */ }
}

const mru = createMru(RECENT_LIMIT, readSaved());
saved = JSON.stringify(mru.list());

// Only the user's own activations reorder the list. A tab that opens by itself
// (restore on launch, a notification, the tray) waits in `pending` and counts
// once the user then presses a key or clicks while it is on screen.
let lastInput = 0;
let pending = null;
export function noteUserInput() {
  lastInput = Date.now();
  if (pending) { mru.touch(pending); pending = null; save(); }
}

/** Record that this session's tab became active. Called from the one place tabs activate. */
export function noteActiveSession(computer, child) {
  if (!child?.id) return;
  const key = keyOf(computer, child);
  if (Date.now() - lastInput <= INPUT_WINDOW_MS) { pending = null; mru.touch(key); save(); }
  else pending = key;
}

/** The live rows for the MRU keys, newest first; sessions that disappeared are dropped. */
export function recentRows() {
  const rows = store.sessions({ includeOffline: true });
  if (store.merged) { mru.prune((k) => rows.some((r) => keyOf(r.computer, r.child) === k)); save(); }
  const byKey = new Map(rows.map((r) => [keyOf(r.computer, r.child), r]));
  return mru.list().map((k) => byKey.get(k)).filter(Boolean);
}

const titleOf = (child) => child.title || child.label || projectOf(child);

/** What a screen reader hears for the selected card. */
export function describeRow(row) {
  const status = (STATUS[sessionKind(row.child)] ?? STATUS.unknown).toLowerCase();
  return `${titleOf(row.child)}, ${projectOf(row.child)} on ${row.computer}, ${status}`;
}

/** @param {{ open(computer, child): void, enabled?(): boolean }} options */
export function startRecentSwitcher({ open, enabled = () => true }) {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("recent.css", import.meta.url).href;
  document.head.append(link);

  let state = null; // { rows, index, shown, timer, lastMove, backdrop, list, live, restore }

  function paint() {
    if (!state?.shown) return;
    state.list.setAttribute("aria-activedescendant", `mru-opt-${state.index}`);
    [...state.list.children].forEach((card, i) => {
      card.setAttribute("aria-selected", String(i === state.index));
    });
    state.list.children[state.index]?.scrollIntoView?.({ block: "nearest" });
    state.live.textContent = describeRow(state.rows[state.index]);
  }

  function card(row, i) {
    const { child, computer } = row;
    const kind = sessionKind(child);
    const li = el("li", "mru-card");
    li.id = `mru-opt-${i}`;
    li.setAttribute("role", "option");
    li.append(el("span", `mru-dot ${kind}`), el("span", "mru-title", titleOf(child)));
    const meta = el("span", "mru-meta");
    meta.append(el("span", "mru-host", computer), el("span", "mru-status", STATUS[kind] ?? STATUS.unknown));
    li.append(meta);
    if (child.lastReply) li.append(el("span", "mru-reply", child.lastReply));
    // Opens on click. A Ctrl+click on a Mac is a context click that fires no
    // "click", so a mousedown with Ctrl held opens it instead; a plain
    // mousedown (a scrollbar or drag) never does.
    const pick = () => { if (state) { state.index = i; commit(); } };
    li.addEventListener("click", pick);
    li.addEventListener("mousedown", (ev) => { if (ev.button === 0 && ev.ctrlKey) { ev.preventDefault(); pick(); } });
    li.addEventListener("contextmenu", (ev) => ev.preventDefault());
    return li;
  }

  function trapFocus(ev) {
    if (state?.shown && state.backdrop && !state.backdrop.contains(ev.target)) state.list.focus({ preventScroll: true });
  }

  function show() {
    if (!state || state.shown) return;
    clearTimeout(state.timer);
    state.shown = true;
    state.restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const backdrop = el("div", "mru-backdrop");
    const sheet = el("div", "mru-sheet");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", "Recent chats");
    const list = el("ul", "mru-list");
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Recent chats");
    list.tabIndex = -1;
    list.append(...state.rows.map(card));
    const live = el("div", "mru-live");
    live.setAttribute("role", "status");
    live.setAttribute("aria-live", "polite");
    sheet.append(list, el("div", "mru-hint", "Tab to move, release Ctrl to open, Esc to cancel"), live);
    backdrop.append(sheet);
    backdrop.addEventListener("mousedown", (ev) => { if (ev.target === backdrop) cancel(); });
    document.body.append(backdrop);
    state.backdrop = backdrop;
    state.list = list;
    state.live = live;
    document.addEventListener("focusin", trapFocus, true);
    list.focus({ preventScroll: true });
    paint();
    // Announce the opening and the selection together, once the region exists.
    live.textContent = `Recent chats, ${state.rows.length} open. ${describeRow(state.rows[state.index])}`;
  }

  function close({ restoreFocus }) {
    if (!state) return null;
    const done = state;
    state = null;
    clearTimeout(done.timer);
    document.removeEventListener("focusin", trapFocus, true);
    done.backdrop?.remove();
    if (restoreFocus && done.restore?.isConnected) done.restore.focus({ preventScroll: true });
    return done;
  }

  function cancel() { close({ restoreFocus: true }); }

  function commit() {
    const done = close({ restoreFocus: false });
    const row = done?.rows[done.index];
    if (!row) return;
    noteUserInput(); // opening it is the user's own activation
    open(row.computer, row.child);
  }

  function step(delta) {
    state.index = moveSelection(state.index, state.rows.length, delta);
    state.lastMove = Date.now();
    show();
    paint();
  }

  function onKeyDown(ev) {
    if (ev.isComposing || ev.keyCode === 229) return;
    if (state) {
      const settle = lostCtrl(state, ev);
      if (settle) { settle === "commit" ? commit() : cancel(); return; }
    }
    if (!state) noteUserInput();
    if (state && ev.key === "Escape") {
      ev.preventDefault(); ev.stopPropagation(); cancel();
      return;
    }
    if (state && state.shown && !["Control", "Shift", "Alt", "Meta", "Tab"].includes(ev.key)) {
      // The overlay is modal: keys do nothing to the page behind it.
      ev.preventDefault(); ev.stopPropagation();
      if (ev.key === "ArrowDown" || ev.key === "ArrowRight") step(1);
      else if (ev.key === "ArrowUp" || ev.key === "ArrowLeft") step(-1);
      else if (ev.key === "Enter") commit();
      return;
    }
    if (ev.key !== "Tab" || !ev.ctrlKey || ev.altKey || ev.metaKey) return;
    if (!state && (!enabled() || ownsCtrlTab(ev.target))) return;
    if (!state) {
      const rows = recentRows();
      const index = initialSelection(rows.length, ev.shiftKey);
      if (index < 0) return; // nothing to switch to: leave the key alone
      ev.preventDefault(); ev.stopPropagation();
      state = { rows, index, shown: false, lastMove: 0, timer: setTimeout(show, SHOW_AFTER_MS) };
      return;
    }
    ev.preventDefault(); ev.stopPropagation();
    if (!acceptTab({ repeat: ev.repeat, shown: state.shown, now: Date.now(), last: state.lastMove }, REPEAT_GAP_MS)) return;
    step(ev.shiftKey ? -1 : 1);
  }

  function onKeyUp(ev) {
    if (state && ev.key === "Control") { ev.preventDefault(); commit(); }
  }

  function onPointer(ev) {
    if (ev.type === "pointerdown") noteUserInput();
    const settle = lostCtrl(state, ev);
    if (settle) { settle === "commit" ? commit() : cancel(); }
  }

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("pointerdown", onPointer, true);
  window.addEventListener("mousemove", onPointer, true);
  // Ctrl released outside the window never reaches keyup; leaving cancels.
  window.addEventListener("blur", () => { if (state) cancel(); });
  document.addEventListener("visibilitychange", () => { if (state && document.visibilityState === "hidden") cancel(); });
}

// Find in chat, the bar: ⌘F / Ctrl+F while focus is inside a chat pane opens a
// small bar above that chat's timeline (input, n/m counter, ↑ ↓, ×). It
// searches what the timeline has drawn (find.js), re-searches shortly after the
// timeline changes without losing the current hit, and on close restores the
// DOM and returns focus to the composer.

import { el } from "../dom.js";
import { createFinder } from "./find.js";

const THROTTLE_MS = 300; // re-search while messages stream in: at most this often
const TYPE_MS = 80;      // pause after typing before searching
const MIN_QUERY = 2;     // shorter queries show nothing

const inComposition = (ev) => !!ev.isComposing || ev.keyCode === 229;

// The chat pane the owner last used: the palette's "Find in chat" opens this one.
let activePane = null;
export function activeFindPane() { return activePane && activePane.isUsable() ? activePane : null; }

/** True when every mutation happened inside the prompt outline's rail (its ticks and tooltip are not conversation). */
export function onlyRail(records) {
  return records.length > 0 && records.every((r) => {
    const node = r.target && r.target.nodeType === 1 ? r.target : r.target && r.target.parentElement;
    return !!(node && node.closest && node.closest(".ct-outline"));
  });
}

/** Is this the key press that opens find (⌘F, or Ctrl+F off the Mac), and not ⇧⌘F / ⌥⌘F? */
export function isFindKey(ev) {
  return !!(ev.metaKey || ev.ctrlKey) && !ev.shiftKey && !ev.altKey && String(ev.key).toLowerCase() === "f";
}

/** "n/m" for the counter; "" before anything is typed. */
export function counterText(query, count, index) {
  if (!query) return "";
  return count ? `${index + 1}/${count}` : "0/0";
}

function open(ancestors) {
  for (const box of ancestors) {
    if (!box.hidden) continue;
    const toggle = box.parentElement && box.parentElement.querySelector(":scope > .ct-toolrow");
    if (toggle) toggle.click();
  }
}

/** Open every collapsed tool block around a hit, outermost first. */
export function revealHit(mark) {
  const boxes = [];
  for (let node = mark.parentElement; node; node = node.parentElement) {
    if (node.classList.contains("ct-toolbox-body")) boxes.unshift(node);
  }
  open(boxes);
}

/**
 * @param {{pane: HTMLElement, root: HTMLElement, before: HTMLElement, focusComposer: () => void,
 *   partial?: () => boolean}} opts pane is the chat pane (it owns the key), root the timeline to search,
 *   before the node the bar sits above, partial() says older history is not loaded.
 */
export function createFindBar({ pane, root, before, focusComposer, partial = () => false }) {
  const finder = createFinder(root, { reveal: revealHit });
  let bar = null;
  let input; let counter; let hint; let prev; let next;
  let timer = null;
  let lastRun = 0;
  let composing = false;
  let observer = null;

  const usable = () => pane.isConnected && pane.getClientRects().length > 0;
  const handle = { isUsable: usable, open: show, close: hide, get isOpen() { return !!bar; }, destroy };

  function observe() {
    if (!observer) observer = new MutationObserver((records) => { if (!onlyRail(records)) schedule(); });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
  }
  function unobserve() { if (observer) { observer.disconnect(); observer.takeRecords(); } }

  function paint() {
    counter.textContent = counterText(finder.query, finder.count, finder.index);
    counter.classList.toggle("none", !!finder.query && !finder.count);
    const empty = !finder.count;
    prev.disabled = empty; next.disabled = empty;
    const lines = [];
    if (partial()) lines.push("Searching loaded messages.");
    if (finder.query && !finder.count) lines.push("A phrase split by formatting (code, bold, links) isn't matched.");
    hint.textContent = lines.join(" ");
    hint.hidden = !lines.length;
  }

  /** Search the loaded messages again; `keep` stays on the current hit and does not scroll. */
  function run({ keep }) {
    if (!bar) return;
    unobserve();
    const result = finder.search(input.value.length >= MIN_QUERY ? input.value : "", { keep });
    if (result.mark) {
      if (!keep) finder.current();
      if (!keep) scrollTo(result.mark);
    }
    paint();
    observe();
  }

  function scrollTo(mark) { if (mark.scrollIntoView) mark.scrollIntoView({ block: "center", inline: "nearest" }); }

  // Streaming changes arrive continuously: search at once when idle, then at most once per THROTTLE_MS,
  // with a trailing run so the last change is always searched.
  function schedule() {
    const wait = lastRun + THROTTLE_MS - Date.now();
    if (wait <= 0) { clearTimeout(timer); timer = null; lastRun = Date.now(); run({ keep: true }); return; }
    if (timer) return;
    timer = setTimeout(() => { timer = null; lastRun = Date.now(); run({ keep: true }); }, wait);
  }

  function typed() {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; lastRun = Date.now(); run({ keep: false }); }, TYPE_MS);
  }

  function step(direction) {
    if (!finder.count) return;
    unobserve();
    const mark = finder.step(direction);
    if (mark) scrollTo(mark);
    paint();
    observe();
  }

  function show() {
    activePane = handle;
    if (bar) { input.focus(); input.select(); return; }
    input = el("input", "chat-find-input");
    input.type = "text";
    input.placeholder = "Find in chat";
    input.setAttribute("aria-label", "Find in chat");
    input.setAttribute("autocomplete", "off");
    input.spellcheck = false;
    counter = el("span", "chat-find-count");
    counter.setAttribute("aria-live", "polite");
    prev = el("button", "chat-find-btn", "↑");
    prev.type = "button"; prev.title = "Previous match (Shift+Enter)"; prev.setAttribute("aria-label", "Previous match");
    next = el("button", "chat-find-btn", "↓");
    next.type = "button"; next.title = "Next match (Enter)"; next.setAttribute("aria-label", "Next match");
    const close = el("button", "chat-find-btn", "×");
    close.type = "button"; close.title = "Close (Esc)"; close.setAttribute("aria-label", "Close find");
    hint = el("div", "chat-find-hint", "Searching loaded messages");
    hint.hidden = true;
    const row = el("div", "chat-find-row");
    row.append(input, counter, prev, next, close);
    bar = el("div", "chat-find");
    bar.setAttribute("role", "search");
    bar.append(row, hint);

    for (const button of [prev, next, close]) button.addEventListener("mousedown", (ev) => ev.preventDefault());
    prev.addEventListener("click", () => step(-1));
    next.addEventListener("click", () => step(1));
    close.addEventListener("click", hide);
    // Typing re-searches after a short pause, and never mid-composition (an IME's candidate text is not the query yet).
    input.addEventListener("compositionstart", () => { composing = true; });
    input.addEventListener("compositionend", () => { composing = false; typed(); });
    input.addEventListener("input", () => { if (!composing) typed(); });
    bar.addEventListener("keydown", (ev) => {
      if (inComposition(ev)) return; // Enter / Esc here confirm or cancel the IME, not find
      if (ev.key === "Enter" && ev.target === input) { ev.preventDefault(); step(ev.shiftKey ? -1 : 1); }
    });
    pane.insertBefore(bar, before);
    paint();
    observe();
    input.focus();
  }

  function hide() {
    if (!bar) return;
    clearTimeout(timer);
    unobserve();
    finder.clear();
    bar.remove();
    bar = null;
    focusComposer();
  }

  function destroy() {
    clearTimeout(timer);
    unobserve();
    finder.clear();
    bar?.remove();
    bar = null;
    document.removeEventListener("keydown", onEsc);
    if (activePane === handle) activePane = null;
  }

  // The pane the owner last touched is the one the palette's command opens.
  pane.addEventListener("focusin", () => { activePane = handle; });
  pane.addEventListener("pointerdown", () => { activePane = handle; }, true);
  pane.addEventListener("keydown", (ev) => {
    if (isFindKey(ev)) { ev.preventDefault(); show(); }
  });
  // Esc closes from anywhere in the pane (the composer, the bar) or from the timeline, where a click leaves focus
  // on the body, unless something inside already used the key. Listening only while the bar is open.
  function onEsc(ev) {
    if (!bar || ev.key !== "Escape" || ev.defaultPrevented || inComposition(ev)) return;
    if (ev.target !== document.body && !pane.contains(ev.target)) return;
    ev.preventDefault();
    hide();
  }
  document.addEventListener("keydown", onEsc);

  return handle;
}

// Prompt outline: a slim rail along the right edge of a long transcript, one
// tick per loaded user prompt. Prompts behind the timeline's fold sit in a
// compressed top segment (hollow ticks); drawn ones follow in proportion to
// their scroll offset. The math is pure (src/ui-chat-outline.test.ts runs it);
// `createOutline` is the DOM around it, driven by timeline-view.js.

export const MIN_PROMPTS = 3;          // fewer prompts than this need no outline
export const MIN_VIEWPORTS = 2;        // drawn content must be this many screens tall (when nothing is folded)
export const MIN_WIDTH = 520;          // the chat pane's width below which the rail gives way
export const TOP_PAD = 12;             // a jumped-to prompt lands this far below the top edge
export const MAX_FOLD_SHARE = 0.25;    // folded prompts take at most this much of the rail
export const MIN_GAP = 10;             // px between ticks; closer ones merge into one
const FOLD_PER_PROMPT = 0.05;
const CURRENT_BIAS = 0.25;             // a prompt counts as current once it is in the top quarter

/** Whether the rail is worth showing: enough loaded prompts, and something to jump through (folded prompts, or drawn content over two screens). */
export function shouldShow({ prompts, folded = 0, scrollHeight, clientHeight, width = Infinity }) {
  if (!(clientHeight > 0) || prompts < MIN_PROMPTS || width < MIN_WIDTH) return false;
  return folded > 0 || scrollHeight > clientHeight * MIN_VIEWPORTS;
}

/** Each offset as a 0..1 fraction of the content height. */
export function tickPositions(offsets, total) {
  if (!(total > 0)) return offsets.map(() => 0);
  return offsets.map((offset) => Math.min(1, Math.max(0, offset / total)));
}

/**
 * Rail fractions (0..1 of the rail's height) for `folded` folded prompts, evenly
 * spaced in a compressed top segment, then the drawn prompts by scroll offset below it.
 */
export function layoutFractions({ offsets, folded = 0, scrollHeight }) {
  const share = folded > 0 ? Math.min(MAX_FOLD_SHARE, folded * FOLD_PER_PROMPT) : 0;
  const base = folded > 0 ? share + 0.03 : 0;
  return {
    folded: Array.from({ length: folded }, (_, i) => ((i + 0.5) / folded) * share),
    drawn: tickPositions(offsets, scrollHeight).map((f) => base + (1 - base) * f),
    divider: folded > 0 ? share + 0.015 : null,
  };
}

/**
 * Merge ticks closer than `minGap` px (to the first of their run) into one.
 * @param {number[]} px tick positions, ascending
 * @returns {Array<{first:number,last:number}>} runs of consecutive indexes
 */
export function clusterTicks(px, minGap = MIN_GAP) {
  const runs = [];
  for (let i = 0; i < px.length; i += 1) {
    const run = runs[runs.length - 1];
    if (run && px[i] - px[run.first] < minGap) run.last = i;
    else runs.push({ first: i, last: i });
  }
  return runs;
}

/** The scrollTop that brings a prompt at `offset` into view. */
export function scrollTarget(offset, scrollHeight = Infinity, clientHeight = 0) {
  return Math.max(0, Math.min(offset - TOP_PAD, Math.max(0, scrollHeight - clientHeight)));
}

/** Index of the prompt the reader is in: the last one at or above the top quarter of the view; the first before any. -1 with none. */
export function currentPrompt(offsets, scrollTop, clientHeight) {
  if (!offsets.length) return -1;
  const line = scrollTop + clientHeight * CURRENT_BIAS;
  let current = 0;
  for (let i = 0; i < offsets.length; i += 1) if (offsets[i] <= line) current = i;
  return current;
}

/** The prompt an Alt+Up (-1) or Alt+Down (1) goes to from `scrollTop`, or -1 when there is none that way. */
export function stepPrompt(offsets, scrollTop, direction, scrollHeight = Infinity, clientHeight = 0) {
  const goal = (i) => scrollTarget(offsets[i], scrollHeight, clientHeight);
  if (direction < 0) {
    for (let i = offsets.length - 1; i >= 0; i -= 1) if (goal(i) < scrollTop - 2) return i;
  } else {
    for (let i = 0; i < offsets.length; i += 1) if (goal(i) > scrollTop + 2) return i;
  }
  return -1;
}

/** A prompt's first non-empty line, trimmed and cut for a tooltip. */
export function firstLine(text, max = 140) {
  const line = String(text || "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The label of a tick standing for prompts `first`..`last` (0-based). */
export function tickLabel(first, last, text) {
  return first === last ? `Prompt ${first + 1}: ${firstLine(text)}` : `Prompts ${first + 1}–${last + 1}: ${firstLine(text)}`;
}

const reducedMotion = () => !!(globalThis.matchMedia && globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches);

/**
 * @param {{root: HTMLElement, scroll: HTMLElement,
 *   prompts: () => Array<{id: string, el: (HTMLElement|null), text: string}>,
 *   reveal: (id: string) => void,
 *   earlier: () => (null | (() => Promise<void> | void))}} opts
 *   `prompts` is every loaded prompt in order; the folded ones (an earlier run)
 *   have no `el`. `reveal` opens the fold and calls `jumpToId` once the prompt
 *   is drawn. `earlier` is the action behind "↑ earlier" (null when no older
 *   history is unloaded).
 */
export function createOutline({ root, scroll, prompts, reveal, earlier }) {
  const nav = document.createElement("nav");
  nav.className = "ct-outline";
  nav.setAttribute("aria-label", "Prompts");
  nav.hidden = true;
  const earlierBtn = document.createElement("button");
  earlierBtn.type = "button";
  earlierBtn.className = "ct-outline-earlier";
  earlierBtn.textContent = "↑ earlier";
  earlierBtn.setAttribute("aria-label", "Load earlier prompts");
  earlierBtn.hidden = true;
  const track = document.createElement("div");
  track.className = "ct-outline-track";
  const divider = document.createElement("div");
  divider.className = "ct-outline-divider";
  divider.hidden = true;
  const tip = document.createElement("div");
  tip.className = "ct-outline-tip";
  tip.setAttribute("aria-hidden", "true");
  tip.hidden = true;
  nav.append(earlierBtn, track, tip);
  track.append(divider);
  root.append(nav);

  let offsets = [];      // drawn prompts' offsets, in order
  let drawnFrom = 0;     // index in prompts() of the first drawn one
  let ticks = [];        // { el, first, last, top }
  let signature = "";
  let frame = 0;
  let markFrame = 0;
  let loading = false;
  let goal = null;       // the scrollTop a jump is heading for, while it animates
  let goalTimer = 0;
  let flashTimer = 0;
  let alive = true;

  const container = () => root.closest(".session-doc") || root;
  const visible = () => !nav.hidden && nav.offsetParent !== null && getComputedStyle(nav).display !== "none";

  function measure(list) {
    const top = scroll.getBoundingClientRect().top - scroll.scrollTop;
    return list.filter((p) => p.el).map((p) => p.el.getBoundingClientRect().top - top);
  }

  function showTip(tick) {
    const list = prompts();
    if (!list[tick.first]) return;
    tip.textContent = tick.first === tick.last
      ? firstLine(list[tick.first].text, 200)
      : `Prompts ${tick.first + 1}–${tick.last + 1}`;
    tip.hidden = false;
    const navTop = nav.getBoundingClientRect().top;
    const rect = tick.el.getBoundingClientRect();
    tip.style.top = `${rect.top - navTop + rect.height / 2}px`;
  }
  const hideTip = () => { tip.hidden = true; };

  function mark() {
    markFrame = 0;
    if (nav.hidden) return;
    const current = currentPrompt(offsets, scroll.scrollTop, scroll.clientHeight);
    const index = current < 0 ? -1 : drawnFrom + current;
    for (const t of ticks) {
      const on = index >= t.first && index <= t.last;
      t.el.classList.toggle("current", on);
      if (on) t.el.setAttribute("aria-current", "true"); else t.el.removeAttribute("aria-current");
    }
  }

  function update() {
    frame = 0;
    if (!alive) return;
    const list = prompts();
    const folded = list.filter((p) => !p.el).length;
    const show = shouldShow({
      prompts: list.length, folded, scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight,
      width: container().clientWidth,
    });
    nav.hidden = !show;
    if (!show) { signature = ""; return; }
    // The rail's edge clears the transcript's own scrollbar.
    nav.style.setProperty("--ct-sb", `${Math.max(0, scroll.offsetWidth - scroll.clientWidth)}px`);
    drawnFrom = folded;
    offsets = measure(list);
    earlierBtn.hidden = !earlier();
    const layout = layoutFractions({ offsets, folded, scrollHeight: scroll.scrollHeight });
    const fractions = [...layout.folded, ...layout.drawn];
    const height = track.clientHeight;
    // Clusters never mix folded and drawn prompts.
    const runs = [
      ...clusterTicks(layout.folded.map((f) => f * height)),
      ...clusterTicks(layout.drawn.map((f) => f * height)).map((r) => ({ first: r.first + folded, last: r.last + folded })),
    ];
    const sig = runs.map((r) => `${r.first}-${r.last}|${list[r.first].id}|${firstLine(list[r.first].text)}|${r.first < folded ? "f" : "d"}`).join("\n");
    if (sig !== signature) {
      signature = sig;
      for (const t of ticks) t.el.remove();
      ticks = runs.map((r) => {
        const el = document.createElement("button");
        el.type = "button";
        el.className = r.first < folded ? "ct-outline-tick folded" : "ct-outline-tick";
        el.setAttribute("aria-label", tickLabel(r.first, r.last, list[r.first].text));
        const tick = { el, first: r.first, last: r.last, top: "" };
        el.addEventListener("click", () => jumpToIndex(r.first));
        el.addEventListener("mouseenter", () => showTip(tick));
        el.addEventListener("focus", () => showTip(tick));
        el.addEventListener("mouseleave", hideTip);
        el.addEventListener("blur", hideTip);
        track.append(el);
        return tick;
      });
    }
    for (const t of ticks) {
      const top = `${(fractions[t.first] * 100).toFixed(2)}%`;
      if (top !== t.top) { t.top = top; t.el.style.top = top; }
    }
    divider.hidden = layout.divider === null;
    if (layout.divider !== null) divider.style.top = `${(layout.divider * 100).toFixed(2)}%`;
    mark();
  }

  /** Re-place the ticks (new entries, a row opening, a resize); coalesced to one frame. */
  function schedule() {
    if (!frame) frame = requestAnimationFrame(update);
  }

  function goTo(top) {
    // A press while a smooth scroll is still heading somewhere jumps instantly instead of chasing it.
    const instant = goal !== null || reducedMotion();
    goal = Math.max(0, top);
    clearTimeout(goalTimer);
    goalTimer = setTimeout(() => { goal = null; }, 800);
    scroll.scrollTo({ top: goal, behavior: instant ? "auto" : "smooth" });
  }

  function flash(el) {
    if (!el) return;
    clearTimeout(flashTimer);
    for (const old of root.querySelectorAll(".ct-outline-flash")) old.classList.remove("ct-outline-flash");
    el.classList.add("ct-outline-flash");
    flashTimer = setTimeout(() => el.classList.remove("ct-outline-flash"), 1400);
  }

  /** Scroll a drawn prompt in and flash it. */
  function jumpToId(id) {
    const list = prompts();
    const index = list.findIndex((p) => p.id === id);
    if (index < 0 || !list[index].el) return;
    const own = measure(list);
    goTo(scrollTarget(own[index - list.filter((p) => !p.el).length], scroll.scrollHeight, scroll.clientHeight));
    flash(list[index].el);
  }

  function jumpToIndex(index) {
    const list = prompts();
    if (!list[index]) return;
    if (list[index].el) jumpToId(list[index].id);
    else reveal(list[index].id);
  }

  earlierBtn.addEventListener("click", async () => {
    const act = earlier();
    if (!act || loading) return;
    loading = true;
    const firstId = prompts()[0]?.id;
    try { await act(); } catch { /* the loader reports its own failures */ }
    loading = false;
    if (!alive) return;
    // The first newly loaded prompt, not the top: landing at 0 would fire the load again and chain.
    const list = prompts();
    if (list.length && list[0].id !== firstId) reveal(list[0].id);
  });

  /** Alt+Up / Alt+Down: the previous or next prompt from where the view is (or is heading). Whether it handled the key. */
  function step(direction) {
    if (!visible()) return false;
    const list = prompts();
    const folded = list.filter((p) => !p.el).length;
    offsets = measure(list);
    const from = goal !== null ? goal : scroll.scrollTop;
    const index = stepPrompt(offsets, from, direction, scroll.scrollHeight, scroll.clientHeight);
    if (index >= 0) { jumpToId(list[folded + index].id); return true; }
    if (direction < 0 && folded > 0) { reveal(list[folded - 1].id); return true; }
    return false;
  }

  function onKey(event) {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const target = event.target;
    if (target && target.closest && target.closest("input, textarea, select, [contenteditable]")) return;
    if (step(event.key === "ArrowUp" ? -1 : 1)) { event.preventDefault(); event.stopPropagation(); }
  }
  root.addEventListener("keydown", onKey);
  scroll.addEventListener("scroll", () => { if (!markFrame) markFrame = requestAnimationFrame(mark); }, { passive: true });
  const observer = new ResizeObserver(schedule);
  observer.observe(scroll);
  observer.observe(container());

  return {
    schedule, step, jumpToId,
    destroy() {
      alive = false;
      cancelAnimationFrame(frame);
      cancelAnimationFrame(markFrame);
      clearTimeout(goalTimer);
      clearTimeout(flashTimer);
      observer.disconnect();
      root.removeEventListener("keydown", onKey);
      nav.remove();
    },
  };
}

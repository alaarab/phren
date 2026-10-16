// Prompt outline: a slim rail along the right edge of a long transcript, one
// tick per user prompt. The math is pure (src/ui-chat-outline.test.ts runs it);
// `createOutline` is the DOM around it, driven by timeline-view.js.

export const MIN_PROMPTS = 3;          // fewer prompts than this need no outline
export const MIN_VIEWPORTS = 2;        // the content must be this many screens tall
export const MIN_WIDTH = 520;          // the chat pane's width below which the rail gives way
export const TOP_PAD = 12;             // a jumped-to prompt lands this far below the top edge
const CURRENT_BIAS = 0.25;             // a prompt counts as current once it is in the top quarter

/** Whether the rail is worth showing. `width` is the pane's, `prompts` every loaded prompt. */
export function shouldShow({ prompts, scrollHeight, clientHeight, width = Infinity }) {
  if (!(clientHeight > 0)) return false;
  return prompts >= MIN_PROMPTS && scrollHeight > clientHeight * MIN_VIEWPORTS && width >= MIN_WIDTH;
}

/** Each offset as a 0..1 fraction of the content height. */
export function tickPositions(offsets, total) {
  if (!(total > 0)) return offsets.map(() => 0);
  return offsets.map((offset) => Math.min(1, Math.max(0, offset / total)));
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

const reducedMotion = () => !!(globalThis.matchMedia && globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches);

/**
 * @param {{root: HTMLElement, scroll: HTMLElement,
 *   prompts: () => Array<{id: string, el: HTMLElement, text: string}>,
 *   total: () => number, earlier: () => (null | (() => void))}} opts
 *   `prompts` are the drawn ones, `total` counts every loaded prompt (folded
 *   ones too), `earlier` is the action behind the "↑ earlier" tick (null when
 *   nothing is above).
 */
export function createOutline({ root, scroll, prompts, total, earlier }) {
  const nav = document.createElement("nav");
  nav.className = "ct-outline";
  nav.setAttribute("aria-label", "Prompts");
  nav.hidden = true;
  const earlierBtn = document.createElement("button");
  earlierBtn.type = "button";
  earlierBtn.className = "ct-outline-earlier";
  earlierBtn.textContent = "↑ earlier";
  earlierBtn.setAttribute("aria-label", "Earlier prompts");
  earlierBtn.hidden = true;
  const track = document.createElement("div");
  track.className = "ct-outline-track";
  const tip = document.createElement("div");
  tip.className = "ct-outline-tip";
  tip.setAttribute("aria-hidden", "true");
  tip.hidden = true;
  nav.append(earlierBtn, track, tip);
  root.append(nav);

  let offsets = [];
  let ticks = [];
  let signature = "";
  let frame = 0;
  let markFrame = 0;
  let goal = null;       // the scrollTop a jump is heading for, while it animates
  let goalTimer = 0;
  let flashTimer = 0;

  const container = () => root.closest(".session-doc") || root;
  const visible = () => !nav.hidden && nav.offsetParent !== null && getComputedStyle(nav).display !== "none";

  function measure() {
    const top = scroll.getBoundingClientRect().top - scroll.scrollTop;
    return prompts().map((p) => p.el.getBoundingClientRect().top - top);
  }

  function showTip(index) {
    const list = prompts();
    if (!ticks[index] || !list[index]) return;
    tip.textContent = firstLine(list[index].text, 200);
    tip.hidden = false;
    const navTop = nav.getBoundingClientRect().top;
    const tickRect = ticks[index].getBoundingClientRect();
    tip.style.top = `${tickRect.top - navTop + tickRect.height / 2}px`;
  }
  const hideTip = () => { tip.hidden = true; };

  function mark() {
    markFrame = 0;
    if (nav.hidden) return;
    const current = currentPrompt(offsets, scroll.scrollTop, scroll.clientHeight);
    ticks.forEach((tick, i) => {
      const on = i === current;
      tick.classList.toggle("current", on);
      if (on) tick.setAttribute("aria-current", "true"); else tick.removeAttribute("aria-current");
    });
  }

  function update() {
    frame = 0;
    const list = prompts();
    const show = list.length > 0 && shouldShow({
      prompts: total(), scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight,
      width: container().clientWidth,
    });
    nav.hidden = !show;
    if (!show) { signature = ""; return; }
    // The rail's right edge clears the transcript's own scrollbar.
    nav.style.setProperty("--ct-sb", `${Math.max(0, scroll.offsetWidth - scroll.clientWidth)}px`);
    offsets = measure();
    const fractions = tickPositions(offsets, scroll.scrollHeight);
    earlierBtn.hidden = !earlier();
    const sig = list.map((p) => `${p.id}|${firstLine(p.text)}`).join("\n");
    if (sig !== signature) {
      signature = sig;
      track.replaceChildren();
      ticks = list.map((p, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ct-outline-tick";
        b.setAttribute("aria-label", `Prompt ${i + 1}: ${firstLine(p.text)}`);
        b.addEventListener("click", () => jump(i));
        b.addEventListener("mouseenter", () => showTip(i));
        b.addEventListener("focus", () => showTip(i));
        b.addEventListener("mouseleave", hideTip);
        b.addEventListener("blur", hideTip);
        track.append(b);
        return b;
      });
    }
    fractions.forEach((f, i) => { ticks[i].style.top = `${(f * 100).toFixed(3)}%`; });
    mark();
  }

  /** Re-place the ticks (new entries, a row opening, a resize); coalesced to one frame. */
  function schedule() {
    if (!frame) frame = requestAnimationFrame(update);
  }

  function goTo(top) {
    goal = Math.max(0, top);
    clearTimeout(goalTimer);
    goalTimer = setTimeout(() => { goal = null; }, 800);
    scroll.scrollTo({ top: goal, behavior: reducedMotion() ? "auto" : "smooth" });
  }

  function flash(el) {
    if (!el) return;
    clearTimeout(flashTimer);
    for (const old of root.querySelectorAll(".ct-outline-flash")) old.classList.remove("ct-outline-flash");
    el.classList.add("ct-outline-flash");
    flashTimer = setTimeout(() => el.classList.remove("ct-outline-flash"), 1400);
  }

  function jump(index) {
    const list = prompts();
    if (!list[index]) return;
    offsets = measure();
    goTo(scrollTarget(offsets[index], scroll.scrollHeight, scroll.clientHeight));
    flash(list[index].el);
  }

  earlierBtn.addEventListener("click", () => {
    const act = earlier();
    if (act) act();
    // Whatever the action drew above lands before this frame ends; the top is where the reader goes.
    requestAnimationFrame(() => goTo(0));
  });

  /** Alt+Up / Alt+Down: the previous or next prompt from where the view is (or is heading). */
  function step(direction) {
    if (!visible()) return false;
    offsets = measure();
    const from = goal !== null ? goal : scroll.scrollTop;
    const index = stepPrompt(offsets, from, direction, scroll.scrollHeight, scroll.clientHeight);
    if (index >= 0) jump(index);
    return true;
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
    schedule, step, jump,
    destroy() {
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

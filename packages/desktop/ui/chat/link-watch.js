import { el as node } from "../dom.js";
// A chat's link to its computer: the transcript and status sockets reconnect silently, so a dropped
// computer or SSH link would leave a stale chat that looks live. This watches both sockets and
// reports a view: idle, "reconnecting" (down 3 s, with the seconds), "unreachable" (down 30 s)
// or "back" (reopened, shown 1.5 s). A socket that never connected is not "down" (first connect).
// Plain browser ES module; timers are the globals, so tests can fake them.

export const SHOW_AFTER_MS = 3000;
export const UNREACHABLE_AFTER_MS = 30000;
export const BACK_MS = 1500;

/** @param {{onView:(view:{phase:string,seconds:number})=>void}} opts */
export function createLinkWatch({ onView }) {
  const everUp = new Set();
  const downSince = new Map();
  let phase = "idle";
  let showTimer = null;
  let ticker = null;
  let backTimer = null;
  let destroyed = false;

  const stopTimers = () => {
    if (showTimer) clearTimeout(showTimer);
    if (ticker) clearInterval(ticker);
    if (backTimer) clearTimeout(backTimer);
    showTimer = ticker = backTimer = null;
  };
  const since = () => Math.min(...downSince.values());
  const seconds = () => Math.max(0, Math.floor((Date.now() - since()) / 1000));
  const emit = () => { if (!destroyed) onView({ phase, seconds: phase === "reconnecting" ? seconds() : 0 }); };

  function tick() {
    if (!downSince.size) return;
    if (Date.now() - since() >= UNREACHABLE_AFTER_MS) {
      phase = "unreachable";
      if (ticker) { clearInterval(ticker); ticker = null; }
    } else phase = "reconnecting";
    emit();
  }
  function reveal() {
    showTimer = null;
    if (!downSince.size) return;
    tick();
    if (phase === "reconnecting") ticker = setInterval(tick, 1000);
  }

  return {
    /** A socket is confirmed live (its first frame arrived, or it stayed open). */
    up(name) {
      if (destroyed) return;
      everUp.add(name);
      if (!downSince.delete(name) || downSince.size) return;
      const wasShown = phase === "reconnecting" || phase === "unreachable";
      stopTimers();
      if (!wasShown) { phase = "idle"; return; }
      phase = "back";
      emit();
      backTimer = setTimeout(() => { backTimer = null; phase = "idle"; emit(); }, BACK_MS);
    },
    /** A socket closed. Ignored until it has been live once. */
    down(name) {
      if (destroyed || !everUp.has(name) || downSince.has(name)) return;
      const wasEmpty = !downSince.size;
      downSince.set(name, Date.now());
      if (!wasEmpty) return;
      if (backTimer) { clearTimeout(backTimer); backTimer = null; phase = "idle"; emit(); }
      if (phase === "idle") showTimer = setTimeout(reveal, SHOW_AFTER_MS);
    },
    /** Stops every timer; later reports are ignored (the chat closed). */
    destroy() { destroyed = true; stopTimers(); },
  };
}

/** The amber strip above the composer. `update(view)` fills or empties it. */
export function createLinkStrip({ computer, onRetry }) {
  const el = node("div", "chat-link");
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  const text = node("span", "chat-link-text");
  const retry = node("button", "chat-link-retry");
  retry.type = "button";
  retry.textContent = "Retry";
  retry.addEventListener("click", () => onRetry());
  el.append(text, retry);
  el.hidden = true;
  return {
    el,
    update({ phase, seconds }) {
      el.hidden = phase === "idle";
      el.dataset.phase = phase;
      retry.hidden = phase !== "unreachable";
      text.textContent = phase === "reconnecting" ? `Reconnecting to ${computer}… ${seconds}s`
        : phase === "unreachable" ? `Can't reach ${computer}`
        : phase === "back" ? "Back online" : "";
    },
  };
}

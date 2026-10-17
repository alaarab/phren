// The window title: "(N) <chat title> — Phren" while a chat is the active tab, "(N) <Section> — Phren"
// otherwise, "Phren" alone before anything is shown. N is the needs-you count and is left off at zero.
// The Electron window follows `document.title` (the shell never sets its own after creation), so the
// macOS title/dock and the Windows taskbar show this too. Kept short: chat titles clip at 60 characters.

export const TITLE_MAX = 60;
const APP = "Phren";

/** One line, trimmed, at most `max` characters with a trailing ellipsis when clipped. */
export function clipTitle(text, max = TITLE_MAX) {
  const line = String(text ?? "").replace(/\s+/g, " ").trim();
  const chars = [...line];
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : line;
}

/** The title for a needs-you count, the active chat's title (or null) and the section's label (or null). */
export function windowTitle({ needs = 0, chat = null, section = null } = {}) {
  const prefix = needs > 0 ? `(${needs}) ` : "";
  const name = clipTitle(chat) || clipTitle(section);
  return name ? `${prefix}${name} — ${APP}` : `${prefix}${APP}`;
}

/**
 * Keep `document.title` current. `read()` returns `{ needs, chat, section }` now; the title is
 * rewritten on `refresh()`, on the `phren:tabs-changed` event (tab switch, chat rename, last tab
 * closed) and when the window gains focus. Section and store changes call `refresh()` from app.js.
 */
export function startWindowTitle(read, doc = document, win = window) {
  let queued = false;
  function apply() {
    queued = false;
    const next = windowTitle(read());
    if (doc.title !== next) doc.title = next;
  }
  // Deferred a microtask so the tab and overview listeners that ran first have settled.
  function refresh() {
    if (queued) return;
    queued = true;
    queueMicrotask(apply);
  }
  doc.addEventListener("phren:tabs-changed", refresh);
  win.addEventListener("focus", refresh);
  apply();
  return { refresh };
}

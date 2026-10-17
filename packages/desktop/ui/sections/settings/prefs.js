// Settings preferences kept in localStorage, read by the pages and by app.js.
export const TRANSCRIPT_KEY = "phren.desktop.transcriptSize";
export const SIDEBAR_ROWS_KEY = "phren.desktop.sidebarRows";
export const NOTIFY_KEY = "phren.desktop.notify";
export const BADGE_KEY = "phren.desktop.badge";
export const CI_KEY = "phren.desktop.notify-ci";
export const PR_KEY = "phren.desktop.notify-pr";
export const STALL_KEY = "phren.desktop.notify-stalled";
export const RECENT_KEY = "phren.desktop.recent-switch";
export const TITLE_CHAT_KEY = "phren.desktop.title-chat";
export const SIZES = [12, 13, 14];

// ------------------------------------------------------------ preferences
export function readFlag(key, fallback = true) {
  try { const value = localStorage.getItem(key); return value === null ? fallback : value !== "0"; }
  catch { return fallback; }
}

export function writeFlag(key, on) {
  try { localStorage.setItem(key, on ? "1" : "0"); } catch { /* private window: this session only */ }
}

export function notifyEnabled() { return readFlag(NOTIFY_KEY); }
export function stallNotifyEnabled() { return readFlag(STALL_KEY); }
export function badgeEnabled() { return readFlag(BADGE_KEY); }
export function ciNotifyEnabled() { return readFlag(CI_KEY); }
export function prNotifyEnabled() { return readFlag(PR_KEY); }
export function titleChatEnabled() { return readFlag(TITLE_CHAT_KEY); }
export function recentSwitchEnabled() { return readFlag(RECENT_KEY); }

export function readTranscriptSize() {
  try { const value = Number(localStorage.getItem(TRANSCRIPT_KEY)); return SIZES.includes(value) ? value : 13; }
  catch { return 13; }
}

export function applyTranscriptSize(px) {
  document.documentElement.style.setProperty("--transcript-size", `${px}px`);
}
applyTranscriptSize(readTranscriptSize());

export function readSidebarRows() {
  try { return localStorage.getItem(SIDEBAR_ROWS_KEY) === "compact" ? "compact" : "detailed"; }
  catch { return "detailed"; }
}

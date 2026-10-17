// The menu bar (tray) icon: the Electron shell draws it, this module feeds it
// the sessions that need you (a chosen row comes back as phren:open-session,
// handled with notifications in needs-notify.js). On a Mac,
// closing the window while the icon is on only hides it, so this keeps running.
import { approvals } from "./approvals.js";
import { projectOf, store } from "./store.js";
import { muted, unmutedRows } from "./muted.js";

const KEY = "phren.desktop.tray";
const MAX_ROWS = 12;

export function trayEnabled() {
  try { return localStorage.getItem(KEY) !== "0"; } catch { return true; }
}

/** Why a row needs you, in the words of its menu line. */
function reason(child) {
  if (child.approvalPending) return "wants approval";
  if (child.agentStatus === "blocked") return "is blocked";
  return "is waiting for you";
}

/** What the shell draws: up to twelve rows (oldest first, as store.needsYou()
 * lists them) and how many more there are. A row with a known pending approval
 * (`approvalOf(key)`) carries its summary, and the shell offers
 * Allow / Deny for it. */
export function trayState(rows, enabled, approvalOf = () => undefined) {
  if (!enabled) return { enabled: false };
  const shown = rows.slice(0, MAX_ROWS).map(({ key, computer, child }) => {
    const project = projectOf(child);
    const name = child.title ?? child.label ?? "Session";
    const row = { key, title: project && project !== name ? `${project}: ${name}` : name, sub: `${computer} · ${reason(child)}` };
    const approval = child.approvalPending ? approvalOf(key) : undefined;
    return approval ? { ...row, approval: approval.summary, actionId: approval.actionId } : row;
  });
  return { enabled: true, rows: shown, more: Math.max(0, rows.length - shown.length) };
}

let push = () => {};

/** Turn the icon on or off from Settings. */
export function setTrayEnabled(on) {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* private window: this session only */ }
  push();
}

/** Whether this window has a shell that can draw the icon (Electron, not a browser). */
export function trayAvailable() { return !!window.phrenDesktop?.setTray; }

export function startTray(shell) {
  if (!shell?.setTray) return;
  let last = "";
  push = () => {
    const rows = unmutedRows(store.needsYou(), muted.keys());
    const state = trayState(rows, trayEnabled(), (key) => approvals.approval(key));
    const json = JSON.stringify(state);
    if (json === last) return;
    last = json;
    shell.setTray(state);
  };
  store.subscribe(push);
  approvals.subscribe(() => push());
  push();
  // The menu answers the action it showed; a replaced one is refused (answerKey checks the id).
  shell.onTrayAnswer?.(({ key, decision, actionId }) => { void approvals.answerKey(key, decision, undefined, actionId); });
}

// Pending approvals belong to the app, so the menu bar can answer without
// mounting Home. The overview selects the same per-session status watchers
// Home used to own; no receipt or schedule polling belongs here.
import { targetQuery } from "../api.js";
import { answerApproval } from "../chat/answers.js";
import { needsYou, store } from "./store.js";

const pending = new Map(); // row.key -> { actionId, summary }
const watchers = new Map(); // row.key -> WebSocket
const listeners = new Set();
let unsubscribe = null;
const emit = () => { for (const fn of listeners) fn(); };

function summaryOf(approval) {
  const text = approval.title || approval.command || approval.reason || approval.request || approval.tool;
  return text ? String(text).slice(0, 160) : "Approval required";
}

function watchApproval(row) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/hosts/${encodeURIComponent(row.computer)}/v1/status?${targetQuery(row.child.target)}`);
  ws.addEventListener("message", (event) => {
    if (watchers.get(row.key) !== ws) return;
    let frame;
    try { frame = JSON.parse(event.data); } catch { return; }
    const approval = frame?.agentStatus?.pendingApproval;
    if (approval?.actionId) pending.set(row.key, { actionId: String(approval.actionId), summary: summaryOf(approval) });
    else pending.delete(row.key);
    emit();
  });
  ws.addEventListener("close", () => {
    if (watchers.get(row.key) !== ws) return;
    watchers.delete(row.key);
    pending.delete(row.key);
    emit();
  });
  return ws;
}

function syncWatchers(value) {
  const wanted = new Map(needsYou(value).filter((row) => row.child.approvalPending && row.child.target).map((row) => [row.key, row]));
  for (const [key, ws] of watchers) {
    if (wanted.has(key)) continue;
    watchers.delete(key);
    pending.delete(key);
    try { ws.close(); } catch { /* already closing */ }
  }
  for (const [key, row] of wanted) if (!watchers.has(key)) watchers.set(key, watchApproval(row));
  emit();
}

export const approvals = {
  approval(key) { return pending.get(key); },
  async answerKey(key, decision, scope) {
    const row = store.needsYou().find((r) => r.key === key);
    const info = pending.get(key);
    if (!info || !row?.child.target) return;
    try {
      await answerApproval(row.computer, row.child.target, { actionId: info.actionId, decision, ...(scope ? { scope } : {}) });
    } catch { /* the Hook may no longer be holding the approval */ }
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

/** Started once by app.js, independently of Home and the Electron tray. */
export function startApprovals() {
  if (unsubscribe) return;
  unsubscribe = store.subscribe(syncWatchers);
}

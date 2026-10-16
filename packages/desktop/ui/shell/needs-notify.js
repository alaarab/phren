// Native notifications for sessions that start needing you. Clicking one opens
// that session; on a Mac, one for an agent that finished its turn and waits on
// you takes a typed reply, sent to its pane as the next prompt.
import { redactNotice } from "../redact.js";
import { approvals } from "./approvals.js";
import { hookPost } from "../api.js";
import { projectOf, sessions, store } from "./store.js";
import { newlyStalled, stalledMinutes } from "./stalls.js";
import { snoozes } from "./snooze.js";

/** What the shell shows for a needs-you row. Only a plain wait takes a reply:
 * an approval or a blocked agent needs its own card, not more text. */
export function needsNotice({ key, computer, child }, { stillWaiting = false } = {}) {
  return {
    title: redactNotice(stillWaiting ? `Still waiting: ${child.title ?? child.label ?? projectOf(child)}` : `${projectOf(child)} needs you`),
    body: redactNotice(`${child.title ?? child.label} · ${computer}${child.lastReply ? `\n${child.lastReply}` : ""}`),
    key,
    reply: child.agentStatus === "waiting" && !child.approvalPending && !!child.target,
  };
}

/** The notification for a session that just stalled. */
export function stalledNotice({ key, computer, child }) {
  return { title: `${projectOf(child)} stalled`, body: `No output for ${stalledMinutes(child)} min · ${child.title ?? child.label} · ${computer}`, key };
}

/** Send a notification's reply to its session. Resolves to an error line, or "" once the Hook took it. */
export async function sendReply(key, text, { find = (k) => store.sessions({ includeOffline: true }).find((s) => s.key === k), post = hookPost, expected } = {}) {
  const row = find(key);
  if (!row?.child.target) return "That session is gone.";
  if (expected && !sameBinding(expected, replyBinding(row.child))) return "That session has changed. Open it to reply.";
  try {
    await post(row.computer, "/v1/prompt", { target: expected?.target ?? row.child.target, text, deliveryId: crypto.randomUUID() });
    return "";
  } catch (err) {
    return err?.message || "The Hook did not take it.";
  }
}

// Capture a copy: later overview frames can reuse the tab with a new agent.
function replyBinding(child) {
  return { target: { ...child.target }, id: child.id, sessionId: child.sessionId, conversationId: child.conversationId };
}

function sameBinding(a, b) {
  const sameTarget = a.target && Object.keys({ ...a.target, ...b.target }).every((key) => a.target[key] === b.target[key]);
  return sameTarget && a.id === b.id && a.sessionId === b.sessionId && a.conversationId === b.conversationId;
}

export function startNeedsNotify(shell, { enabled, stallsEnabled = enabled, openSession, openPulls = openSession }) {
  if (!shell) return;
  let notified = null; // keys already announced; null until the first frame
  let stalled = null; // keys already reported stalled; null until the first frame
  const baselineApprovals = new Set();
  // A snoozed chat whose time ran out gets one deliberate "Still waiting" reminder
  // when it returns. Snoozing, Wake now (the owner is looking) and a row that
  // changed meanwhile (an ordinary new notice) do not.
  const woken = new Set();
  const hushed = new Set();
  snoozes.onWake((keys, why) => { for (const key of keys) (why === "time" ? woken : hushed).add(key); });
  const announcedApprovals = new Map(); // session key -> action IDs, retained through temporary gaps
  function noticeKey(row) {
    if (!row.child.approvalPending) return row.key;
    const actionId = approvals.approval(row.key)?.actionId;
    return actionId ? JSON.stringify([row.key, actionId]) : null;
  }
  function updateNeeds() {
    if (!store.merged) return;
    const rows = store.needsYou();
    const cached = new Map(store.sessions({ includeOffline: true }).map((row) => [row.key, row]));
    for (const key of new Set([...announcedApprovals.keys(), ...baselineApprovals])) {
      const row = cached.get(key);
      const online = store.merged.computers.some((c) => c.computer === row?.computer && c.state === "online");
      if (!row || (online && !row.child.approvalPending)) {
        announcedApprovals.delete(key);
        baselineApprovals.delete(key);
      }
    }
    function remember(row) {
      const actionId = approvals.approval(row.key)?.actionId;
      if (!row.child.approvalPending || !actionId) return false;
      if (!announcedApprovals.has(row.key)) announcedApprovals.set(row.key, new Set());
      const seen = announcedApprovals.get(row.key);
      const known = seen.has(actionId);
      seen.add(actionId);
      return known;
    }
    if (notified === null) {
      for (const row of rows) {
        if (row.child.approvalPending && !noticeKey(row)) baselineApprovals.add(row.key);
        remember(row);
      }
    } else {
      for (const row of rows) {
        const id = noticeKey(row);
        if (!id || remember(row) || notified.has(id)) continue;
        if (baselineApprovals.delete(row.key)) continue;
        if (hushed.delete(row.key)) continue;
        if (enabled()) {
          const { title, body, key, reply } = needsNotice(row, { stillWaiting: woken.has(row.key) });
          shell.notify(title, body, { key, reply, ...(reply ? { binding: replyBinding(row.child) } : {}) });
        }
      }
    }
    for (const row of rows) woken.delete(row.key);
    notified = new Set(rows.map(noticeKey).filter(Boolean));
  }
  store.subscribe((merged) => {
    const all = sessions(merged);
    if (stalled && stallsEnabled()) {
      for (const row of newlyStalled(all, stalled)) {
        const { title, body, key } = stalledNotice(row);
        shell.notify(title, body, { key });
      }
    }
    stalled = new Set(all.filter((r) => stalledMinutes(r.child) !== null).map((r) => r.key));
    updateNeeds();
  });
  approvals.subscribe(updateNeeds);
  shell.onOpenSession?.((key) => {
    // `pulls:<session key>` is a pull request notification: open Changes > PRs.
    const pulls = key.startsWith("pulls:");
    const wanted = pulls ? key.slice(6) : key;
    const row = store.sessions({ includeOffline: true }).find((s) => s.key === wanted);
    if (row) (pulls ? openPulls : openSession)(row.computer, row.child);
  });
  shell.onReply?.(async ({ key, text, binding }) => {
    const error = binding ? await sendReply(key, text, { expected: binding }) : "That session is gone.";
    if (error) shell.notify("Reply not sent", error);
  });
}

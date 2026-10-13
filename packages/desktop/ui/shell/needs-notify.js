// Native notifications for sessions that start needing you. Clicking one opens
// that session; on a Mac, one for an agent that finished its turn and waits on
// you takes a typed reply, sent to its pane as the next prompt.
import { hookPost } from "../api.js";
import { projectOf, sessions, store } from "./store.js";
import { newlyStalled, stalledMinutes } from "./stalls.js";

/** What the shell shows for a needs-you row. Only a plain wait takes a reply:
 * an approval or a blocked agent needs its own card, not more text. */
export function needsNotice({ key, computer, child }) {
  return {
    title: `${projectOf(child)} needs you`,
    body: `${child.title ?? child.label} · ${computer}${child.lastReply ? `\n${child.lastReply}` : ""}`,
    key,
    reply: child.agentStatus === "waiting" && !child.approvalPending && !!child.target,
  };
}

/** The notification for a session that just stalled. */
export function stalledNotice({ key, computer, child }) {
  return { title: `${projectOf(child)} stalled`, body: `No output for ${stalledMinutes(child)} min · ${child.title ?? child.label} · ${computer}`, key };
}

/** Send a notification's reply to its session. Resolves to an error line, or "" once the Hook took it. */
export async function sendReply(key, text, { find = (k) => store.sessions().find((s) => s.key === k), post = hookPost } = {}) {
  const row = find(key);
  if (!row?.child.target) return "That session is gone.";
  try {
    await post(row.computer, "/v1/prompt", { target: row.child.target, text, deliveryId: crypto.randomUUID() });
    return "";
  } catch (err) {
    return err?.message || "The Hook did not take it.";
  }
}

export function startNeedsNotify(shell, { enabled, stallsEnabled = enabled, openSession }) {
  if (!shell) return;
  let notified = null; // keys already announced; null until the first frame
  let stalled = null; // keys already reported stalled; null until the first frame
  store.subscribe((merged) => {
    const all = sessions(merged);
    if (stalled && stallsEnabled()) {
      for (const row of newlyStalled(all, stalled)) {
        const { title, body, key } = stalledNotice(row);
        shell.notify(title, body, { key });
      }
    }
    stalled = new Set(all.filter((r) => stalledMinutes(r.child) !== null).map((r) => r.key));
    const rows = store.needsYou();
    if (notified && enabled()) {
      for (const row of rows) {
        if (notified.has(row.key)) continue;
        const { title, body, key, reply } = needsNotice(row);
        shell.notify(title, body, { key, reply });
      }
    }
    notified = new Set(rows.map((r) => r.key));
  });
  shell.onOpenSession?.((key) => {
    const row = store.sessions().find((s) => s.key === key);
    if (row) openSession(row.computer, row.child);
  });
  shell.onReply?.(async ({ key, text }) => {
    const error = await sendReply(key, text);
    if (error) shell.notify("Reply not sent", error);
  });
}

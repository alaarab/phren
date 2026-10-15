import { exhausted, usedPercent, windowNames } from "./usage-windows.js";
// Observe the titlebar's shared usage poll; no additional timer or Hook reads.
import { accountTitles, followUsage } from "./usage-rings.js";
import { loadQuotaState, quotaSettings } from "./quota-warn-prefs.js";

const COOLDOWN_MS = 10 * 60_000;
const known = (w) => w.reset || exhausted(w) || usedPercent(w) !== null;
/** Pure poll-to-poll transitions. Stale data retains the last known exhaustion. */
export function quotaBackTransitions(state, snapshot, now = Date.now()) {
  const previous = new Map();
  const notified = new Map([...(state?.notified ?? [])].filter(([, at]) => now - at < COOLDOWN_MS));
  const present = new Set();
  const notices = [];
  const titles = accountTitles(snapshot?.accounts);
  for (const row of snapshot?.accounts ?? []) {
    const windows = row.windows ?? [];
    // The merger marks explicit elapsed resets stale too: those are known room.
    const stale = row.stale && !windows.some((w) => w.reset);
    const blocked = windows.filter(exhausted);
    for (const computer of row.computers ?? []) {
      const key = JSON.stringify([computer.name, row.harness, row.id, computer.account ?? ""]);
      present.add(key);
      const before = state?.previous?.get(key);
      if (stale) {
        if (before?.length) previous.set(key, before);
        continue;
      }
      if (!windows.length || !windows.every(known) || snapshot.unreachable?.some((u) => u.computer === computer.name)) continue;
      previous.set(key, blocked);
      if (!before?.length || blocked.length || exhausted(row) || !before.every((w) => windows.some((next) => next.id === w.id && known(next)))) continue;
      if (now - (notified.get(key) ?? -Infinity) < COOLDOWN_MS) continue;
      notified.set(key, now);
      const labels = [...new Set(before.map((w) => windowNames[w.id]?.replace("weekly", "Weekly") || w.name || w.id))];
      notices.push({ title: `${titles.get(row.id) ?? row.name ?? row.harness} is available again`, body: `${labels.join(" and ")} limit reset on ${computer.name}` });
    }
  }
  for (const key of notified.keys()) if (!present.has(key)) notified.delete(key);
  return { state: { previous, notified }, notices };
}

/** Start once from app.js; disabled/quiet transitions are consumed without replay. */
export function startQuotaBack({ notify, enabled }) {
  if (!notify) return () => {};
  let state;
  let ready = false;
  let loading = null;
  return followUsage((snapshot) => {
    if (!snapshot) return;
    if (!ready && !loading) loading = loadQuotaState().then(() => { ready = true; }).catch(() => {}).finally(() => { loading = null; });
    const result = quotaBackTransitions(state, snapshot);
    state = result.state;
    if (ready && quotaSettings().backOn && enabled()) for (const notice of result.notices) notify(notice.title, notice.body);
  });
}

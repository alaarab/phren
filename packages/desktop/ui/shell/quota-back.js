// Observe the titlebar's shared usage poll; no additional timer or Hook reads.
import { accountTitles, followUsage } from "./usage-rings.js";
import { loadQuotaState, quotaSettings } from "./quota-warn-prefs.js";

const COOLDOWN_MS = 10 * 60_000;
const names = { five_hour: "5-hour", seven_day: "Weekly", "codex:primary": "5-hour", "codex:secondary": "Weekly" };
const exhausted = (w) => !w.reset && (w.exhausted === true || w.limited === true || w.usedPercent >= 100 || w.leftPercent === 0);
const known = (w) => w.reset || exhausted(w) || Number.isFinite(w.usedPercent) || Number.isFinite(w.leftPercent);

/** Pure poll-to-poll transitions. Missing data forgets the baseline, never the cooldown. */
export function quotaBackTransitions(state, snapshot, now = Date.now()) {
  const previous = new Map();
  const notified = new Map(state?.notified ?? []);
  const notices = [];
  const titles = accountTitles(snapshot?.accounts);
  for (const row of snapshot?.accounts ?? []) {
    const windows = row.windows ?? [];
    // The merger marks explicit elapsed resets stale too: those are known room.
    if (!windows.length || row.stale && !windows.some((w) => w.reset) || !windows.every(known)) continue;
    const blocked = windows.filter(exhausted);
    for (const computer of row.computers ?? []) {
      if (snapshot.unreachable?.some((u) => u.computer === computer.name)) continue;
      const key = JSON.stringify([computer.name, row.harness, row.id, computer.account ?? ""]);
      previous.set(key, blocked);
      const before = state?.previous?.get(key);
      if (!before?.length || blocked.length || row.exhausted || !before.every((w) => windows.some((next) => next.id === w.id && known(next)))) continue;
      if (now - (notified.get(key) ?? -Infinity) < COOLDOWN_MS) continue;
      notified.set(key, now);
      const labels = [...new Set(before.map((w) => names[w.id] || w.name || w.id))];
      notices.push({ title: `${titles.get(row.id) ?? row.name ?? row.harness} is available again`, body: `${labels.join(" and ")} limit reset on ${computer.name}` });
    }
  }
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

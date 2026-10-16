// What was saved to memory or tasks today (the local day), for Home's "Saved today" card.
// Tasks carry a creation instant; findings carry only the Hook's UTC date, so they show "today".
export const SAVED_TODAY_ROWS = 8;

/** The local midnight that starts `now`'s day, and the next one. */
export function dayBounds(now) {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  return [start, end];
}

/**
 * The UTC calendar dates the local day [midnight, next midnight) spans: one or two. The Hook writes a
 * finding's `created` as a UTC date, so a finding is from today when its date is one of these.
 */
export function utcDatesOfDay(now) {
  const [start, end] = dayBounds(now);
  return new Set([new Date(start).toISOString().slice(0, 10), new Date(end - 1).toISOString().slice(0, 10)]);
}

/**
 * Entries saved today, newest first. An entry is `{ kind, key, created, dedupe?, rank? }` where `created` is
 * an ISO instant (tasks) or the Hook's YYYY-MM-DD UTC date (findings). Entries sharing a `dedupe` key (the
 * same item seen from several computers) collapse to the lowest `rank`. Date-only entries follow the timed
 * ones in their given order, since their time of day is not known.
 */
export function savedToday(entries, now = Date.now()) {
  const [start, end] = dayBounds(now);
  const dates = utcDatesOfDay(now);
  const best = new Map();
  entries.forEach((entry, index) => {
    if (!entry.dedupe) return;
    const kept = best.get(entry.dedupe);
    if (!kept || (entry.rank ?? 0) < (kept.rank ?? 0)) best.set(entry.dedupe, entry);
  });
  const timed = [];
  const dated = [];
  entries.forEach((entry, index) => {
    if (entry.dedupe && best.get(entry.dedupe) !== entry) return;
    const created = String(entry.created ?? "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(created)) {
      if (dates.has(created)) dated.push({ ...entry, at: null, index });
      return;
    }
    const at = Date.parse(created);
    if (Number.isFinite(at) && at >= start && at < end) timed.push({ ...entry, at, index });
  });
  timed.sort((a, b) => b.at - a.at || a.index - b.index);
  return [...timed, ...dated];
}

/** "just now", "12 min ago", "3 h ago"; "today" when only the date is known. */
export function savedAgo(at, now = Date.now()) {
  if (at === null || at === undefined) return "today";
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

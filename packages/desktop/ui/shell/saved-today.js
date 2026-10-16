// What was saved to memory or tasks today (the local day), for Home's "Saved today" card.
// Tasks carry a creation instant; findings carry only a YYYY-MM-DD date, so they show "today".
export const SAVED_TODAY_ROWS = 8;

const pad = (n) => String(n).padStart(2, "0");
/** The local calendar day as YYYY-MM-DD. */
export function localDay(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** The local midnight that starts `now`'s day, and the next one. */
export function dayBounds(now) {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  return [start, end];
}

/**
 * Entries saved today, newest first. An entry is `{ kind, key, created, ... }` where `created` is an
 * ISO instant (tasks) or a YYYY-MM-DD date (findings). Date-only entries follow the timed ones in their
 * given order, since their time of day is not known.
 */
export function savedToday(entries, now = Date.now()) {
  const [start, end] = dayBounds(now);
  const today = localDay(now);
  const timed = [];
  const dated = [];
  entries.forEach((entry, index) => {
    const created = String(entry.created ?? "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(created)) {
      if (created === today) dated.push({ ...entry, at: null, index });
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

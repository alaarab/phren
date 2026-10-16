// Date and age wording shared by the sections. Plain browser ES module.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 7" from an ISO date or a YYYY-MM-DD heading date; "" when it has none. */
export function shortDate(value) {
  const match = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return "";
  return `${MONTHS[Number(match[2]) - 1] ?? "?"} ${Number(match[3])}`;
}

/** "Oct 7" for an ISO instant, read in UTC; "" when it does not parse. */
export function dayUTC(iso) {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}` : "";
}

/** "now", "5m ago", "3h ago", "2d ago" from an ISO time or epoch ms; `suffix` "" gives the compact "3h". */
export function age(value, suffix = " ago", now = Date.now()) {
  if (value === null || value === undefined || value === "") return "";
  const t = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(t)) return "";
  const seconds = Math.max(0, (now - t) / 1000);
  if (seconds < 10) return "now";
  if (seconds < 60) return Math.floor(seconds) + "s" + suffix;
  if (seconds < 3600) return Math.floor(seconds / 60) + "m" + suffix;
  if (seconds < 86400) return Math.floor(seconds / 3600) + "h" + suffix;
  return Math.floor(seconds / 86400) + "d" + suffix;
}

/** `age`, or "today" when a finding only has a date (`at` null). */
export function savedAgo(at, now = Date.now()) {
  return at === null || at === undefined ? "today" : age(at, " ago", now);
}

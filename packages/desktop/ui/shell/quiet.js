// Quiet hours: a daily window (local time, may cross midnight) in which the
// desktop shows no notifications. The badge, the tray and Home still count
// what needs you; what arrived meanwhile is not announced afterwards.

const KEY = "phren.desktop.quiet";
const DEFAULT = { on: false, from: "22:00", to: "07:00" };

const minutes = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Whether `date` falls in [from, to); a window like 22:00–07:00 crosses midnight. Equal ends mean never. */
export function inQuietHours(date, from, to) {
  const start = minutes(from), end = minutes(to);
  if (start === null || end === null || start === end) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export function quietSettings() {
  try { return { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") }; } catch { return { ...DEFAULT }; }
}

export function saveQuietSettings(next) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...quietSettings(), ...next })); } catch { /* private window: this session only */ }
}

/** True while quiet hours are on and now is inside them. */
export function quietNow(date = new Date()) {
  const q = quietSettings();
  return q.on && inQuietHours(date, q.from, q.to);
}

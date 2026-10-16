export const windowNames = { five_hour: "5-hour", seven_day: "weekly", "codex:primary": "5-hour", "codex:secondary": "weekly" };
// An explicit false wins over percentages; rounded room and limited never prove exhaustion.
export function exhausted(value) {
  if (!value || value.reset) return false;
  return value.exhausted === true || (value.windows
    ? value.windows.some(exhausted)
    : value.exhausted === undefined && value.usedPercent >= 100);
}
export const usedPercent = (w) => Number.isFinite(w?.usedPercent) ? w.usedPercent : Number.isFinite(w?.leftPercent) ? 100 - w.leftPercent : null;
export const leftPercent = (w) => w ? exhausted(w) ? 0 : usedPercent(w) === null ? null : Math.max(0, 100 - usedPercent(w)) : null;
export const activeWindow = (w, now) => !w.reset && !(Date.parse(w.resetsAt) <= now);
/** Tightest known active window; ties retain report order. */
export function limitingWindow(account, now) {
  return (account?.windows ?? []).filter((w) => activeWindow(w, now) && (exhausted(w) || usedPercent(w) !== null))
    .reduce((best, w) => !best || leftPercent(w) < leftPercent(best) ? w : best, null);
}
function usageConstraint(value) {
  const windows = value?.windows ?? (value ? [value] : []);
  return [Number(exhausted(value)), Math.max(-1, ...windows.filter((w) => !w.reset).map((w) => usedPercent(w) ?? -1))];
}
export function compareUsage(a, b) {
  const x = usageConstraint(a), y = usageConstraint(b);
  return y[0] - x[0] || y[1] - x[1];
}
/** Warning wording: ceil minutes below 24 hours, then local weekday and time. */
export function resetLabel(w, now = Date.now(), { clock = false } = {}) {
  if (w?.reset) return "";
  const reset = Date.parse(w?.resetsAt);
  if (Number.isFinite(reset) && reset > now) {
    if (clock) {
      const date = new Date(reset);
      const time = date.toLocaleTimeString("en-US", { hour: "numeric", ...(date.getMinutes() ? { minute: "2-digit" } : {}), hour12: true });
      const day = date.toDateString() === new Date(now).toDateString() ? "" : date.toLocaleDateString("en-US", { weekday: "short" }) + " ";
      return `resets ${day}${time}`;
    }
    const minutes = Math.ceil((reset - now) / 60_000);
    if (minutes < 1440) {
      const hours = Math.floor(minutes / 60), rest = minutes % 60;
      return `resets in ${[hours ? `${hours}h` : "", rest ? `${rest}m` : ""].filter(Boolean).join(" ")}`;
    }
    const date = new Date(reset);
    return `resets ${date.toLocaleDateString("en-GB", { weekday: "short" })} ${date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  }
  return w?.resetsIn ? `resets in ${w.resetsIn}` : "reset time unknown";
}
const dayLocal = (iso) => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? `${d.toLocaleDateString("en-US", { month: "short" })} ${d.getDate()}` : "";
};
const dollars = (value) => `$${value.toFixed(2)}`;
const isCredit = (w) => typeof w.id === "string" && w.id.startsWith("credit:");
export function windowText(w, now = Date.now()) {
  const used = usedPercent(w);
  const credit = isCredit(w);
  const value = (credit || used === null) && w.usedUSD !== undefined
    ? `${dollars(w.usedUSD)}${w.limitUSD !== undefined ? ` of ${dollars(w.limitUSD)}` : ""}`
    : w.reset ? "reset" : used !== null ? `${Math.round(used * 10) / 10}%` : "unknown";
  let when = "";
  if (credit) {
    if (w.resetsAt && dayLocal(w.resetsAt)) when = `${Date.parse(w.resetsAt) > now ? "expires" : "expired"} ${dayLocal(w.resetsAt)}`;
  } else if (!w.reset) {
    when = w.id === "five_hour" && !w.resetsAt && !w.resetsIn ? "not started" : resetLabel(w, now);
  }
  const caption = [w.exhausted ? "Exhausted" : w.limited ? "Limit reached" : "", when || (!w.reset ? "reset time unknown" : "")].filter(Boolean).join(" · ");
  return { value, caption, used };
}

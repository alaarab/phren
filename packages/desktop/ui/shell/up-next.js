// Home's "Up next": the scheduled prompts each computer will fire soon, from the
// `/v1/schedules` answers Home already reads for its Finished block (no extra
// Hook calls). Only the owning Hook reports `nextRun`, so a schedule appears
// once, under the computer that runs it.

export const UP_NEXT_HOURS = 12;
export const UP_NEXT_COUNT = 4;

const two = (n) => String(n).padStart(2, "0");

/** The enabled, idle schedules due within `hours`, soonest first, at most `limit`.
 *  `byComputer`: a Map (or [computer, schedules[]] pairs) of the Hooks' answers. */
export function upNext(byComputer, now = Date.now(), { hours = UP_NEXT_HOURS, limit = UP_NEXT_COUNT } = {}) {
  const horizon = now + hours * 3_600_000;
  const out = [];
  for (const [computer, schedules] of byComputer ?? []) {
    for (const schedule of Array.isArray(schedules) ? schedules : []) {
      if (!schedule || schedule.owned === false || schedule.enabled === false || schedule.running) continue;
      const at = Date.parse(schedule.nextRun ?? "");
      if (!Number.isFinite(at) || at <= now || at > horizon) continue;
      out.push({ key: `${computer}\u001f${schedule.project}\u001f${schedule.id}`, computer, schedule, at });
    }
  }
  return out.sort((a, b) => a.at - b.at || String(a.schedule.name).localeCompare(String(b.schedule.name))).slice(0, limit);
}

/** "in 5m", "in 2h 10m", "in 3h": how long until a run. */
export function untilLabel(at, now = Date.now()) {
  const minutes = Math.max(1, Math.ceil((at - now) / 60_000));
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `in ${hours}h ${rest}m` : `in ${hours}h`;
}

/** The local wall-clock time of a run, "21:30", with "tomorrow" when it is not today. */
export function clockLabel(at, now = Date.now()) {
  const date = new Date(at);
  const today = new Date(now);
  const time = `${two(date.getHours())}:${two(date.getMinutes())}`;
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  return sameDay ? time : `tomorrow ${time}`;
}

/** The prompt's first non-empty line, for the row's sub line. */
export function promptLine(schedule, max = 140) {
  const line = String(schedule?.prompt ?? "").split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

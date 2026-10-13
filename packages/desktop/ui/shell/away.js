// "Since you left": the turns agents finished while this window was hidden or
// in the background. Away starts when the window loses focus or is hidden;
// coming back after at least a minute away with finished turns or settled
// checks publishes them to Home until dismissed (or the next time away).
import { onChecksSettled } from "./ci-watch.js";
import { sessions, store } from "./store.js";

export const MIN_AWAY_MS = 60_000;
const MAX_ROWS = 20;

/** Rows whose turn ended between two looks: working before, anything else now. */
export function endedTurns(before, rows) {
  return rows.filter((row) => before.get(row.key) === "working" && row.child.agentStatus !== "working");
}

/** The away tracker, separate from the DOM so tests can drive it. */
export function createAway({ now = Date.now } = {}) {
  let awaySince = null;
  let finished = new Map(); // key -> { key, computer, child, at }
  let checks = new Map(); // computer/project/number -> the CI watch's pull, with `at`
  let statuses = new Map();
  let summary = null; // { since, back, rows } once back
  const listeners = new Set();
  const emit = () => { for (const fn of listeners) fn(summary); };

  return {
    /** A new overview: remember who finished while away. */
    observe(rows) {
      if (awaySince !== null) {
        for (const row of endedTurns(statuses, rows)) finished.set(row.key, { key: row.key, computer: row.computer, child: row.child, at: now() });
      }
      statuses = new Map(rows.map((row) => [row.key, row.child.agentStatus]));
    },
    /** A pull request whose checks settled (the CI watch's look); kept only while away, latest wins. */
    noteChecks(pull) {
      if (awaySince === null) return;
      checks.set(`${pull.computer}/${pull.project}/${pull.number}`, { ...pull, at: now() });
    },
    leave() {
      if (awaySince === null) awaySince = now();
    },
    back() {
      if (awaySince === null) return;
      const since = awaySince;
      awaySince = null;
      const rows = [...finished.values()].sort((a, b) => b.at - a.at).slice(0, MAX_ROWS);
      const settled = [...checks.values()].sort((a, b) => b.at - a.at).slice(0, MAX_ROWS);
      finished = new Map();
      checks = new Map();
      if (now() - since < MIN_AWAY_MS || (!rows.length && !settled.length)) return;
      summary = { since, back: now(), rows, checks: settled };
      emit();
    },
    dismiss() {
      summary = null;
      emit();
    },
    current() { return summary; },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export const away = createAway();

/** Watch focus and visibility and feed the tracker every overview. */
export function startAway() {
  const update = () => (document.hidden || !document.hasFocus() ? away.leave() : away.back());
  window.addEventListener("blur", update);
  window.addEventListener("focus", update);
  document.addEventListener("visibilitychange", update);
  store.subscribe((merged) => away.observe(sessions(merged)));
  onChecksSettled((pull) => away.noteChecks(pull));
  update();
}

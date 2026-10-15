// "Since you left": finished turns, settled checks and account room
// observed while Home is hidden or the window is unfocused. A minute away
// publishes the bounded summary to Home until dismissed.
import { onChecksSettled } from "./ci-watch.js";
import { quotaBackTransitions } from "./quota-back.js";
import { onSectionChange } from "./sections.js";
import { followUsage } from "./usage-rings.js";
import { sessions, store } from "./store.js";

export const MIN_AWAY_MS = 60_000;
const MAX_ROWS = 20;
function keep(map, key, value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_ROWS) map.delete(map.keys().next().value);
}

/** Rows whose turn ended between two looks: working before, anything else now. */
export function endedTurns(before, rows) {
  return rows.filter((row) => before.get(row.key) === "working" && row.child.agentStatus !== "working");
}

/** The away tracker, separate from the DOM so tests can drive it. */
export function createAway({ now = () => Date.now() } = {}) {
  let awaySince = null;
  let finished = new Map(); // key -> { key, computer, child, at }
  let checks = new Map(); // computer/project/number -> the CI watch's pull, with `at`
  let statuses = new Map();
  let events = new Map();
  let quotaState;
  let summary = null; // { since, back, rows } once back
  const listeners = new Set();
  const emit = () => { for (const fn of listeners) fn(summary); };

  return {
    /** A new overview: remember who finished while away. */
    observe(rows) {
      if (awaySince !== null) {
        for (const row of endedTurns(statuses, rows)) keep(finished, row.key, { key: row.key, computer: row.computer, child: row.child, at: now() });
      }
      statuses = new Map(rows.map((row) => [row.key, row.child.agentStatus]));
    },
    /** Consume every usage poll, including visible recoveries, so dismissal never replays one. */
    observeUsage(snapshot) {
      if (!snapshot) return;
      const result = quotaBackTransitions(quotaState, snapshot, now());
      quotaState = result.state;
      if (awaySince !== null) for (const recovery of result.recoveries) keep(events, recovery.key, { ...recovery, kind: "quota", at: now() });
    },
    /** A pull request whose checks settled (the CI watch's look); kept only while away, latest wins. */
    noteChecks(pull) {
      if (awaySince === null) return;
      keep(checks, `${pull.computer}/${pull.project}/${pull.number}`, { ...pull, at: now() });
    },
    leave() {
      if (awaySince === null) awaySince = now();
    },
    back() {
      if (awaySince === null) return;
      const since = awaySince;
      awaySince = null;
      const rows = [...finished.values()].sort((a, b) => b.at - a.at).slice(0, MAX_ROWS);
      const collected = [...events.values()].sort((a, b) => b.at - a.at).slice(0, MAX_ROWS);
      const settled = [...checks.values()].sort((a, b) => b.at - a.at).slice(0, MAX_ROWS);
      finished = new Map();
      checks = new Map();
      events = new Map();
      if (now() - since < MIN_AWAY_MS || (!rows.length && !settled.length && !collected.length)) return;
      summary = { since, back: now(), rows, checks: settled, events: collected };
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
  let section = location.hash.replace(/^#\/?/, "") || "home";
  const update = () => (section !== "home" || document.hidden || !document.hasFocus() ? away.leave() : away.back());
  const stopSection = onSectionChange((id) => { section = id; update(); });
  const stopUsage = followUsage((snapshot) => away.observeUsage(snapshot));
  window.addEventListener("blur", update);
  window.addEventListener("focus", update);
  document.addEventListener("visibilitychange", update);
  const stopStore = store.subscribe((merged) => { if (merged) away.observe(sessions(merged)); });
  const stopChecks = onChecksSettled((pull) => away.noteChecks(pull));
  update();
  return () => {
    stopSection();
    stopUsage();
    stopStore();
    stopChecks();
    window.removeEventListener("blur", update);
    window.removeEventListener("focus", update);
    document.removeEventListener("visibilitychange", update);
  };
}

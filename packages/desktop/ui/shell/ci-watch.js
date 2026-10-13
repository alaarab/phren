// CI watch: a native notification when the pull request of a session's branch
// turns failing or passing. One /v1/git/pulls per repository every two
// minutes, only for sessions working now or active in the last two hours.
// Plain browser ES module.

import { hookPost } from "../api.js";
import { projectOf, store } from "./store.js";

export const CI_WATCH_MS = 120_000;
const ACTIVE_MS = 2 * 3_600_000;
// Repositories asked about per tick; the most recently active win.
const MAX_WATCHED = 6;

/** One session per computer and project, working or recently active, newest first. */
export function watchedSessions(rows, now = Date.now()) {
  const seen = new Set();
  const picked = [];
  const recent = (row) => Date.parse(row.child.lastChangedAt ?? "") || 0;
  for (const row of [...rows].sort((a, b) => recent(b) - recent(a))) {
    const project = projectOf(row.child);
    const key = `${row.computer}\u0000${project}`;
    if (!project || seen.has(key)) continue;
    if (row.child.agentStatus !== "working" && now - recent(row) > ACTIVE_MS) continue;
    seen.add(key);
    picked.push({ key, computer: row.computer, project, target: row.child.target });
    if (picked.length === MAX_WATCHED) break;
  }
  return picked;
}

/** The requests whose checks settled on failing or passing since the last
 *  look. A request seen for the first time only sets the baseline. */
export function ciTransitions(previous, current) {
  const settled = [];
  for (const [key, now] of current) {
    const before = previous.get(key);
    if (!before || before.checks === now.checks) continue;
    if (now.checks === "failing" || now.checks === "passing") settled.push(now);
  }
  return settled;
}

/** Start watching; `notify(title, body)` is the shell's, `enabled()` the setting. */
export function startCiWatch({ notify, enabled }) {
  let previous = new Map();
  let running = false;
  async function tick() {
    if (running || !enabled()) return;
    running = true;
    try {
      const current = new Map();
      await Promise.all(watchedSessions(store.sessions()).map(async (w) => {
        const body = await hookPost(w.computer, "/v1/git/pulls", { target: w.target }).catch(() => null);
        // A failed read keeps what was known, so a passing blip never re-announces.
        if (!body) { for (const [key, known] of previous) if (known.key === w.key) current.set(key, known); return; }
        const pull = body.current;
        if (!pull || !pull.number || (pull.state && pull.state !== "OPEN")) return;
        current.set(`${w.key}\u0000${pull.number}`, { ...w, number: pull.number, title: pull.title || "", checks: pull.checks ?? null,
          ref: body.host?.terms?.ref || "#" });
      }));
      for (const pull of ciTransitions(previous, current)) {
        notify(`${pull.project}: checks ${pull.checks === "failing" ? "failed" : "passed"}`, `${pull.ref}${pull.number} ${pull.title} · ${pull.computer}`);
      }
      previous = current;
    } finally {
      running = false;
    }
  }
  const timer = setInterval(() => { void tick(); }, CI_WATCH_MS);
  void tick();
  return { stop() { clearInterval(timer); } };
}

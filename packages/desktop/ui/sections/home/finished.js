import { el } from "../../dom.js";
import { projectOf, sessions, store } from "../../shell/store.js";
import { age, rowShell, replySub } from "./rows.js";
import { decorateHomeHandoff } from "../../shell/handoff-view.js";
import { showSection } from "../../shell/sections.js";
import { away } from "../../shell/away.js";
import { openUsage } from "../../shell/usage-rings.js";
const MAX_RETURNS = 5;
const SEEN_KEY = "phren.desktop.home.seen";
const RUN_STATE = { finished: "done", "needs-you": "needs you", failed: "failed", blocked: "blocked", skipped: "skipped" };

// Returns and scheduled runs stay unread (an accent dot) until opened here.
function loadSeen() {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]")); } catch { return new Set(); }
}
function saveSeen(seen) {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-1000))); } catch { /* private window */ }
}
export const RETURN_STATE = { "done": "done", "needs-you": "needs you", "failed": "failed", "blocked": "blocked", "gone": "gone", "stalled": "stalled" };

export function createFinished({ state, open, openPrs, block, fill, receipts, runs }) {
  const seen = loadSeen();
  // On the first launch everything already there counts as read.
  let seedSeen = (() => { try { return localStorage.getItem(SEEN_KEY) === null; } catch { return false; } })();
  const NOW_WORD = { working: "working again", waiting: "waiting", blocked: "blocked" };
  // One "Finished" block (pitch): what ended while you were away first (turns
  // and checks, until dismissed), then worker returns and scheduled runs.
  let awayRows = [];
  let returnRows = [];
  let returnTotal = 0;
  function renderFinished() {
    const scope = block("finished");
    const summary = away.current();
    scope.querySelector(".home-away-for").textContent = summary ? ` · away ${age(new Date(summary.since).toISOString())}` : "";
    scope.querySelector(".home-away-dismiss").hidden = !summary;
    fill("finished", [...awayRows, ...returnRows], "Nothing finished yet.");
    scope.querySelector(".count").textContent = awayRows.length + returnTotal ? String(awayRows.length + returnTotal) : "";
    if (returnTotal > MAX_RETURNS) {
      const more = el("button", "home-more", `All ${returnTotal} returns in Review`);
      more.addEventListener("click", () => showSection("review"));
      scope.querySelector(".home-list").append(more);
    }
  }

  function renderAway() {
    const summary = away.current();
    if (!summary) { awayRows = []; renderFinished(); return; }
    const checkRows = (summary.checks ?? []).map((pull) => {
      const failed = pull.checks === "failing";
      const shell = rowShell({ tone: failed ? "failed" : "done" });
      shell.title.textContent = `${pull.ref}${pull.number} ${pull.title}`;
      const meta = el("span", "home-row-meta");
      meta.append(el("span", "home-project", pull.project), el("span", "home-host", pull.computer),
        el("span", failed ? "home-failed" : "home-passed", failed ? "checks failed" : "checks passed"),
        el("span", "home-age", age(new Date(pull.at).toISOString())));
      shell.button.append(meta);
      shell.button.addEventListener("click", () => openPrs(pull.computer, store.find(pull.computer, pull.child.id)?.child ?? pull.child));
      return shell.button;
    });
    const activity = [...summary.rows, ...(summary.events ?? [])].sort((a, b) => b.at - a.at).slice(0, 20);
    awayRows = [...checkRows, ...activity.map((entry) => {
      if (entry.kind === "quota") {
        const shell = rowShell({ tone: "done" });
        shell.button.classList.add("home-quota-row");
        shell.title.textContent = entry.title;
        const meta = el("span", "home-row-meta");
        meta.append(el("span", "home-host", entry.computer), el("span", "home-age", age(new Date(entry.at).toISOString())));
        shell.button.append(meta);
        const usage = el("span", "handoff-link handoff-tag", "Usage ↗");
        meta.append(usage);
        shell.button.addEventListener("click", () => openUsage());
        return shell.button;
      }
      // The row as it is now, when the session is still there.
      const live = store.find(entry.computer, entry.child.id);
      const child = live?.child ?? entry.child;
      const shell = rowShell({ tone: "done", sub: replySub(child) });
      shell.title.textContent = child.title || child.label || projectOf(child);
      const meta = el("span", "home-row-meta");
      meta.append(el("span", "home-project", projectOf(child)), el("span", "home-host", entry.computer));
      const now = !live ? "closed" : child.approvalPending ? "approval" : NOW_WORD[child.agentStatus];
      if (now) meta.append(el("span", "home-why", now));
      meta.append(el("span", "home-age", `done ${age(new Date(entry.at).toISOString())}`));
      shell.button.append(meta);
      shell.button.disabled = !live;
      shell.button.addEventListener("click", () => { if (live) open(entry.computer, live.child); });
      return decorateHomeHandoff(shell.button, entry.computer, child, sessions(state.merged, { includeOffline: true }));
    })];
    renderFinished();
  }
  block("finished").querySelector(".home-away-dismiss").addEventListener("click", () => away.dismiss());

  function overviewChild(target) {
    if (!target) return null;
    for (const row of sessions(state.merged, { includeOffline: true })) {
      const t = row.child.target;
      if (t && t.server === target.server && t.workspace === target.workspace && t.tab === target.tab
        && t.pane === target.pane && t.source === target.source && t.session === target.session) return row;
    }
    return null;
  }

  /** A finished scheduled run: an inbox line like a worker's return. */
  function runRow(entry) {
    const { run, schedule } = entry;
    const status = String(run.status);
    const chip = status === "failed" ? "failed" : status === "finished" ? "done" : status === "skipped" ? "gone" : "needs";
    const shell = rowShell({ tone: chip === "needs" ? "waiting" : undefined, sub: run.reason ? el("span", "home-row-sub", String(run.reason).slice(0, 160)) : undefined });
    shell.title.textContent = schedule.name || "Scheduled prompt";
    const meta = el("span", "home-row-meta");
    if (!seen.has(entry.id)) meta.append(el("span", "home-unread"));
    meta.append(el("span", "home-tag", "Scheduled"));
    meta.append(el("span", `home-chip ${chip}`, RUN_STATE[status] ?? status));
    if (run.project) meta.append(el("span", "home-project", run.project));
    meta.append(el("span", "home-host", entry.computer));
    meta.append(el("span", "home-age", age(entry.at)));
    shell.button.append(meta);
    const launch = run.launch ?? {};
    const match = sessions(state.merged, { includeOffline: true }).find((row) => row.computer === entry.computer && launch.paneId
      && row.child.target?.pane === launch.paneId && (!launch.server || row.child.target?.server === launch.server));
    shell.button.addEventListener("click", () => {
      markSeen(entry.id);
      if (match) open(match.computer, match.child); else showSection("schedules");
    });
    return match ? decorateHomeHandoff(shell.button, match.computer, match.child, sessions(state.merged, { includeOffline: true })) : shell.button;
  }

  function markSeen(id) {
    if (seen.has(id)) return;
    seen.add(id);
    saveSeen(seen);
    renderReturns();
  }

  function returnRow(entry) {
    const r = entry.receipt;
    const status = String(r.returned.state);
    const chip = status === "failed" ? "failed" : status === "done" ? "done" : status === "gone" ? "gone" : "needs";
    const tone = chip === "needs" ? "waiting" : undefined;
    const excerpt = (r.returned.reply || r.returned.question || r.returned.error || "").split("\n").find((line) => line.trim());
    const sub = excerpt ? el("span", "home-row-sub", excerpt.trim().slice(0, 160)) : undefined;
    const shell = rowShell({ tone, sub });
    shell.title.textContent = r.label || r.project || "Worker";
    const meta = el("span", "home-row-meta");
    const id = `return:${r.id}:${r.returned.at}`;
    if (!seen.has(id)) meta.append(el("span", "home-unread"));
    meta.append(el("span", `home-chip ${chip}`, RETURN_STATE[status] ?? status));
    if (r.project) meta.append(el("span", "home-project", r.project));
    meta.append(el("span", "home-host", entry.computer));
    meta.append(el("span", "home-age", age(r.returned.at)));
    shell.button.append(meta);
    const match = overviewChild(r.target);
    // A return whose session has closed opens in Review, which keeps its report.
    shell.button.addEventListener("click", () => {
      markSeen(id);
      if (match) open(match.computer, match.child); else showSection("review");
    });
    return match ? decorateHomeHandoff(shell.button, match.computer, match.child, sessions(state.merged, { includeOffline: true })) : shell.button;
  }

  function renderReturns() {
    const rows = [];
    for (const list of receipts.values()) for (const entry of list) if (entry.receipt?.returned) rows.push({ kind: "return", at: String(entry.receipt.returned.at), entry });
    for (const list of runs.values()) for (const entry of list) rows.push({ kind: "run", at: entry.at, entry });
    rows.sort((a, b) => b.at.localeCompare(a.at));
    returnRows = rows.slice(0, MAX_RETURNS).map((row) => row.kind === "run" ? runRow(row.entry) : returnRow(row.entry));
    returnTotal = rows.length;
    renderFinished();
  }
  return { renderAway, renderReturns, subscribe: () => away.subscribe(renderAway), seed(online) {
    if (seedSeen && online.length) {
      seedSeen = false;
      for (const list of receipts.values()) for (const e of list) if (e.receipt?.returned) seen.add(`return:${e.receipt.id}:${e.receipt.returned.at}`);
      for (const list of runs.values()) for (const e of list) seen.add(e.id);
      saveSeen(seen);
    }
  } };
}

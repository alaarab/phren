import { el } from "../../dom.js";
import { rowShell, age } from "./rows.js";
import { checksWord, hostTerms, pullStanding } from "../../git-review.js";
import { createPullsFeed } from "../../shell/project-pulls.js";

export const PULLS_SHOWN = 8;

const REVIEW = { APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested", REVIEW_REQUIRED: "Review required" };

/** Which group a request sorts in: 0 conflicts, 1 changes requested, 2 failing checks, 3 ready to merge, 4 the rest. */
export function pullRank(row) {
  if (row.conflicts) return 0;
  if (row.review === "CHANGES_REQUESTED") return 1;
  if (row.checks === "failing") return 2;
  if (row.review === "APPROVED" && row.checks === "passing" && !row.draft) return 3;
  return 4;
}

/** Ranks 0 to 3 are the ones that need someone. */
export const needsAction = (row) => row.rank < 4;

/**
 * One row per open request across every project the feeds answered: the same
 * repository seen from several computers (same host, repository and number)
 * counts once, taking the richer read. Sorted by `pullRank`, newest first
 * within a rank.
 */
export function inboxRows(reads) {
  const byKey = new Map();
  for (const { computer, project, directory, data, at = 0, stale = false } of reads) {
    const host = data?.host ?? null;
    // The repository is its web address, else domain + remote + project: never the domain alone.
    const repo = String(host?.webUrl || (host?.domain ? `${host.domain}/${host.remote ?? ""}/${project}` : `${computer}/${project}`)).toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
    const viewer = String(data?.account?.user ?? "").toLowerCase();
    const current = data?.current && typeof data.current.number === "number" ? data.current : null;
    for (const listed of Array.isArray(data?.pulls) ? data.pulls : []) {
      if (typeof listed?.number !== "number") continue;
      // The checked-out branch's own request is read in full; the list is thinner.
      const pull = current && current.number === listed.number ? { ...listed, ...current } : listed;
      const row = {
        key: `${repo}#${pull.number}`, computer, project, directory, host, terms: hostTerms(host),
        number: pull.number, title: String(pull.title ?? ""), author: String(pull.author ?? ""), url: String(pull.url ?? ""),
        checks: CHECKS.has(pull.checks) ? pull.checks : "", review: pull.reviewDecision ?? "", mergeState: pull.mergeState ?? "",
        conflicts: pull.conflicts === true || pull.mergeState === "DIRTY", behind: pull.mergeState === "BEHIND",
        draft: pull.draft === true || pull.mergeState === "DRAFT", comments: Number(pull.comments) || 0,
        updated: String(pull.updated ?? ""), pipeline: host?.kind === "gitlab" || host?.kind === "gitboy",
        standing: pullStanding(pull), stale, at, mine: !!viewer && String(pull.author ?? "").toLowerCase() === viewer,
      };
      // A read that may be out of date is listed but never counted as needing you.
      row.rank = stale ? 5 : pullRank(row);
      const seen = byKey.get(row.key);
      if (!seen || better(row, seen)) byKey.set(row.key, row);
    }
  }
  const time = (row) => Date.parse(row.updated) || 0;
  return [...byKey.values()].sort((a, b) => a.rank - b.rank || time(b) - time(a) || b.number - a.number);
}

// How much one read says about a request, to pick between copies of the same one.
const detail = (row) => (row.checks ? 1 : 0) + (row.review ? 1 : 0) + (row.mergeState ? 1 : 0) + (row.draft ? 1 : 0) + (row.comments > 0 ? 1 : 0);
// Copies of one request: a current read over a stale one, then the fuller read, then the fresher.
const better = (a, b) => (a.stale ? 1 : 0) < (b.stale ? 1 : 0) || (a.stale === b.stale && (detail(a) > detail(b) || (detail(a) === detail(b) && a.at > b.at)));
const CHECKS = new Set(["failing", "pending", "passing"]);

/** What the card calls its requests: "pull requests", "merge requests" (every host GitLab) or both. */
export function inboxWords(rows) {
  const longs = new Set(rows.map((row) => row.terms.long));
  const shorts = new Set(rows.map((row) => row.terms.short));
  if (longs.size === 1) return { plural: `${[...longs][0]}s`, short: `${[...shorts][0]}s` };
  return { plural: "pull and merge requests", short: "requests" };
}

const capital = (text) => text[0].toUpperCase() + text.slice(1);

export function createPulls({ block, computers, openProject, isVisible, active, ready, now = () => Date.now() }) {
  let result = { pulls: [], loading: false, failed: false, unread: 0, unreadComputers: 0 };
  let expanded = false;
  let timer = null;
  const feed = createPullsFeed({
    computers, active, ready,
    onUpdate(update) { result = update; render(); },
    canRead: () => isVisible() && document.visibilityState !== "hidden",
    now,
  });
  // The card's foot (built when first needed): what could not be read, and a Refresh that forces one round.
  let footer = null;
  function foot() {
    if (footer) return footer;
    const node = el("div", "home-pulls-foot");
    const note = el("span", "home-pulls-note");
    note.setAttribute("role", "status");
    const refresh = el("button", "home-pulls-refresh", "Refresh");
    refresh.type = "button";
    refresh.title = "Read every project's requests now";
    refresh.addEventListener("click", () => { void feed.read({ force: true }); render(); });
    node.append(note, refresh);
    footer = { node, note, refresh };
    return footer;
  }
  function paintFoot(text) {
    const { node, note, refresh } = foot();
    note.textContent = text;
    refresh.disabled = feed.busy();
    refresh.textContent = feed.busy() ? "Refreshing\u2026" : "Refresh";
    return node;
  }

  function row(item) {
    const shell = rowShell({ tone: item.rank < 3 ? "failed" : item.rank === 3 ? "done" : undefined, sub: undefined });
    shell.button.classList.add("home-pull");
    if (item.stale) { shell.button.classList.add("stale"); shell.button.title = "This computer could not be read just now; showing what it said earlier."; }
    shell.button.dataset.key = item.key;
    shell.title.textContent = `${item.terms.ref}${item.number} ${item.title}`;
    shell.title.title = [item.standing, item.comments ? `${item.comments} comment${item.comments === 1 ? "" : "s"}` : "", item.url].filter(Boolean).join(" · ");
    const meta = el("span", "home-row-meta home-pull-meta");
    const project = el("span", "home-project", item.project);
    project.title = `${item.project} · ${item.computer}`;
    meta.append(project);
    if (item.author) meta.append(el("span", `home-pull-author${item.mine ? " mine" : ""}`, item.mine ? "you" : `@${item.author}`));
    const word = checksWord(item.checks, item.pipeline ? "Pipeline" : "Checks");
    if (word) meta.append(el("span", `home-pull-checks ${item.checks}`, word));
    if (REVIEW[item.review]) meta.append(el("span", `home-pull-chip review-${item.review.toLowerCase()}`, REVIEW[item.review]));
    if (item.conflicts) meta.append(el("span", "home-pull-chip conflicts", "Conflicts"));
    else if (item.behind) meta.append(el("span", "home-pull-chip behind", "Behind"));
    if (item.draft) meta.append(el("span", "home-pull-chip draft", "Draft"));
    const when = age(item.updated);
    if (when) meta.append(el("span", "home-age", when));
    shell.button.append(meta);
    shell.button.addEventListener("click", () => openProject(item));
    return shell.button;
  }

  function render() {
    const scope = block("pulls");
    if (!scope) return;
    const rows = inboxRows(result.pulls);
    const words = inboxWords(rows.length ? rows : [{ terms: hostTerms(null) }]);
    const loadingOnly = result.loading && !rows.length;
    scope.hidden = !(rows.length || loadingOnly || result.failed);
    scope.querySelector(".pulls-title").textContent = capital(rows.length ? words.plural : "pull requests");
    scope.querySelector(".count").textContent = rows.length ? String(rows.length) : "";
    const list = scope.querySelector(".home-list");
    if (!rows.length) {
      list.replaceChildren(...(result.failed ? [el("div", "home-empty danger", "Could not read pull requests from your computers."), paintFoot("")] : [el("div", "home-empty", "Reading pull requests\u2026")]));
      return;
    }
    const shown = expanded ? rows : rows.slice(0, PULLS_SHOWN);
    const nodes = shown.map(row);
    if (rows.length > PULLS_SHOWN) {
      const more = el("button", "home-more", expanded ? "Show fewer" : `Show all ${rows.length} ${words.short}`);
      more.type = "button";
      more.addEventListener("click", () => { expanded = !expanded; render(); });
      nodes.push(more);
    }
    const lost = [result.unread ? `${result.unread} project${result.unread === 1 ? "" : "s"}` : "", result.unreadComputers ? `${result.unreadComputers} computer${result.unreadComputers === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
    nodes.push(paintFoot(lost ? `Couldn\u2019t read ${lost}` : ""));
    list.replaceChildren(...nodes);
  }

  function schedule() {
    clearTimeout(timer);
    // Past the cadence a project is read at, so the round finds it due: 5 minutes focused, 15 without focus.
    timer = setTimeout(() => { void feed.read().then(() => { if (timer !== null) schedule(); }); }, feed.cadence() + 1000);
  }
  const onVisibility = () => { if (isVisible() && document.visibilityState !== "hidden") void feed.read(); };
  const onFocus = () => { if (isVisible()) { void feed.read(); schedule(); } };

  return {
    render,
    /** Home's online computers changed (or Home opened): read what is missing or stale. */
    update() { if (isVisible()) void feed.read(); },
    show() {
      document.addEventListener("visibilitychange", onVisibility);
      globalThis.window?.addEventListener?.("focus", onFocus);
      void feed.read();
      schedule();
      render();
    },
    hide() {
      clearTimeout(timer);
      timer = null;
      document.removeEventListener("visibilitychange", onVisibility);
      globalThis.window?.removeEventListener?.("focus", onFocus);
    },
  };
}

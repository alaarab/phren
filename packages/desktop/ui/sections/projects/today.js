// The Projects page's Today block: chats, pull requests and memory from the local day.
import { el } from "../../dom.js";
import { capitalize, hostTerms } from "../../git-review.js";
import { projectOf, sessions as allSessions } from "../../shell/store.js";
import { todayGroups, sessionsForProject, TODAY_ROWS } from "../../shell/project-today.js";
import { loadFindings, openSaved } from "../home/saved-today.js";
import { savedAgo } from "../../time.js";
import { checksPill, pullRow } from "./forge.js";

export function createToday(ctx) {
  const { state, openInAgents } = ctx;
  const renderDetail = () => ctx.renderDetail();

  /** The project's findings for the Today block: the shared five-minute cache, so at most one memory read per page view. */
  async function loadToday() {
    const detail = state.detail;
    const project = detail && state.data.get(detail.computer)?.projects.get(detail.name);
    if (!project) return;
    try {
      project.todayFindings = await loadFindings(detail.computer, project.name, { fetchStale: true });
      project.todayError = false;
    } catch { project.todayError = true; }
    if (state.detail === detail) renderDetail();
  }

  /** Where this project is checked out, per computer that has it: its repo directory, the host data's directory and any listed worktrees. */
  function checkoutsOf(name) {
    const out = new Map();
    for (const [computer, entry] of state.data) {
      const p = entry.projects.get(name);
      if (!p) continue;
      const git = p.forge?.data;
      const listed = Array.isArray(git?.worktrees) ? git.worktrees.map((w) => w?.path ?? w?.directory) : [];
      out.set(computer, [p.directory, git?.directory, ...listed].filter((d) => typeof d === "string" && d));
    }
    return out;
  }

  let midnight = null;
  function stopMidnight() { clearTimeout(midnight); midnight = null; }
  function scheduleMidnight() {
    clearTimeout(midnight);
    const d = new Date();
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    midnight = setTimeout(() => { if (state.view === "detail" && state.detail) renderDetail(); scheduleMidnight(); }, Math.max(1000, end - Date.now() + 1000));
  }

  /** Chats, pull requests and memory from today, from what this page already holds. Hidden with no activity. */
  function todayBlock(detail, project) {
    const git = project.forge?.data;
    const groups = todayGroups({
      sessions: sessionsForProject(allSessions(state.merged), { name: detail.name, checkouts: checkoutsOf(detail.name) }),
      pulls: Array.isArray(git?.pulls) ? git.pulls : [],
      current: git?.current ?? null,
      findings: project.todayFindings ?? [],
      computer: detail.computer, project: project.name,
    });
    if (!groups.total && !project.todayError) return null;
    const terms = hostTerms(git?.host);
    const block = el("section", "pj-block pj-today");
    block.dataset.block = "project-today";
    block.append(el("h2", "section-label", "Today"));
    if (project.todayError) block.append(el("div", "pj-empty slim danger", "Couldn't read today's memory."));
    const now = Date.now();
    const section = (id, label, items, makeRow) => {
      if (!items.length) return;
      const group = el("div", "pj-today-group");
      group.dataset.group = id;
      const head = el("h3", "pj-subhead", label);
      head.append(el("span", "pj-count", String(items.length)));
      group.append(head);
      const list = el("div", "pj-list");
      const open = state.todayOpen.has(id);
      for (const item of open ? items : items.slice(0, TODAY_ROWS)) list.append(makeRow(item));
      group.append(list);
      if (items.length > TODAY_ROWS) {
        const more = el("button", "pj-today-more", open ? "Show fewer" : `Show all ${items.length}`);
        more.type = "button";
        more.addEventListener("click", () => { if (open) state.todayOpen.delete(id); else state.todayOpen.add(id); renderDetail(); });
        group.append(more);
      }
      block.append(group);
    };
    section("chats", "Chats", groups.chats, ({ row, at }) => {
      const button = el("button", "pj-row");
      const main = el("div", "pj-row-main");
      main.append(el("span", "pj-row-title", row.child.title || row.child.label || projectOf(row.child)));
      const meta = el("span", "pj-row-meta");
      const status = row.child.approvalPending || row.child.agentStatus === "blocked" ? "waiting" : row.child.agentStatus;
      if (status) meta.append(el("span", `pj-status ${status}`, status));
      meta.append(el("span", "", savedAgo(at, now)));
      button.append(main, meta);
      button.addEventListener("click", () => openInAgents(row.computer, row.child));
      return button;
    });
    section("prs", `${capitalize(terms.long)}s updated today`, groups.prs, ({ pull, at, merged }) => {
      const row = pullRow(pull, terms);
      row.querySelector(".pj-row-meta")?.replaceChildren(...[
        merged ? el("span", "pj-checks passing", "Merged") : "",
        checksPill(pull.checks),
        el("span", "", savedAgo(at, now)),
      ].filter(Boolean));
      return row;
    });
    section("memory", "Memory", groups.memory, (entry) => {
      const button = el("button", "pj-row");
      const main = el("div", "pj-row-main");
      main.append(el("span", "pj-row-title", entry.text));
      button.append(main, el("span", "pj-row-meta", savedAgo(entry.at, now)));
      button.title = entry.text;
      button.addEventListener("click", () => openSaved(entry));
      return button;
    });
    return block;
  }

  return { loadToday, scheduleMidnight, stopMidnight, todayBlock };
}

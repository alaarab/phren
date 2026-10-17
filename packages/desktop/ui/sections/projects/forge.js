// The Projects page's Code block: the checkout's host, branch and open pull
// requests with checks, the branch's tasks and the token connect.
import { el } from "../../dom.js";
import { hookGet } from "../../api.js";
import { hostMark } from "../../changes.js";
import { loadBranchTasks, renderBranchTasks } from "../../branch-tasks.js";
import { capitalize, checksWord, fixItPrompt, hostTerms, tokenPage } from "../../git-review.js";
import { openLaunchSheet } from "../../shell/launch.js";
import { store } from "../../shell/store.js";
import { freshProjectGit, rememberProjectGit } from "../../shell/project-pulls.js";
import { age } from "./data.js";

// Open pull requests shown on a project before "N more on <host>".
const FORGE_PULLS = 8;

export function pullRow(pull, terms) {
  const row = el("button", "pj-row");
  const main = el("div", "pj-row-main");
  main.append(el("span", "pj-row-title", `${terms.ref}${pull.number} ${pull.title || ""}`));
  const sub = el("span", "pj-row-sub");
  sub.textContent = [pull.draft ? "Draft" : "", pull.head || "", pull.author ? `@${pull.author}` : ""].filter(Boolean).join(" \u00b7 ");
  main.append(sub);
  const meta = el("span", "pj-row-meta");
  const pill = checksPill(pull.checks);
  if (pill) meta.append(pill);
  const when = age(pull.updated);
  if (when) meta.append(el("span", "", when));
  row.append(main, meta);
  row.title = pull.url || "";
  row.addEventListener("click", () => { if (pull.url) window.open(pull.url, "_blank", "noopener"); });
  return row;
}

export function checksPill(checks) {
  if (!["passing", "failing", "pending"].includes(checks)) return "";
  return el("span", `pj-checks ${checks}`, checksWord(checks));
}

export function createForge(ctx) {
  const { state, openHostConnect } = ctx;
  const renderDetail = () => ctx.renderDetail();

  /** The project's host, branch and open pull requests with checks, from its
   *  checkout on that computer. A Hook without the route hides the block. */
  async function loadForge({ force = false } = {}) {
    const detail = state.detail;
    const project = detail && state.data.get(detail.computer)?.projects.get(detail.name);
    if (!project || project.forge?.loading) return;
    project.forge = { loading: true };
    renderDetail();
    try {
      // Home's Pull requests card reads the same route: an answer under two minutes old is shared, Refresh asks again.
      const shared = force ? null : freshProjectGit(detail.computer, project.name);
      const [data, capabilities] = await Promise.all([
        shared ?? hookGet(detail.computer, `/v1/projects/${encodeURIComponent(project.name)}/git`),
        store.capabilities(detail.computer),
      ]);
      if (!shared) rememberProjectGit(detail.computer, project.name, data);
      project.forge = { data, projectHostToken: capabilities.projectHostToken === true };
      void loadForgeTasks(detail, project, project.forge);
    } catch (err) {
      const code = err?.body?.code;
      if (code === "no-checkout") project.forge = { missing: true };
      else if (err?.status === 404) project.forge = { hidden: true };
      else project.forge = { error: err?.message ?? String(err) };
    }
    if (state.detail === detail) renderDetail();
  }


  /** The open tasks that name the checkout's branch, under the Code block. */
  async function loadForgeTasks(detail, project, forge) {
    const tasks = await loadBranchTasks(detail.computer, project.name, forge.data?.branch);
    if (!tasks?.length || project.forge !== forge) return;
    forge.tasks = { tasks, done: new Set(), busy: null, error: "" };
    if (state.detail === detail) renderDetail();
  }

  function forgeBlock(project) {
    const forge = project.forge;
    if (!forge || forge.hidden) return null;
    const block = el("section", "pj-block pj-forge");
    const head = el("div", "pj-block-head");
    const res = forge.data;
    const host = res?.host;
    const label = el("h2", "section-label", "Code");
    if (host?.kind) label.append(hostMark(host.kind, 14), el("span", "pj-forge-host", host.domain && !/^(github|gitlab)\.com$/.test(host.domain) ? `${host.name} · ${host.domain}` : host.name));
    head.append(label, el("span", "pj-spacer"));
    if (host?.webUrl) {
      const open = el("button", "pj-btn", `Open on ${host.name} \u2197`);
      open.addEventListener("click", () => window.open(host.webUrl, "_blank", "noopener"));
      head.append(open);
    }
    const refresh = el("button", "pj-btn", "Refresh");
    refresh.disabled = !!forge.loading;
    refresh.addEventListener("click", () => loadForge({ force: true }));
    head.append(refresh);
    block.append(head);
    const list = el("div", "pj-list");
    block.append(list);
    if (forge.loading) { list.append(el("div", "pj-empty slim", "Reading the checkout\u2026")); return block; }
    if (forge.missing) { list.append(el("div", "pj-empty slim", "No checkout of this project on this computer.")); return block; }
    if (forge.error) { list.append(el("div", "pj-empty slim danger", forge.error)); return block; }
    const terms = hostTerms(host);
    const branch = el("div", "pj-forge-branch");
    branch.append(el("span", "pj-chip pj-mono", res.branch || "detached"));
    if (res.current) branch.append(el("span", "pj-row-sub", `${terms.ref}${res.current.number} ${res.current.state === "OPEN" || !res.current.state ? "open" : String(res.current.state).toLowerCase()}`), checksPill(res.current.checks));
    const failing = (res.current?.checkRuns || []).filter((run) => run.state === "failing");
    if (res.current?.checks === "failing" && res.branch) {
      const fix = el("button", "pj-btn pj-fixit", "Fix it");
      fix.title = "Start a new agent on this branch with the failing checks";
      const pull = res.current;
      fix.addEventListener("click", () => openLaunchSheet({
        project: project.name, computer: state.detail.computer, title: `Fix ${terms.ref}${pull.number}`, label: `Fix ${terms.ref}${pull.number}`,
        prompt: fixItPrompt({ ref: terms.ref, number: pull.number, title: pull.title, head: res.branch, url: pull.url, failing: failing.length ? failing : [{ name: "checks", url: pull.pipeline?.url }] }),
      }));
      branch.append(el("span", "pj-spacer"), fix);
    }
    list.append(branch);
    if (forge.tasks) list.append(renderBranchTasks({ computer: state.detail.computer, project: project.name, branch: res.branch, state: forge.tasks, rerender: renderDetail }));
    if (res.available === false) {
      if (res.reason === "auth" && forge.projectHostToken && tokenPage(host)) {
        const connect = el("button", "pj-btn primary", "Connect");
        const detail = state.detail;
        connect.addEventListener("click", () => openHostConnect(detail, host));
        list.append(connect);
      }
      list.append(el("div", "pj-empty slim", res.message || `${capitalize(terms.long)}s are not available from this computer.`));
      return block;
    }
    const pulls = Array.isArray(res.pulls) ? res.pulls : [];
    if (!pulls.length) { list.append(el("div", "pj-empty slim", `No open ${terms.long}s.`)); return block; }
    for (const pull of pulls.slice(0, FORGE_PULLS)) list.append(pullRow(pull, terms));
    if (pulls.length > FORGE_PULLS) list.append(el("div", "pj-empty slim", `${pulls.length - FORGE_PULLS} more on ${host?.name || "the host"}.`));
    return block;
  }

  return { loadForge, forgeBlock };
}

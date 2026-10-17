// The Projects page: Summary, Open work, Sessions, Skills and Knobs around the Today and Code blocks.
import { el } from "../../dom.js";
import { projectOf } from "../../shell/store.js";
import { storeBlobText } from "../../store-cache.js";
import { KNOBS, age, clear, parseFrontmatter, parseKnobs, skillsFromTree } from "./data.js";

export function createDetail(ctx) {
  const { state, body, sessionsFor, openInAgents, todayBlock, forgeBlock, openKnobs } = ctx;

  async function loadDetailFiles({ force = false } = {}) {
    const detail = state.detail;
    if (!detail) return;
    const entry = state.data.get(detail.computer);
    const project = entry?.projects.get(detail.name);
    if (!entry || !project) return;
    if (project.skills && !force) return;
    project.loadingFiles = true;
    renderDetail();
    try {
      const skills = [...skillsFromTree(entry.tree, project.name, "project"), ...skillsFromTree(entry.tree, project.name, "global")];
      const skillRows = await Promise.all(skills.map(async (skill) => {
        try {
          const content = await storeBlobText(detail.computer, skill.sha);
          const { frontmatter } = parseFrontmatter(content);
          return { ...skill, title: frontmatter?.name || skill.name, description: frontmatter?.description || "" };
        } catch { return { ...skill, title: skill.name, description: "" }; }
      }));
      project.skills = skillRows;
      const configNode = project.files?.get("phren.project.yaml");
      if (configNode) {
        try {
          project.knobYaml = await storeBlobText(detail.computer, configNode.sha);
          project.knobSha = configNode.sha;
          project.knobs = parseKnobs(project.knobYaml);
        } catch { /* leave knobs unknown */ }
      } else {
        project.knobYaml = "";
        project.knobSha = null;
        project.knobs = {};
      }
    } catch (err) {
      project.filesError = err?.message ?? String(err);
    } finally {
      project.loadingFiles = false;
      renderDetail();
    }
  }

  function renderDetail() {
    clear(body);
    const detail = state.detail;
    const entry = state.data.get(detail.computer);
    const project = entry?.projects.get(detail.name);
    const scope = el("div", "pj-detail");
    body.append(scope);
    if (!entry || !project) {
      scope.append(el("div", "pj-empty", "That project is not on this computer."));
      return;
    }

    const today = todayBlock(detail, project);
    if (today) scope.append(today);

    const summary = el("section", "pj-block");
    summary.append(el("h2", "section-label", "Summary"));
    summary.append(el("p", "pj-summary" + (project.knows || project.summaryLine ? "" : " muted"), project.knows || project.summaryLine || "No summary yet."));
    scope.append(summary);

    const work = el("section", "pj-block");
    work.append(el("h2", "section-label", "Open work"));
    const chips = el("div", "pj-chips");
    const findings = project.counts?.findings ?? 0;
    const tasks = project.counts?.tasks ?? 0;
    chips.append(el("span", "pj-chip", `${findings} finding${findings === 1 ? "" : "s"}`));
    chips.append(el("span", "pj-chip", `${tasks} open task${tasks === 1 ? "" : "s"}`));
    work.append(chips);
    scope.append(work);

    const forge = forgeBlock(project);
    if (forge) scope.append(forge);

    const sessionRows = sessionsFor(detail.computer, detail.name);
    const sessionsBlock = el("section", "pj-block");
    const sh = el("h2", "section-label", "Sessions");
    sh.append(el("span", "pj-count", sessionRows.length ? String(sessionRows.length) : ""));
    sessionsBlock.append(sh);
    const sessionList = el("div", "pj-list");
    if (sessionRows.length) {
      for (const row of sessionRows) sessionList.append(sessionRow(row));
    } else {
      sessionList.append(el("div", "pj-empty slim", "No live sessions."));
    }
    sessionsBlock.append(sessionList);
    scope.append(sessionsBlock);

    scope.append(skillsBlock(project));
    scope.append(knobsBlock(project));
  }

  function sessionRow(row) {
    const button = el("button", "pj-row");
    const main = el("div", "pj-row-main");
    main.append(el("span", "pj-row-title", row.child.title || row.child.label || projectOf(row.child)));
    const meta = el("span", "pj-row-meta");
    const status = row.child.approvalPending || row.child.agentStatus === "blocked" ? "waiting" : row.child.agentStatus;
    if (status) meta.append(el("span", `pj-status ${status}`, status));
    if (row.child.cwd) meta.append(el("span", "pj-mono", row.child.cwd.split("/").slice(-2).join("/")));
    const when = age(row.child.lastChangedAt);
    if (when) meta.append(el("span", "", when));
    button.append(main, meta);
    button.addEventListener("click", () => openInAgents(row.computer, row.child));
    return button;
  }

  function skillsBlock(project) {
    const block = el("section", "pj-block");
    const heading = el("h2", "section-label", "Skills");
    block.append(heading);
    const list = el("div", "pj-list");
    if (project.loadingFiles && !project.skills) list.append(el("div", "pj-empty slim", "Reading skills\u2026"));
    else if (project.skills && project.skills.length) {
      const projectSkills = project.skills.filter((s) => s.scope === "project");
      const globalSkills = project.skills.filter((s) => s.scope === "global");
      for (const s of projectSkills) list.append(skillRow(s));
      if (globalSkills.length) {
        list.append(el("div", "pj-subhead", "From global"));
        for (const s of globalSkills) list.append(skillRow(s));
      }
      heading.append(el("span", "pj-count", String(project.skills.length)));
    } else if (project.filesError) list.append(el("div", "pj-error", project.filesError));
    else list.append(el("div", "pj-empty slim", "No skills in this project."));
    block.append(list);
    return block;
  }

  function skillRow(skill) {
    const row = el("div", "pj-row static");
    const main = el("div", "pj-row-main");
    main.append(el("span", "pj-row-title", skill.title));
    if (skill.description) main.append(el("span", "pj-row-sub", skill.description));
    row.append(main);
    row.append(el("span", "pj-scope", skill.scope === "global" ? "global" : "project"));
    return row;
  }

  function knobsBlock(project) {
    const block = el("section", "pj-block");
    const heading = el("h2", "section-label", "Knobs");
    const edit = el("button", "pj-btn small", "Edit");
    edit.disabled = !project.knobSha && !project.knobs;
    edit.addEventListener("click", () => openKnobs(state.detail));
    const head = el("div", "pj-block-head");
    head.append(heading, el("span", "pj-spacer"), edit);
    block.append(head);
    const list = el("div", "pj-knobs");
    const knobs = project.knobs ?? {};
    for (const [key, def] of Object.entries(KNOBS)) {
      const row = el("div", "pj-knob");
      row.append(el("span", "pj-knob-label", def.label));
      const value = knobs[key];
      row.append(el("span", `pj-knob-value${value ? "" : " muted"}`, value || "Inherit global"));
      list.append(row);
    }
    block.append(list);
    return block;
  }

  return { loadDetailFiles, renderDetail };
}

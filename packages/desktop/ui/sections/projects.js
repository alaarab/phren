// Projects: every project across the computers as a grid of cards. Each card
// opens a detail page with the project's memory (summary, open work, live
// sessions, skills, knobs). Add a repository to a computer, or launch an agent
// straight into a project. The store routes read a computer's phren store;
// the phone's Projects screen is the base, drawn with the desktop's variables.
import { extractKnowsBlock } from "../chat/knows.js";
import { hookGet, hookPost } from "../api.js";
import { projectOf, sessions as allSessions, store } from "../shell/store.js";
import { sectionHandle, showSection } from "../shell/sections.js";

// The five per-project knobs the CLI reads from <project>/phren.project.yaml,
// under the file's top-level `config:` mapping (packages/cli/src/project-config.ts).
// A missing key means "inherit the global setting".
const KNOBS = {
  findingSensitivity: { label: "Finding sensitivity", caption: "How readily new findings are kept", options: ["minimal", "conservative", "balanced", "aggressive"] },
  proactivity: { label: "Proactivity", caption: "The base auto-capture level", options: ["low", "medium", "high"] },
  proactivityFindings: { label: "Proactivity for findings", caption: "Auto-capture for findings only", options: ["low", "medium", "high"] },
  proactivityTask: { label: "Proactivity for tasks", caption: "Auto-capture for tasks only", options: ["low", "medium", "high"] },
  taskMode: { label: "Task mode", caption: "How new tasks are filed", options: ["off", "manual", "suggest", "auto"] },
};

// Claude and Codex take a permission mode on launch; the Hook refuses it for
// every other harness (docs/api-reference.md, "Hook workspace launch fields").
const PERMISSION_MODES = [
  ["", "Harness default"],
  ["supervised", "Supervised"],
  ["auto-edits", "Auto edits"],
  ["auto", "Auto"],
  ["full-access", "Full access"],
];

const HARNESS_LABELS = { claude: "Claude", codex: "Codex", opencode: "OpenCode", copilot: "Copilot", phren: "Phren" };

const STYLE_ID = "projects-styles";

// ---------------------------------------------------------------- helpers

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clear(node) { node.replaceChildren(); }

function installStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const link = document.createElement("link");
  link.id = STYLE_ID;
  link.rel = "stylesheet";
  link.href = new URL("projects.css", import.meta.url).href;
  document.head.append(link);
}

function decodeBase64(text) {
  const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** A short age: "now", "5m", "3h", "2d". */
function age(iso) {
  const at = Date.parse(iso ?? "");
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, (Date.now() - at) / 1000);
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function autoFocus(input) {
  requestAnimationFrame(() => input.focus());
}

/** Minimal flat-YAML reader for skill frontmatter and phren.project.yaml: the
 * `key: value` lines phren writes, quoted or bare. Nested blocks are skipped. */
function parseScalarYAML(yaml) {
  const result = {};
  for (const raw of String(yaml).split("\n")) {
    const line = raw;
    if (line.startsWith("#") || line.startsWith(" ") || line.startsWith("\t") || line.startsWith("-")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (!key || !value) continue;
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/** A skill's leading `--- ... ---` block, like the phone's SkillFile.parseFrontmatter. */
function parseFrontmatter(raw) {
  let text = String(raw);
  if (text.startsWith("\ufeff")) text = text.slice(1);
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!text.startsWith("---\n")) return { frontmatter: null, body: text };
  const close = text.indexOf("\n---", 4);
  if (close < 0) return { frontmatter: null, body: text };
  const frontmatter = parseScalarYAML(text.slice(4, close));
  const body = text.slice(close + 4).replace(/^\n/, "");
  return { frontmatter: Object.keys(frontmatter).length ? frontmatter : null, body };
}

/** The summary.md "What phren knows" block: its prose and the counts it carries. */
function parseKnows(summary) {
  if (!summary) return null;
  // The newest copy when a union merge left several start markers.
  const block = extractKnowsBlock(summary);
  if (!block) return null;
  const inner = ["", ...block.split("\n")];
  const bullets = inner.filter((line) => line.startsWith("- "));
  const counts = { findings: 0, archived: 0, tasks: null };
  for (const line of bullets) {
    const active = /(\d+) active finding/.exec(line);
    const archived = /(\d+) archived/.exec(line);
    const tasks = /(\d+) open task/.exec(line);
    if (active) counts.findings = Number(active[1]);
    if (archived) counts.archived = Number(archived[1]);
    if (tasks) counts.tasks = Number(tasks[1]);
  }
  // A topic bullet may carry only its "## Now" heading, with the real line in the next paragraph.
  const prose = inner.slice(1).map((line) => line.trim()).filter((line) => line && !line.startsWith("#") && !line.startsWith("<!--") && !line.startsWith("- "));
  const first = bullets.find((line) => !/active finding/.test(line) && !/—\s*#+\s/.test(line)) ?? prose[0];
  const summaryLine = (first ?? bullets[0] ?? "").replace(/^#+\s*/, "").replace(/^-\s*/, "").replace(/^\*\*[^*]+\*\*\s*—\s*/, "").trim();
  return { counts, summaryLine, text: inner.slice(1).join("\n").trim() };
}

/** Open tasks are the non-empty "- " bullets before the Done section. */
function countOpenTasks(markdown) {
  let count = 0, inDone = false;
  for (const line of String(markdown).split("\n")) {
    if (/^##\s+Done\b/.test(line)) { inDone = true; continue; }
    if (/^##\s+/.test(line)) { inDone = false; continue; }
    if (!inDone && line.startsWith("- ") && line.slice(2).trim() && !/^-\s*\[x\]/i.test(line)) count++;
  }
  return count;
}

/** Active findings are the "- " bullets in FINDINGS.md (archived ones live elsewhere). */
function countActiveFindings(markdown) {
  let count = 0;
  for (const line of String(markdown).split("\n")) if (line.startsWith("- ")) count++;
  return count;
}

// ------------------------------------------------------------- project.yaml

/** The index of the top-level `config:` line (an indented one is not it). */
function configHeader(lines) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || line !== line.trimStart()) continue;
    const colon = trimmed.indexOf(":");
    if (colon > 0 && trimmed.slice(0, colon).trim() === "config") return i;
  }
  return -1;
}

/** An indented `key: value` line, ignoring comments; the value is unquoted. */
function scalarLine(raw) {
  if (!raw.startsWith(" ") && !raw.startsWith("\t")) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const colon = trimmed.indexOf(":");
  if (colon <= 0) return null;
  const key = trimmed.slice(0, colon).trim();
  if (!key) return null;
  let value = trimmed.slice(colon + 1).trim();
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  return { key, value };
}

/** The five knobs set in the file's `config:` block; unknown values read as unset. */
function parseKnobs(yaml) {
  const knobs = {};
  const lines = String(yaml).split("\n");
  const header = configHeader(lines);
  if (header < 0) return knobs;
  for (let i = header + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() && line === line.trimStart()) break;
    const entry = scalarLine(line);
    if (entry && KNOBS[entry.key] && KNOBS[entry.key].options.includes(entry.value)) knobs[entry.key] = entry.value;
  }
  return knobs;
}

/** Rewrite only the knob lines under `config:`, copying every other line through
 * byte for byte: sourcePath, ownership, nested blocks and comments all survive. */
function applyKnobs(yaml, values) {
  const keys = Object.keys(KNOBS);
  const lines = String(yaml).split("\n");
  const trailing = lines[lines.length - 1] === "" ? 1 : 0;
  const contentEnd = lines.length - trailing;
  const header = configHeader(lines);
  if (header < 0) {
    const entries = keys.filter((key) => values[key]).map((key) => `  ${key}: ${values[key]}`);
    if (!entries.length) return yaml;
    lines.splice(contentEnd, 0, "config:", ...entries);
    return lines.join("\n");
  }
  if (keys.some((key) => values[key]) && /^config:\s*\{\s*\}\s*$/.test(lines[header])) lines[header] = "config:";
  let blockEnd = header + 1;
  while (blockEnd < contentEnd) {
    const line = lines[blockEnd];
    if (line.trim() && line === line.trimStart()) break;
    blockEnd++;
  }
  let indent = "  ";
  for (let i = header + 1; i < contentEnd; i++) {
    const line = lines[i];
    if (line.trim() && line === line.trimStart()) break;
    const match = /^(\s+)/.exec(line);
    if (match) { indent = match[1]; break; }
  }
  const present = new Set();
  const output = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i > header && i < blockEnd) {
      const entry = scalarLine(line);
      if (entry && keys.includes(entry.key)) {
        present.add(entry.key);
        if (values[entry.key]) output.push(`${line.match(/^\s*/)[0]}${entry.key}: ${values[entry.key]}`);
      } else output.push(line);
    } else output.push(line);
    if (i === blockEnd - 1) {
      for (const key of keys) if (values[key] && !present.has(key)) output.push(`${indent}${key}: ${values[key]}`);
    }
  }
  return output.join("\n");
}

// ------------------------------------------------------------- computer data

/** The store-tree nodes under one project: its blob paths by relative name. */
function projectFiles(tree, name) {
  const files = new Map();
  const prefix = `${name}/`;
  for (const node of tree ?? []) {
    if (node.type !== "blob" || !node.path.startsWith(prefix)) continue;
    files.set(node.path.slice(prefix.length), node);
  }
  return files;
}

/** A project's skills, from `<project>/skills/*` plus the store's `global/skills/*`. */
function skillsFromTree(tree, name, scope) {
  const out = [];
  const prefix = scope === "global" ? "global/skills/" : `${name}/skills/`;
  for (const node of tree ?? []) {
    if (node.type !== "blob" || !node.path.startsWith(prefix)) continue;
    const rest = node.path.slice(prefix.length);
    const folder = rest.match(/^([^/]+)\/SKILL\.md$/);
    const single = rest.match(/^([^/]+)\.md$/);
    const skillName = folder?.[1] ?? single?.[1];
    if (!skillName) continue;
    out.push({ path: node.path, sha: node.sha, name: skillName, scope });
  }
  return out;
}

export function mountProjects(root) {
  installStyles();
  root.classList.add("section-projects");

  const state = {
    merged: null,
    query: "",
    computer: "all",
    view: "grid",
    detail: null, // { computer, name }
    data: new Map(), // computer -> { projects: Map, tree, at }
    loading: new Set(),
    failures: new Map(), // computer -> message
  };

  const shell = el("div", "pj");
  const header = el("div", "pj-header");
  const body = el("div", "pj-body");
  shell.append(header, body);
  root.replaceChildren(shell);

  function openInAgents(computer, child) {
    showSection("agents");
    sectionHandle("agents")?.openSession?.(computer, child);
  }

  function onlineComputers() {
    return (state.merged?.computers ?? []).filter((c) => c.state === "online");
  }

  function sessionsFor(computer, name) {
    return allSessions(state.merged).filter((row) => row.computer === computer && projectOf(row.child) === name);
  }

  // ------------------------------------------------------------- loading

  async function readBlob(computer, sha) {
    const body = await hookGet(computer, "/v1/store/blob", { sha });
    return decodeBase64(body.content ?? "");
  }

  /** One project's card facts: the summary line, the counts, the file index. */
  async function hydrate(computer, project, tree) {
    const files = projectFiles(tree, project.name);
    project.files = files;
    project.counts = { findings: null, tasks: null };
    const summaryNode = files.get("summary.md");
    if (summaryNode) {
      try {
        const summary = await readBlob(computer, summaryNode.sha);
        const knows = parseKnows(summary);
        project.knows = knows?.text ?? null;
        project.summaryLine = knows?.summaryLine || firstLine(summary);
        if (knows?.counts.findings !== null) project.counts.findings = knows.counts.findings;
        if (knows?.counts.tasks !== null && knows?.counts.tasks !== undefined) project.counts.tasks = knows.counts.tasks;
      } catch { /* summary is optional detail */ }
    }
    const tasks = files.get("tasks.md"), findings = files.get("FINDINGS.md");
    if (project.counts.tasks === null && tasks) {
      try { project.counts.tasks = countOpenTasks(await readBlob(computer, tasks.sha)); } catch { /* stays unknown */ }
    }
    if (project.counts.findings === null && findings) {
      try { project.counts.findings = countActiveFindings(await readBlob(computer, findings.sha)); } catch { /* stays unknown */ }
    }
    return project;
  }

  function firstLine(text) {
    for (const raw of String(text).split("\n")) {
      const line = raw.replace(/^#+\s*/, "").trim();
      if (line && !line.startsWith("<!--")) return line;
    }
    return "";
  }

  async function loadComputer(computer, { force = false } = {}) {
    if (state.loading.has(computer)) return;
    if (state.data.has(computer) && !force) return;
    state.loading.add(computer);
    state.failures.delete(computer);
    render();
    try {
      const caps = await store.capabilities(computer);
      const projects = new Map();
      let tree = [];
      try {
        const body = await hookGet(computer, "/v1/projects/repos");
        for (const repo of body.repos ?? []) {
          if (repo.registered) projects.set(repo.name, { name: repo.name, directory: repo.directory, computer, lastSeen: repo.lastSeen });
        }
      } catch { /* a Hook without the route still lists projects from its store */ }
      if (caps.memoryStore) {
        try {
          const head = await hookGet(computer, "/v1/store/head");
          const listing = await hookGet(computer, "/v1/store/tree", { sha: head.sha });
          tree = Array.isArray(listing.tree) ? listing.tree : [];
          for (const node of tree) {
            if (node.type !== "blob") continue;
            // A project is a top-level folder of the store; skip loose files and dot folders.
            const slash = node.path.indexOf("/");
            if (slash <= 0) continue;
            const name = node.path.slice(0, slash);
            // Only folders holding Phren's own files are projects (not profiles/, scripts/, templates/).
            const file = node.path.slice(slash + 1);
            if (!/^(FINDINGS\.md|tasks\.md|summary\.md|phren\.project\.yaml)$/.test(file)) continue;
            if (name !== "global" && !name.startsWith(".") && !projects.has(name)) projects.set(name, { name, computer });
          }
        } catch { /* the store is unavailable; repos remain */ }
      }
      const wasDetail = state.detail && state.detail.computer === computer ? state.detail.name : null;
      await Promise.all([...projects.values()].map((project) => hydrate(computer, project, tree)));
      state.data.set(computer, { projects, tree, at: Date.now() });
      if (wasDetail) state.detail = { computer, name: wasDetail };
    } catch (err) {
      state.failures.set(computer, err?.message ?? String(err));
    } finally {
      state.loading.delete(computer);
      render();
    }
  }

  function ensureLoaded({ force = false } = {}) {
    for (const c of onlineComputers()) {
      if (force || !state.data.has(c.computer)) void loadComputer(c.computer, { force });
    }
  }

  /** Every card row for the current computer filter and search text. */
  function visibleProjects() {
    const query = state.query.trim().toLowerCase();
    const rows = [];
    const computers = state.computer === "all" ? onlineComputers().map((c) => c.computer) : [state.computer];
    for (const computer of computers) {
      const entry = state.data.get(computer);
      if (!entry) continue;
      for (const project of entry.projects.values()) {
        if (query && !project.name.toLowerCase().includes(query)) continue;
        rows.push(project);
      }
    }
    rows.sort((a, b) => a.name.localeCompare(b.name) || a.computer.localeCompare(b.computer));
    return rows;
  }

  // ------------------------------------------------------------- rendering

  function render() {
    renderHeader();
    if (state.view === "detail" && state.detail) renderDetail();
    else renderGrid();
  }

  function renderHeader() {
    clear(header);
    if (state.view === "detail" && state.detail) {
      const back = el("button", "pj-back", "\u2039 Projects");
      back.addEventListener("click", () => { state.view = "grid"; state.detail = null; render(); });
      const title = el("h1", "pj-title", state.detail.name);
      const host = el("span", "pj-host", state.detail.computer);
      const spacer = el("span", "pj-spacer");
      const launch = el("button", "pj-btn accent", "Launch agent");
      launch.addEventListener("click", () => openLaunch(state.detail.computer, state.detail.name));
      header.append(back, title, host, spacer);
      const knobsBtn = el("button", "pj-btn", "Knobs");
      knobsBtn.addEventListener("click", () => openKnobs(state.detail));
      header.append(knobsBtn, launch);
      return;
    }
    const title = el("h1", "pj-title", "Projects");
    const spacer = el("span", "pj-spacer");
    const search = document.createElement("input");
    search.type = "search";
    search.className = "pj-search";
    search.placeholder = "Filter projects";
    search.setAttribute("aria-label", "Filter projects");
    search.value = state.query;
    search.addEventListener("input", () => { state.query = search.value; renderGrid(); });
    const filter = document.createElement("select");
    filter.className = "pj-select";
    filter.setAttribute("aria-label", "Computer");
    const all = el("option", null, "All computers");
    all.value = "all";
    filter.append(all);
    for (const c of onlineComputers()) {
      const option = el("option", null, c.computer);
      option.value = c.computer;
      filter.append(option);
    }
    if (state.computer !== "all" && !onlineComputers().some((c) => c.computer === state.computer)) state.computer = "all";
    filter.value = state.computer;
    filter.addEventListener("change", () => { state.computer = filter.value; renderGrid(); });
    const add = el("button", "pj-btn", "Add project");
    add.addEventListener("click", openAddProject);
    const refresh = el("button", "pj-icon", "\u21bb");
    refresh.title = "Refresh";
    refresh.setAttribute("aria-label", "Refresh projects");
    refresh.addEventListener("click", () => ensureLoaded({ force: true }));
    header.append(title, spacer, search, filter, add, refresh);
  }

  function renderGrid() {
    clear(body);
    const rows = visibleProjects();
    const loading = onlineComputers().some((c) => state.loading.has(c.computer));
    const failures = [...state.failures.values()];
    if (!rows.length && (loading || !state.data.size)) {
      body.append(el("div", "pj-empty", loading ? "Reading projects\u2026" : "No computers are online."));
      return;
    }
    if (!rows.length) {
      body.append(el("div", "pj-empty", state.query.trim() ? "No matching projects." : "No projects yet. Add one from a computer."));
      return;
    }
    const grid = el("div", "pj-grid");
    for (const project of rows) grid.append(projectCard(project));
    body.append(grid);
    for (const message of failures) body.append(el("div", "pj-error", message));
  }

  function projectCard(project) {
    const card = el("button", "pj-card");
    const head = el("div", "pj-card-head");
    head.append(el("span", "pj-card-name", project.name));
    const sessions = sessionsFor(project.computer, project.name);
    const working = sessions.filter((row) => row.child.agentStatus === "working").length;
    if (working) head.append(el("span", "pj-dot working"));
    else if (sessions.some((row) => row.child.agentStatus === "blocked" || row.child.approvalPending)) head.append(el("span", "pj-dot waiting"));
    card.append(head);
    card.append(el("div", "pj-card-sub muted", project.computer));
    const summary = el("div", "pj-card-summary", project.summaryLine || "No summary yet.");
    card.append(summary);
    const stats = el("div", "pj-card-stats");
    if (typeof project.counts?.findings === "number") stats.append(el("span", "pj-stat", `${project.counts.findings} findings`));
    if (typeof project.counts?.tasks === "number") stats.append(el("span", "pj-stat", `${project.counts.tasks} open tasks`));
    if (sessions.length) stats.append(el("span", "pj-stat", `${sessions.length} session${sessions.length === 1 ? "" : "s"}`));
    const last = sessions.map((row) => row.child.lastChangedAt).filter(Boolean).sort().pop() || project.lastSeen;
    if (last) stats.append(el("span", "pj-stat", `active ${age(last)}`));
    card.append(stats);
    card.addEventListener("click", () => { state.view = "detail"; state.detail = { computer: project.computer, name: project.name }; loadDetailFiles(); render(); });
    return card;
  }

  // ------------------------------------------------------------- detail

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
          const content = await readBlob(detail.computer, skill.sha);
          const { frontmatter } = parseFrontmatter(content);
          return { ...skill, title: frontmatter?.name || skill.name, description: frontmatter?.description || "" };
        } catch { return { ...skill, title: skill.name, description: "" }; }
      }));
      project.skills = skillRows;
      const configNode = project.files?.get("phren.project.yaml");
      if (configNode) {
        try {
          project.knobYaml = await readBlob(detail.computer, configNode.sha);
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

    const summary = el("section", "pj-block");
    summary.append(el("h2", "section-label", "Summary"));
    summary.append(el("p", "pj-summary" + (project.knows || project.summaryLine ? "" : " muted"), project.knows || project.summaryLine || "No summary yet."));
    scope.append(summary);

    const work = el("section", "pj-block");
    work.append(el("h2", "section-label", "Open work"));
    const chips = el("div", "pj-chips");
    chips.append(el("span", "pj-chip", `${project.counts?.findings ?? 0} findings`));
    chips.append(el("span", "pj-chip", `${project.counts?.tasks ?? 0} open tasks`));
    work.append(chips);
    scope.append(work);

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

  // ------------------------------------------------------------- sheets

  let openSheetEl = null;

  function openSheet(title, { width = 460 } = {}) {
    closeSheet();
    const backdrop = el("div", "pj-backdrop");
    const panel = el("div", "pj-sheet");
    panel.style.maxWidth = `${width}px`;
    const head = el("div", "pj-sheet-head");
    const heading = el("h2", "pj-sheet-title", title);
    const close = el("button", "pj-icon", "\u00d7");
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", closeSheet);
    head.append(heading, el("span", "pj-spacer"), close);
    const bodyEl = el("div", "pj-sheet-body");
    const footer = el("div", "pj-sheet-footer");
    panel.append(head, bodyEl, footer);
    backdrop.append(panel);
    backdrop.addEventListener("mousedown", (event) => { if (event.target === backdrop) closeSheet(); });
    const onKey = (event) => { if (event.key === "Escape") closeSheet(); };
    document.addEventListener("keydown", onKey);
    document.body.append(backdrop);
    openSheetEl = { backdrop, onKey };
    return { bodyEl, footer };
  }

  function closeSheet() {
    if (!openSheetEl) return;
    document.removeEventListener("keydown", openSheetEl.onKey);
    openSheetEl.backdrop.remove();
    openSheetEl = null;
  }

  function field(labelText, control) {
    const wrap = el("label", "pj-field");
    wrap.append(el("span", "pj-field-label", labelText));
    wrap.append(control);
    return wrap;
  }

  function selectEl(options, selected) {
    const select = document.createElement("select");
    select.className = "pj-select wide";
    for (const [value, label] of options) {
      const option = el("option", null, label);
      option.value = value;
      select.append(option);
    }
    select.value = selected ?? options[0]?.[0] ?? "";
    return select;
  }

  function noticeBox() {
    const box = el("div", "pj-notice");
    box.hidden = true;
    return box;
  }

  function setNotice(box, text, danger) {
    box.textContent = text;
    box.className = danger ? "pj-notice danger" : "pj-notice";
    box.hidden = !text;
  }

  function openAddProject() {
    const hosts = onlineComputers();
    const { bodyEl, footer } = openSheet("Add project", { width: 520 });
    if (!hosts.length) {
      bodyEl.append(el("div", "pj-empty", "No computer is online. Phren adds a project from a computer running Phren Hook."));
      return;
    }
    const computer = selectEl(hosts.map((c) => [c.computer, c.computer]));
    const pathInput = document.createElement("input");
    pathInput.type = "text";
    pathInput.className = "pj-input mono";
    pathInput.placeholder = "/path/to/repository";
    bodyEl.append(field("Computer", computer), field("Repository folder", pathInput));

    const candidates = el("div", "pj-list");
    const repos = el("div", "pj-list");
    bodyEl.append(el("div", "pj-subhead", "Locate"), candidates, el("div", "pj-subhead", "Repositories on this computer"), repos);
    const notice = noticeBox();
    bodyEl.append(notice);

    async function loadRepos() {
      clear(repos);
      try {
        const found = await hookGet(computer.value, "/v1/projects/repos");
        const list = (found.repos ?? []).filter((repo) => !repo.registered);
        if (!list.length) { repos.append(el("div", "pj-empty slim", "Every repository here is already in phren.")); return; }
        for (const repo of list.slice(0, 40)) {
          const row = el("button", "pj-row");
          const main = el("div", "pj-row-main");
          main.append(el("span", "pj-row-title", repo.name));
          main.append(el("span", "pj-row-sub mono", repo.directory));
          row.append(main);
          row.addEventListener("click", () => { pathInput.value = repo.directory; setNotice(notice, ""); });
          repos.append(row);
        }
      } catch (err) {
        repos.append(el("div", "pj-error", err?.message ?? String(err)));
      }
    }

    const locate = footer.appendChild(el("button", "pj-btn", "Locate"));
    locate.addEventListener("click", async () => {
      const raw = pathInput.value.trim().replace(/\/+$/, "");
      const name = raw.split(/[\\/]/).filter(Boolean).pop() ?? "";
      if (!name) { setNotice(notice, "Enter a folder or project name to locate.", true); return; }
      locate.disabled = true;
      clear(candidates);
      try {
        const found = await hookGet(computer.value, "/v1/projects/locate", { project: name });
        const list = found.candidates ?? [];
        if (!list.length) { candidates.append(el("div", "pj-empty slim", `Nothing on ${computer.value} matches ${name}.`)); return; }
        for (const candidate of list) {
          const row = el("button", "pj-row");
          const main = el("div", "pj-row-main");
          main.append(el("span", "pj-row-title mono", candidate.directory));
          main.append(el("span", "pj-row-sub", `${candidate.source}${candidate.lastSeen ? ` \u00b7 ${age(candidate.lastSeen)}` : ""}`));
          row.append(main);
          row.addEventListener("click", () => { pathInput.value = candidate.directory; setNotice(notice, ""); });
          candidates.append(row);
        }
      } catch (err) {
        candidates.append(el("div", "pj-error", err?.message ?? String(err)));
      } finally {
        locate.disabled = false;
      }
    });

    const add = el("button", "pj-btn accent", "Add to phren");
    add.addEventListener("click", async () => {
      const directory = pathInput.value.trim();
      if (!directory) { setNotice(notice, "Enter or locate a repository folder first.", true); return; }
      add.disabled = true;
      setNotice(notice, `Adding on ${computer.value}\u2026`);
      try {
        const result = await hookPost(computer.value, "/v1/projects/add", { directory });
        const where = result.store === "pushed" ? "and synced its store" : result.store === "committed" ? "and committed its store" : "";
        setNotice(notice, `Added ${result.project} on ${computer.value}${where ? ` ${where}` : ""}.`);
        await loadComputer(computer.value, { force: true });
        state.computer = computer.value;
        setTimeout(closeSheet, 900);
      } catch (err) {
        setNotice(notice, err?.message ?? String(err), true);
        add.disabled = false;
      }
    });
    footer.append(add);
    computer.addEventListener("change", loadRepos);
    void loadRepos();
    autoFocus(pathInput);
  }

  function pollForSession(computer, target, name) {
    let tries = 0;
    const timer = setInterval(async () => {
      tries++;
      const rows = allSessions(state.merged).filter((row) => row.computer === computer);
      const match = target
        ? rows.find((row) => row.child.target && row.child.target.server === target.server && row.child.target.workspace === target.workspace && row.child.target.tab === target.tab && row.child.target.pane === target.pane)
        : rows.find((row) => projectOf(row.child) === name);
      if (match) { clearInterval(timer); openInAgents(match.computer, match.child); return; }
      if (tries >= 30) clearInterval(timer);
    }, 700);
  }

  async function openLaunch(computer, name) {
    const hosts = onlineComputers();
    const { bodyEl, footer } = openSheet(`Launch an agent in ${name}`, { width: 480 });
    const computerSelect = selectEl(hosts.map((c) => [c.computer, c.computer]), computer);

    const harnessSelect = selectEl([["", "Loading\u2026"]]);
    harnessSelect.disabled = true;
    const modelSelect = selectEl([["", "Harness default"]]);
    const permWrap = el("div", "pj-field");
    const permSelect = selectEl(PERMISSION_MODES);
    permWrap.append(el("span", "pj-field-label", "Permission mode"), permSelect);
    permWrap.hidden = true;

    const worktreeToggle = document.createElement("input");
    worktreeToggle.type = "checkbox";
    const worktreeLabel = el("label", "pj-toggle");
    worktreeLabel.append(worktreeToggle, el("span", null, "Start in a new worktree"));
    const branchInput = document.createElement("input");
    branchInput.type = "text";
    branchInput.className = "pj-input mono";
    branchInput.placeholder = "branch name";
    branchInput.value = `${name}-agent`;
    const worktreeField = field("New branch", branchInput);
    worktreeField.hidden = true;
    worktreeToggle.addEventListener("change", () => { worktreeField.hidden = !worktreeToggle.checked; });

    bodyEl.append(field("Computer", computerSelect), field("Harness", harnessSelect), field("Model", modelSelect), permWrap, worktreeLabel, worktreeField);
    const notice = noticeBox();
    bodyEl.append(notice);
    const launch = el("button", "pj-btn accent", "Launch");
    footer.append(launch);

    let harnesses = [];
    async function loadHarnesses() {
      try {
        const inventory = await hookGet(computerSelect.value, "/v1/harnesses");
        if (inventory.pending) throw new Error("This computer is still checking its harnesses. Try again in a moment.");
        harnesses = (inventory.harnesses ?? []).filter((entry) => entry.installed && entry.usable);
        if (!harnesses.length) throw new Error("No usable harness on this computer.");
        clear(harnessSelect);
        for (const entry of harnesses) {
          const option = el("option", null, `${HARNESS_LABELS[entry.source] ?? entry.source}${entry.version ? ` ${entry.version}` : ""}`);
          option.value = entry.source;
          harnessSelect.append(option);
        }
        harnessSelect.disabled = false;
        await loadModels();
      } catch (err) {
        clear(harnessSelect);
        harnessSelect.append(el("option", null, "Unavailable"));
        setNotice(notice, err?.message ?? String(err), true);
      }
    }

    async function loadModels() {
      clear(modelSelect);
      const fallback = el("option", null, "Harness default");
      fallback.value = "";
      modelSelect.append(fallback);
      const source = harnessSelect.value;
      try {
        const catalogue = await hookGet(computerSelect.value, "/v1/models", { source });
        for (const model of catalogue.models ?? []) {
          const option = el("option", null, model.name || model.id);
          option.value = model.id;
          modelSelect.append(option);
        }
      } catch { /* the harness default is always an option */ }
    }

    function syncPermission() {
      const source = harnessSelect.value;
      permWrap.hidden = !(source === "claude" || source === "codex") || !store.can(computerSelect.value, "launchPermissionMode");
    }

    harnessSelect.addEventListener("change", () => { syncPermission(); void loadModels(); });
    computerSelect.addEventListener("change", () => { void loadHarnesses(); });

    launch.addEventListener("click", async () => {
      const kind = harnessSelect.value;
      if (!kind) { setNotice(notice, "Choose a harness.", true); return; }
      const body = { project: name, kind, label: name };
      if (modelSelect.value) body.model = modelSelect.value;
      if (!permWrap.hidden && permSelect.value) body.permissionMode = permSelect.value;
      const branch = branchInput.value.trim();
      if (worktreeToggle.checked) {
        if (!branch) { setNotice(notice, "Name the worktree's branch.", true); return; }
        body.worktree = { branch };
      }
      launch.disabled = true;
      setNotice(notice, `Starting ${HARNESS_LABELS[kind] ?? kind} on ${computerSelect.value}\u2026`);
      try {
        const result = await hookPost(computerSelect.value, "/v1/workspaces/launch", body);
        setNotice(notice, result.reused ? "Joining the launch already in flight\u2026" : "Waiting for the session to appear\u2026");
        pollForSession(computerSelect.value, result.target, name);
        setTimeout(closeSheet, 600);
      } catch (err) {
        setNotice(notice, err?.message ?? String(err), true);
        launch.disabled = false;
      }
    });

    await store.capabilities(computerSelect.value);
    void loadHarnesses();
  }

  function encodeBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  async function openKnobs(detail) {
    const entry = state.data.get(detail.computer);
    const project = entry?.projects.get(detail.name);
    if (!project) return;
    const { bodyEl, footer } = openSheet(`Knobs for ${detail.name}`, { width: 460 });
    bodyEl.append(el("div", "pj-subhead", "Per-project overrides. Inherit global removes the key."));
    const selects = new Map();
    for (const [key, def] of Object.entries(KNOBS)) {
      const options = [["", "Inherit global"], ...def.options.map((value) => [value, value])];
      const select = selectEl(options, project.knobs?.[key] ?? "");
      selects.set(key, select);
      const wrap = field(def.label, select);
      wrap.title = def.caption;
      bodyEl.append(wrap);
    }
    const notice = noticeBox();
    bodyEl.append(notice);
    const save = el("button", "pj-btn accent", "Save");
    footer.append(save);
    save.addEventListener("click", async () => {
      const values = {};
      for (const [key, select] of selects) values[key] = select.value;
      const yaml = applyKnobs(project.knobYaml ?? "", values);
      save.disabled = true;
      setNotice(notice, "Saving\u2026");
      try {
        const result = await hookPost(detail.computer, "/v1/store/file", {
          path: `${detail.name}/phren.project.yaml`,
          content: encodeBase64(yaml),
          sha: project.knobSha ?? null,
        });
        project.knobYaml = yaml;
        project.knobSha = result.content?.sha ?? project.knobSha;
        project.knobs = parseKnobs(yaml);
        setNotice(notice, "Saved.");
        setTimeout(() => { closeSheet(); renderDetail(); }, 500);
      } catch (err) {
        setNotice(notice, err?.status === 409 ? "The file changed on the computer. Close and reopen knobs." : (err?.message ?? String(err)), true);
        save.disabled = false;
      }
    });
  }

  // ------------------------------------------------------------- lifecycle

  const unsubscribe = store.subscribe((merged) => {
    state.merged = merged;
    if (state.view === "detail" && state.detail) renderDetail();
    else renderGrid();
    ensureLoaded();
  });
  ensureLoaded();
  render();

  return {
    show() { ensureLoaded(); render(); },
    hide() {},
    destroy() { unsubscribe(); closeSheet(); },
  };
}

// The launch sheet: one modal to start any agent anywhere. Project, computer,
// harness, model, effort, permission mode, worktree/branch, Claude account and
// role (worker or conductor), with the least-loaded computer that has the
// project and the harness marked "recommended". Ports the phone's
// LaunchSessionView to the desktop's plain-DOM Phren look.

import { hookGet, hookPost } from "../api.js";
import { registerCommand } from "./palette.js";
import { projectOf, sessions as allSessions, store } from "./store.js";
import { sectionHandle, showSection } from "./sections.js";

const CSS_ID = "launch-styles";

// ---------------------------------------------------------------- constants
const HARNESS_LABELS = { claude: "Claude", codex: "Codex", opencode: "OpenCode", copilot: "Copilot", phren: "Phren" };
const HARNESS_ORDER = ["codex", "claude", "opencode", "copilot", "phren"];
const EFFORTS = [["low", "Low"], ["medium", "Medium"], ["high", "High"]];
const PERMISSIONS = [
  ["supervised", "Supervised"], ["auto-edits", "Auto edits"], ["auto", "Auto"], ["full-access", "Full access"],
];
const PERMISSION_HARNESSES = new Set(["claude", "codex"]);

// ---------------------------------------------------------------- helpers
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function installStyles() {
  if (document.getElementById(CSS_ID)) return;
  const link = document.createElement("link");
  link.id = CSS_ID;
  link.rel = "stylesheet";
  link.href = new URL("launch.css", import.meta.url).href;
  document.head.append(link);
}

function onlineComputers(merged) {
  return (merged?.computers ?? []).filter((c) => c.state === "online");
}

function harnessEntry(harnesses, source) {
  return (harnesses ?? []).find((entry) => entry.source === source) ?? null;
}

/** Whether a computer can start this harness: absent inventory (an older Hook)
 * offers everything, as the phone does. */
function harnessUsable(harnesses, source) {
  const entry = harnessEntry(harnesses, source);
  if (!entry) return harnesses ? false : true;
  return Boolean(entry.installed && entry.usable);
}

function freeDisk(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1000) return `${(gb / 1000).toFixed(1)} TB free`;
  if (gb >= 10) return `${Math.round(gb)} GB free`;
  return `${gb.toFixed(1)} GB free`;
}

function loadParts(resources) {
  const overall = resources?.pressure?.overall;
  const perCore = resources?.cpu?.loadPerCore;
  const value = typeof overall === "number" ? Math.max(0, Math.min(1, overall)) : 0;
  const level = resources?.level ?? "";
  return { value, level, perCore: typeof perCore === "number" ? perCore : null };
}

// ---------------------------------------------------------------- command
/** Open the launch sheet. `project` and `computer` prefill the choices, `role`
 * starts it as a worker ("agent") or a conductor. */
export function openLaunchSheet(options = {}) {
  installStyles();
  return open(options);
}

registerCommand({
  id: "launch-agent",
  title: "Launch an agent\u2026",
  group: "Commands",
  meta: "Any computer",
  run: () => openLaunchSheet(),
});

function field(labelText, ...nodes) {
  const wrap = el("div", "launch-field");
  wrap.append(el("span", "launch-label", labelText), ...nodes);
  return wrap;
}

function fillSegments(container, options, current, onPick) {
  container.replaceChildren();
  for (const [value, label, disabled] of options) {
    const btn = el("button", "launch-seg", label);
    btn.type = "button";
    if (value === current && !disabled) btn.classList.add("selected");
    btn.disabled = Boolean(disabled);
    btn.addEventListener("click", () => onPick(value));
    container.append(btn);
  }
}

function option(value, label) {
  const node = el("option", null, label);
  node.value = value;
  return node;
}

async function open({ project = "", computer = "", role = "agent" } = {}) {
  const state = {
    project: (project ?? "").trim(),
    computer: computer ?? "",
    harness: "",
    model: "",
    effort: "medium",
    permission: "",
    worktree: false,
    branch: "",
    account: "",
    role: role === "conductor" ? "conductor" : "agent",
    launching: false,
    profiles: new Map(),
    located: new Map(),
    models: new Map(),
    modelKey: "",
    recommended: "",
    projects: [],
    usage: null,
    error: "",
    status: "",
    autoComputer: !computer,
  };

  const backdrop = el("div", "launch-backdrop");
  const sheet = el("div", "launch-sheet");
  const head = el("div", "launch-head");
  const title = el("h2", "launch-title", "Launch an agent");
  const closeBtn = el("button", "launch-close", "\u00d7");
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.style.marginLeft = "auto";
  head.append(title, closeBtn);

  const body = el("div", "launch-body");
  const projectInput = document.createElement("input");
  projectInput.type = "text";
  projectInput.className = "launch-input mono";
  projectInput.placeholder = "project name";
  projectInput.value = state.project;
  projectInput.setAttribute("list", "launch-projects");
  projectInput.setAttribute("autocomplete", "off");
  projectInput.setAttribute("aria-label", "Project");
  const datalist = document.createElement("datalist");
  datalist.id = "launch-projects";
  const projectField = field("Project", projectInput);
  projectField.append(datalist);

  const computerList = el("div", "launch-computers");
  const computerHint = el("div", "launch-hint");
  const computerField = field("Computer", computerList, computerHint);

  const roleRow = el("div", "launch-segments");
  const roleField = field("Role", roleRow);

  const harnessRow = el("div", "launch-segments");
  const harnessNote = el("div", "launch-note");
  const harnessField = field("Harness", harnessRow, harnessNote);

  const modelSelect = el("select", "launch-select");
  modelSelect.setAttribute("aria-label", "Model");
  const modelField = field("Model", modelSelect);

  const effortRow = el("div", "launch-segments");
  const effortField = field("Effort", effortRow);

  const permRow = el("div", "launch-segments");
  const permField = field("Permission mode", permRow);

  const accountSelect = el("select", "launch-select");
  accountSelect.setAttribute("aria-label", "Claude account");
  const accountField = field("Account", accountSelect);

  const worktreeToggle = document.createElement("input");
  worktreeToggle.type = "checkbox";
  const worktreeLabel = el("label", "launch-toggle");
  worktreeLabel.append(worktreeToggle, el("span", null, "Start in a new worktree"));
  const branchInput = document.createElement("input");
  branchInput.type = "text";
  branchInput.className = "launch-input mono";
  branchInput.placeholder = "phren/branch-name";
  branchInput.setAttribute("aria-label", "Worktree branch");
  const worktreeField = field("Worktree", worktreeLabel, branchInput);

  const errorEl = el("div", "launch-error");
  const noteEl = el("div", "launch-note", "Creates a workspace on the computer, starts the agent in it, and opens the chat here. Starting can take up to a minute.");
  body.append(projectField, computerField, harnessField, modelField, effortField, permField, worktreeField, accountField, roleField, errorEl, noteEl);

  const foot = el("div", "launch-foot");
  const statusEl = el("div", "launch-status");
  const launchBtn = el("button", "launch-btn accent", "Launch");
  launchBtn.type = "button";
  foot.append(statusEl, launchBtn);

  sheet.append(head, body, foot);
  backdrop.append(sheet);
  backdrop.addEventListener("mousedown", (ev) => { if (ev.target === backdrop) close(); });
  const onKey = (ev) => { if (ev.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  document.body.append(backdrop);

  const ui = {
    state, close, title, projectInput, datalist, computerList, computerHint, roleRow, roleField,
    harnessRow, harnessNote, harnessField, modelSelect, modelField, effortRow, effortField,
    permRow, permField, accountSelect, accountField, worktreeToggle, worktreeField, branchInput,
    errorEl, statusEl, launchBtn, noteEl,
  };

  let unsubscribe = null;
  function close() {
    document.removeEventListener("keydown", onKey);
    unsubscribe?.();
    backdrop.remove();
  }

  closeBtn.addEventListener("click", close);

  let debounce = null;
  projectInput.addEventListener("input", () => {
    state.project = projectInput.value.trim();
    clearTimeout(debounce);
    debounce = setTimeout(() => { void loadLocated(ui); }, 450);
    refreshLaunch(ui);
  });

  worktreeToggle.addEventListener("change", () => {
    state.worktree = worktreeToggle.checked;
    branchInput.hidden = !state.worktree;
    if (state.worktree && !state.branch) state.branch = `${state.project || "agent"}-agent`;
    if (state.worktree) branchInput.value = state.branch;
    refreshLaunch(ui);
  });
  branchInput.hidden = true;
  branchInput.addEventListener("input", () => { state.branch = branchInput.value; refreshLaunch(ui); });

  launchBtn.addEventListener("click", () => void doLaunch(ui));

  renderRole(ui);
  renderWorktree(ui);
  renderComputers(ui);
  renderHarness(ui);
  renderEffort(ui);
  refreshLaunch(ui);

  projectInput.focus();

  void loadProjects(ui);
  void loadUsage(ui);
  await bootstrap(ui);
  renderAll(ui);

  unsubscribe = store.subscribe(() => {
    for (const c of onlineComputers(store.merged)) if (!state.profiles.has(c.computer)) void loadProfile(ui, c.computer);
    if (!state.computer) void bootstrap(ui);
    renderComputers(ui);
    renderRecommendation(ui);
  });

  return { close };
}

/** Load every online computer's profile, then choose a computer and harness if
 * none is chosen yet. Safe to call again when computers appear later. */
async function bootstrap(ui) {
  const online = onlineComputers(store.merged);
  if (!online.length) return;
  await Promise.all(online.map((c) => loadProfile(ui, c.computer)));
  if (ui.state.project && ui.state.located.size === 0) await loadLocated(ui);
  if (!ui.state.computer) pickInitial(ui);
  renderAll(ui);
}

// ---------------------------------------------------------------- render
function renderAll(ui) {
  renderComputers(ui);
  renderRole(ui);
  renderWorktree(ui);
  renderHarness(ui);
  renderEffort(ui);
  renderPermission(ui);
  renderAccount(ui);
  void renderModel(ui);
  renderRecommendation(ui);
  refreshLaunch(ui);
}

function renderComputers(ui) {
  const state = ui.state;
  ui.computerList.replaceChildren();
  const computers = store.merged?.computers ?? [];
  if (!computers.length) {
    ui.computerList.append(el("div", "launch-note", "No computers are connected. Phren starts sessions on a computer running Phren Hook."));
    return;
  }
  const online = computers.filter((c) => c.state === "online");
  const offline = computers.filter((c) => c.state !== "online");
  for (const c of [...online, ...offline]) {
    const profile = state.profiles.get(c.computer);
    const row = el("button", "launch-computer");
    row.type = "button";
    if (c.computer === state.computer) row.classList.add("selected");
    const dot = el("span", `launch-dot ${c.state === "online" ? "online" : "dim"}`);
    const main = el("div", "launch-computer-main");
    const name = el("div", "launch-computer-name");
    name.append(dot, el("span", null, c.computer));
    if (c.computer === state.recommended) name.append(el("span", "launch-chip recommended", "recommended"));
    main.append(name);
    const sub = el("div", "launch-computer-sub");
    if (c.state !== "online") {
      sub.append(el("span", null, c.error ? String(c.error) : "offline"));
    } else if (!profile || profile.loading) {
      sub.append(el("span", null, "Reading\u2026"));
    } else {
      const lp = loadParts(profile.resources);
      sub.append(el("span", null, lp.perCore != null ? `${lp.perCore.toFixed(2)} load/core` : "load unknown"));
      const disk = freeDisk(profile.resources?.disk?.freeBytes);
      if (disk) sub.append(el("span", null, disk));
      const working = profile.capacity?.working;
      if (typeof working === "number") sub.append(el("span", null, `${working} working`));
      const room = accountRoom(profile.capacity?.usage);
      if (room) sub.append(el("span", null, room));
    }
    main.append(sub);
    row.append(main);
    if (c.state === "online" && profile && !profile.loading) {
      const lp = loadParts(profile.resources);
      const bar = el("div", "launch-loadbar");
      const fill = el("div", `launch-loadfill${lp.level === "stressed" ? " stressed" : lp.level === "busy" ? " busy" : ""}`);
      fill.style.width = `${Math.round(lp.value * 100)}%`;
      bar.append(fill);
      row.append(bar);
    }
    row.addEventListener("click", () => selectComputer(ui, c.computer));
    ui.computerList.append(row);
  }
}

function renderRole(ui) {
  rolePresentation(ui, ui.state.role);
  fillSegments(ui.roleRow, [["agent", "Agent"], ["conductor", "Conductor"]], ui.state.role, (value) => {
    rolePresentation(ui, value);
    ui.state.permission = "";
    if (value === "conductor" && ui.state.harness === "phren") ui.state.harness = firstUsable(ui, ui.state.computer);
    renderWorktree(ui);
    renderHarness(ui);
    renderPermission(ui);
    refreshLaunch(ui);
  });
}

function rolePresentation(ui, value) {
  ui.state.role = value;
  const conductor = value === "conductor";
  ui.title.textContent = conductor ? "Start the conductor" : "Launch an agent";
  ui.noteEl.textContent = conductor
    ? "Starts the store\u2019s conductor on the computer you choose; it sends work into any project from there."
    : "Creates a workspace on the computer, starts the agent in it, and opens the chat here. Starting can take up to a minute.";
}

function renderWorktree(ui) {
  ui.worktreeField.hidden = ui.state.role === "conductor";
}

function renderHarness(ui) {
  const state = ui.state;
  const profile = state.profiles.get(state.computer);
  const harnesses = profile?.harnesses ?? null;
  ui.harnessRow.replaceChildren();
  if (state.computer && profile?.loading) {
    ui.harnessNote.textContent = "Reading this computer\u2019s harnesses\u2026";
    return;
  }
  const kinds = HARNESS_ORDER.filter((kind) => (kind === "phren" ? harnessEntry(harnesses, kind) : true));
  let usable = 0;
  for (const kind of kinds) {
    const entry = harnessEntry(harnesses, kind);
    const can = harnessUsable(harnesses, kind);
    const conductorBlocked = state.role === "conductor" && kind === "phren";
    const disabled = !can || conductorBlocked;
    if (can && !conductorBlocked) usable++;
    const btn = el("button", "launch-seg", HARNESS_LABELS[kind] ?? kind);
    btn.type = "button";
    if (state.harness === kind && !disabled) btn.classList.add("selected");
    btn.disabled = disabled;
    if (conductorBlocked) btn.title = "Can\u2019t run as a conductor";
    else if (!can && entry?.reason) btn.title = entry.reason;
    btn.addEventListener("click", () => selectHarness(ui, kind));
    ui.harnessRow.append(btn);
  }
  if (!ui.harnessRow.childNodes.length) ui.harnessRow.append(el("span", "launch-note", "No harnesses listed."));
  ui.harnessNote.textContent = harnesses && !usable ? `No signed-in harness on ${state.computer || "this computer"}.` : "";
}

function renderEffort(ui) {
  const state = ui.state;
  ui.effortField.hidden = !supportsEffort(state.harness);
  fillSegments(ui.effortRow, EFFORTS, state.effort, (value) => { state.effort = value; renderEffort(ui); });
}

function renderPermission(ui) {
  const state = ui.state;
  const can = store.can(state.computer, "launchPermissionMode");
  ui.permField.hidden = !(PERMISSION_HARNESSES.has(state.harness) && can === true);
  fillSegments(ui.permRow, [["", "Harness default"], ...PERMISSIONS], state.permission, (value) => {
    state.permission = value;
    renderPermission(ui);
  });
}

function renderAccount(ui) {
  const state = ui.state;
  const profile = state.profiles.get(state.computer);
  const entry = harnessEntry(profile?.harnesses, "claude");
  const accounts = (entry?.accounts ?? []).filter((account) => account.usable && account.id !== "default");
  ui.accountField.hidden = state.harness !== "claude" || accounts.length === 0;
  if (ui.accountField.hidden) { state.account = ""; return; }
  ui.accountSelect.replaceChildren(option("", "Default"), ...accounts.map((account) => option(account.id, account.label || account.id)));
  if (!accounts.some((account) => account.id === state.account)) state.account = "";
  ui.accountSelect.value = state.account;
  if (!ui.accountSelect.dataset.wired) {
    ui.accountSelect.dataset.wired = "1";
    ui.accountSelect.addEventListener("change", () => {
      state.account = ui.accountSelect.value;
      state.models.delete(`${state.computer}|${state.harness}|${state.account}`);
      void renderModel(ui);
    });
  }
}

async function renderModel(ui) {
  const state = ui.state;
  const kind = state.harness;
  ui.modelField.hidden = !supportsModel(kind);
  if (ui.modelField.hidden) { state.model = ""; return; }
  const key = `${state.computer}|${kind}|${state.account}`;
  state.modelKey = key;
  const cached = state.models.get(key);
  if (!cached) {
    ui.modelSelect.replaceChildren(option("", "Loading\u2026"));
    try {
      const query = { source: kind, ...(state.account ? { account: state.account } : {}) };
      const catalogue = await hookGet(state.computer, "/v1/models", query);
      state.models.set(key, catalogue.models ?? []);
    } catch { state.models.set(key, []); }
    if (state.modelKey !== key) return;
  }
  const models = state.models.get(key) ?? [];
  ui.modelSelect.replaceChildren(option("", "Harness default"), ...models.map((model) => option(model.id, model.name || model.id)));
  if (!models.some((model) => model.id === state.model)) state.model = "";
  ui.modelSelect.value = state.model;
  if (!ui.modelSelect.dataset.wired) {
    ui.modelSelect.dataset.wired = "1";
    ui.modelSelect.addEventListener("change", () => { state.model = ui.modelSelect.value; refreshLaunch(ui); });
  }
  refreshLaunch(ui);
}

function selectComputer(ui, computer) {
  const state = ui.state;
  state.computer = computer;
  state.autoComputer = false;
  state.harness = "";
  state.model = "";
  state.account = "";
  state.permission = "";
  state.models.clear();
  void store.capabilities(computer).then(() => { renderPermission(ui); });
  const first = firstUsable(ui, computer);
  if (first) state.harness = first;
  renderAll(ui);
}

function selectHarness(ui, kind) {
  const state = ui.state;
  state.autoComputer = false;
  state.harness = kind;
  state.model = "";
  state.permission = "";
  renderHarness(ui);
  renderEffort(ui);
  renderPermission(ui);
  renderAccount(ui);
  void renderModel(ui);
  renderRecommendation(ui);
  refreshLaunch(ui);
}

function refreshLaunch(ui) {
  const state = ui.state;
  ui.errorEl.textContent = state.error;
  ui.statusEl.textContent = state.status;
  ui.launchBtn.disabled = !launchReady(ui);
  ui.launchBtn.textContent = state.launching ? "Launching\u2026"
    : state.role === "conductor" ? "Start the conductor"
      : state.project ? `Open ${state.project}` : "Start chat";
}

function launchReady(ui) {
  const state = ui.state;
  if (state.launching) return false;
  if (!state.computer) return false;
  const profile = state.profiles.get(state.computer);
  if (!profile || profile.loading || !harnessUsable(profile.harnesses, state.harness)) return false;
  if (state.role === "conductor" && state.harness === "phren") return false;
  if (state.role !== "conductor" && !state.project) return false;
  if (state.worktree && state.role !== "conductor" && !state.branch.trim()) return false;
  return true;
}

// ---------------------------------------------------------------- selection
function supportsModel(kind) { return ["codex", "claude", "copilot", "opencode"].includes(kind); }
function supportsEffort(kind) { return ["codex", "claude", "copilot", "opencode", "phren"].includes(kind); }

function accountRoom(usage) {
  const rows = (usage ?? []).filter((row) => row && (typeof row.leftPercent === "number" || row.exhausted));
  if (!rows.length) return "";
  const min = rows.reduce((a, b) => ((a.leftPercent ?? 101) <= (b.leftPercent ?? 101) ? a : b));
  if (min.exhausted) return `${min.source} out of quota`;
  return `${min.source} ${Math.round(min.leftPercent)}% left`;
}

function firstUsable(ui, computer) {
  const profile = ui.state.profiles.get(computer);
  const harnesses = profile?.harnesses;
  const kinds = ui.state.role === "conductor" ? HARNESS_ORDER.filter((kind) => kind !== "phren") : HARNESS_ORDER;
  // Prefer a harness whose account still has quota on that computer.
  const exhausted = new Set((profile?.capacity?.usage ?? []).filter((row) => row?.exhausted).map((row) => String(row.source)));
  if (harnesses) {
    for (const kind of kinds) if (harnessUsable(harnesses, kind) && !exhausted.has(kind)) return kind;
    for (const kind of kinds) if (harnessUsable(harnesses, kind)) return kind;
    return "";
  }
  return kinds.find((kind) => !exhausted.has(kind)) ?? "codex";
}

function someUsable(harnesses) {
  if (!harnesses) return true;
  return harnesses.some((entry) => entry.installed && entry.usable);
}

function hasProject(ui, computer) {
  if (!ui.state.project) return true;
  const dirs = ui.state.located.get(computer);
  return Array.isArray(dirs) && dirs.length > 0;
}

function recommend(ui) {
  const state = ui.state;
  const candidates = onlineComputers(store.merged).filter((c) => {
    const harnesses = state.profiles.get(c.computer)?.harnesses;
    return (state.harness ? harnessUsable(harnesses, state.harness) : someUsable(harnesses)) && hasProject(ui, c.computer);
  });
  if (!candidates.length) return "";
  const score = (c) => {
    const resources = state.profiles.get(c.computer)?.resources;
    return typeof resources?.pressure?.overall === "number" ? resources.pressure.overall : 1;
  };
  candidates.sort((a, b) => score(a) - score(b) || a.computer.localeCompare(b.computer));
  return candidates[0].computer;
}

function renderRecommendation(ui) {
  const state = ui.state;
  state.recommended = recommend(ui);
  const parts = [];
  if (state.recommended) parts.push(`Recommended: ${state.recommended}`);
  const usage = state.usage;
  if (usage?.accounts?.length) {
    const out = usage.accounts.filter((account) => account.exhausted).length;
    parts.push(`${usage.accounts.length} account${usage.accounts.length === 1 ? "" : "s"}${out ? `, ${out} out of quota` : ""}`);
  }
  ui.computerHint.textContent = parts.join(" \u00b7 ");
  renderComputers(ui);
}

function pickInitial(ui) {
  const state = ui.state;
  const online = onlineComputers(store.merged);
  if (!online.length) return;
  if (state.computer && !online.some((c) => c.computer === state.computer)) { state.computer = ""; state.harness = ""; }
  if (!state.computer) {
    const rec = recommend(ui);
    state.computer = (rec && online.some((c) => c.computer === rec)) ? rec : online[0].computer;
  }
  if (!state.harness || !harnessUsable(state.profiles.get(state.computer)?.harnesses, state.harness)) {
    state.harness = firstUsable(ui, state.computer);
  }
  void store.capabilities(state.computer).then(() => renderPermission(ui));
}

// ---------------------------------------------------------------- loading
async function loadProfile(ui, computer) {
  const state = ui.state;
  if (state.profiles.has(computer)) return state.profiles.get(computer);
  state.profiles.set(computer, { loading: true, resources: null, capacity: null, harnesses: null });
  const [resources, capacity] = await Promise.all([
    readResources(computer),
    hookGet(computer, "/v1/dispatch/capacity").catch(() => null),
  ]);
  let harnesses = capacity?.harnesses ?? null;
  if (!harnesses) {
    try {
      const inventory = await hookGet(computer, "/v1/harnesses");
      harnesses = inventory.pending ? null : inventory.harnesses ?? null;
    } catch { /* an older Hook offers everything */ }
  }
  state.profiles.set(computer, { loading: false, resources, capacity, harnesses });
  renderComputers(ui);
  renderHarness(ui);
  renderRecommendation(ui);
  return state.profiles.get(computer);
}

async function readResources(computer) {
  const fromStore = (store.merged?.computers ?? []).find((c) => c.computer === computer)?.resources;
  if (fromStore) return fromStore;
  try { return (await hookGet(computer, "/v1/resources")).resources ?? null; } catch { return null; }
}

async function loadProjects(ui) {
  const names = new Set();
  await Promise.all(onlineComputers(store.merged).map(async (c) => {
    try {
      const body = await hookGet(c.computer, "/v1/projects/repos");
      for (const repo of body.repos ?? []) if (repo.registered) names.add(repo.name);
    } catch { /* a Hook without the route still takes a typed name */ }
  }));
  ui.state.projects = [...names].sort((a, b) => a.localeCompare(b));
  ui.datalist.replaceChildren(...ui.state.projects.map((name) => option(name, name)));
}

async function loadUsage(ui) {
  try {
    const res = await fetch("/api/usage", { cache: "no-store" });
    if (res.ok) ui.state.usage = await res.json();
  } catch { /* the usage hint is optional */ }
  renderRecommendation(ui);
}

async function loadLocated(ui) {
  const state = ui.state;
  const project = state.project;
  state.located = new Map();
  if (project) {
    await Promise.all(onlineComputers(store.merged).map(async (c) => {
      try {
        const found = await hookGet(c.computer, "/v1/projects/locate", { project });
        state.located.set(c.computer, (found.candidates ?? []).map((item) => item.directory));
      } catch { state.located.set(c.computer, []); }
    }));
  }
  if (state.autoComputer && project) {
    const rec = recommend(ui);
    if (rec) { state.computer = rec; state.harness = ""; state.model = ""; state.account = ""; }
    state.autoComputer = false;
  }
  pickInitial(ui);
  renderAll(ui);
}

// ---------------------------------------------------------------- launch
async function doLaunch(ui) {
  const state = ui.state;
  if (!launchReady(ui)) return;
  state.error = "";
  const kind = state.harness;
  const label = state.role === "conductor" ? "Conductor" : state.project;
  const body = { kind, label, launchId: crypto.randomUUID() };
  if (state.role === "conductor") body.role = "conductor";
  else body.project = state.project;
  if (state.model && supportsModel(kind)) body.model = state.model;
  if (supportsEffort(kind)) body.effort = state.effort;
  if (PERMISSION_HARNESSES.has(kind) && state.permission) body.permissionMode = state.permission;
  if (kind === "claude" && state.account) body.account = state.account;
  if (state.worktree && state.role !== "conductor") body.worktree = { branch: state.branch.trim() };

  state.launching = true;
  state.status = `Starting ${HARNESS_LABELS[kind] ?? kind}\u2026`;
  refreshLaunch(ui);
  try {
    const result = await hookPost(state.computer, "/v1/workspaces/launch", body);
    state.status = result.reused ? "Joining the launch already in flight\u2026" : "Waiting for the session to appear\u2026";
    refreshLaunch(ui);
    const match = await waitForSession(state.computer, result, 20_000);
    if (match) { openInAgents(match.computer, match.child); ui.close(); return; }
    state.launching = false;
    state.status = "";
    state.error = "The session was created, but it has not appeared yet. Find it in Agents.";
    refreshLaunch(ui);
  } catch (err) {
    state.launching = false;
    state.status = "";
    state.error = err?.message ?? String(err);
    refreshLaunch(ui);
  }
}

function waitForSession(computer, reply, timeout) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeout;
    const check = () => {
      const found = allSessions(store.merged).find((row) => row.computer === computer && matchesRow(row, reply));
      if (found) { resolve(found); return; }
      if (Date.now() >= deadline) { resolve(null); return; }
      setTimeout(check, 700);
    };
    check();
  });
}

function matchesRow(row, reply) {
  const target = row.child.target;
  if (reply.target && target) {
    return target.server === reply.target.server && target.workspace === reply.target.workspace
      && target.tab === reply.target.tab && target.pane === reply.target.pane;
  }
  if (reply.cwd && row.child.cwd === reply.cwd) return true;
  return Boolean(reply.label) && projectOf(row.child) === reply.label;
}

function openInAgents(computer, child) {
  showSection("agents");
  sectionHandle("agents")?.openSession?.(computer, child);
}

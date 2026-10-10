// Conductor: the running conductor and its dispatches, the owner inbox,
// standing grants, linked computer sets and the release authority policy.
// This is the phone's Conductor screens, drawn with the desktop shell's CSS.
// Everything reads through each computer's Hook (the daemon's /hosts proxy).
import { hookGet, hookPost } from "../api.js";
import { sessions, store } from "../shell/store.js";
import { sectionHandle, showSection } from "../shell/sections.js";

const CSS_ID = "conductor-css";
const POLL_MS = 15_000;
const MAX_DISPATCHES = 60;
const HARNESSES = [["codex", "Codex"], ["claude", "Claude"], ["opencode", "OpenCode"]];
const TABS = [
  ["dispatches", "Dispatches"],
  ["inbox", "Inbox"],
  ["grants", "Grants"],
  ["sets", "Sets"],
  ["authority", "Authority"],
];

/** Add this section's stylesheet once (index.html does not load it). */
function ensureCss() {
  if (document.getElementById(CSS_ID)) return;
  const link = document.createElement("link");
  link.id = CSS_ID;
  link.rel = "stylesheet";
  link.href = "./sections/conductor.css";
  document.head.append(link);
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
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

function harnessLabel(kind) {
  return (HARNESSES.find(([id]) => id === kind) ?? [kind, kind])[1];
}

/** The scope title a grant shows: "Everywhere" or the project name. */
function scopeTitle(scope) {
  return String(scope ?? "").startsWith("project:") ? String(scope).slice("project:".length) : "Everywhere";
}

/** The word a return or worker state shows, and its chip class. */
function stateChip(state) {
  switch (String(state)) {
    case "done": return { label: "done", cls: "done" };
    case "needs-you": return { label: "needs you", cls: "needs" };
    case "blocked": return { label: "blocked", cls: "needs" };
    case "stalled": return { label: "stalled", cls: "needs" };
    case "failed": return { label: "failed", cls: "failed" };
    case "gone": return { label: "gone", cls: "gone" };
    case "working": return { label: "working", cls: "working" };
    case "launching": return { label: "launching", cls: "working" };
    case "sending": return { label: "sending", cls: "working" };
    case "accepted": return { label: "accepted", cls: "working" };
    case "uncertain": return { label: "uncertain", cls: "needs" };
    case "idle": return { label: "idle", cls: "" };
    case "closed": return { label: "closed", cls: "gone" };
    default: return { label: String(state ?? "unknown"), cls: "" };
  }
}

export function mountConductor(root) {
  ensureCss();
  root.innerHTML = `
    <div class="conductor">
      <header class="conductor-head">
        <div class="conductor-headtop">
          <h1 class="conductor-title">Conductor</h1>
          <span class="conductor-sub" data-sub></span>
          <span class="conductor-spacer"></span>
          <button class="conductor-btn ghost" data-refresh>Refresh</button>
        </div>
        <div class="conductor-card" data-card></div>
      </header>
      <nav class="conductor-tabs" role="tablist" data-tabs></nav>
      <div class="conductor-error" data-error hidden></div>
      <div class="conductor-panels" data-panels>
        <section class="conductor-panel" data-panel="dispatches"></section>
        <section class="conductor-panel" data-panel="inbox" hidden></section>
        <section class="conductor-panel" data-panel="grants" hidden></section>
        <section class="conductor-panel" data-panel="sets" hidden></section>
        <section class="conductor-panel" data-panel="authority" hidden></section>
      </div>
    </div>`;

  const subEl = root.querySelector("[data-sub]");
  const cardEl = root.querySelector("[data-card]");
  const tabsEl = root.querySelector("[data-tabs]");
  const errorEl = root.querySelector("[data-error]");
  const panels = new Map(TABS.map(([id]) => [id, root.querySelector(`[data-panel="${id}"]`)]));

  const state = {
    tab: "dispatches",
    pick: null,             // the computer the non-dispatch tabs read, when no conductor runs
    conductor: null,        // { computer, child } from the overview, when one runs
    hookConductors: new Map(), // computer -> { server, target } | null, from GET /v1/conductor
    receipts: new Map(),    // computer -> [{ receipt, computer }]
    inbox: null,            // { items, unreachable }
    grants: null,           // [grant]
    sets: null,             // { sets, unlinked, peerError }
    authority: null,        // { source, projects, confirmations }
    error: "",
    loading: false,
    pending: false,
    cardSig: "",
    loaded: {}, // tab id -> true once its data has arrived
  };

  // ---- shared lookups -------------------------------------------------

  const onlineComputers = () => (store.merged?.computers ?? []).filter((c) => c.state === "online");

  /** The active computer: the conductor's, the owner's pick, or the first online. */
  function activeComputer() {
    if (state.conductor) return state.conductor.computer;
    if (state.pick && onlineComputers().some((c) => c.computer === state.pick)) return state.pick;
    return onlineComputers()[0]?.computer ?? null;
  }

  function setError(text) {
    state.error = text ?? "";
    errorEl.hidden = !state.error;
    errorEl.textContent = state.error;
  }

  // ---- header card ----------------------------------------------------

  function conductorCard() {
    const found = sessions().find((row) => row.child.role === "conductor") ?? null;
    state.conductor = found;
    const online = onlineComputers().map((c) => `${c.computer}:${c.state}`).join(",");
    const sig = found
      ? `run:${found.computer}:${found.child.id}:${found.child.agentStatus}:${found.child.approvalPending}`
      : `none:${online}:${state.pick ?? ""}:${sessions().length}`;
    if (sig === state.cardSig) return;
    state.cardSig = sig;
    cardEl.replaceChildren();
    if (found) renderRunning();
    else renderNone();
    renderTabs();
  }

  function renderRunning() {
    const { computer, child } = state.conductor;
    const card = el("div", "conductor-run");
    card.append(el("span", "conductor-dot working"));
    const main = el("div", "conductor-run-main");
    main.append(el("div", "conductor-run-title", child.title || child.label || "Conductor"));
    const meta = el("div", "conductor-run-meta");
    meta.append(el("span", "conductor-host", computer));
    const live = child.agentStatus === "working" ? "working"
      : child.agentStatus === "blocked" || child.approvalPending ? "waiting" : child.agentStatus || "idle";
    meta.append(el("span", `conductor-state ${live}`, live));
    if (child.role) meta.append(el("span", "conductor-role", "conductor"));
    main.append(meta);
    card.append(main);
    const actions = el("div", "conductor-run-actions");
    actions.append(button("Open", "conductor-btn", () => openConductor(computer, child)));
    actions.append(stopButton(computer));
    card.append(actions);
    cardEl.append(card);
  }

  /** A Stop button that asks inline before stopping the conductor. */
  function stopButton(computer) {
    const wrap = el("span", "conductor-confirm");
    const stop = button("Stop", "conductor-btn danger", () => {
      wrap.replaceChildren(el("span", "conductor-ask", "Stop?"), button("Stop", "conductor-btn danger", () => { void stopConductor(computer); }),
        button("Cancel", "conductor-btn ghost", () => wrap.replaceChildren(stop)));
    });
    wrap.append(stop);
    return wrap;
  }

  function renderNone() {
    const card = el("div", "conductor-none");
    card.append(el("div", "conductor-none-title", "No conductor is running"));
    const online = onlineComputers();
    if (!online.length) {
      card.append(el("div", "conductor-none-note", "No computer is online."));
      cardEl.append(card);
      return;
    }
    const field = el("div", "conductor-field");
    field.append(el("span", "conductor-field-label", "On"));
    const select = el("select", "conductor-select");
    for (const c of online) {
      const option = el("option", null, c.computer);
      option.value = c.computer;
      select.append(option);
    }
    const known = state.pick && online.some((c) => c.computer === state.pick);
    select.value = known ? state.pick : online[0].computer;
    select.addEventListener("change", () => { state.pick = select.value; renderTabs(); void loadActiveTab(); });
    const harness = el("select", "conductor-select");
    for (const [id, label] of HARNESSES) {
      const option = el("option", null, label);
      option.value = id;
      harness.append(option);
    }
    const start = button("Start", "conductor-btn accent", () => { void startConductor(select.value, harness.value, start, note); });
    const note = el("span", "conductor-field-note");
    field.append(select, harness, start, note);
    card.append(field);
    // Promoting an agent already running in a pane needs no launch.
    const agents = sessions().filter((row) => !row.child.role && row.child.target);
    if (agents.length) {
      card.append(el("div", "conductor-none-label", "Or give the role to a running agent"));
      const list = el("div", "conductor-promote");
      for (const row of agents.slice(0, 24)) {
        const item = el("button", "conductor-promote-row");
        item.append(el("span", "conductor-promote-title", row.child.title || row.child.label || row.child.id));
        item.append(el("span", "conductor-promote-host", row.computer));
        item.addEventListener("click", () => { void makeConductor(row.computer, row.child, item); });
        list.append(item);
      }
      card.append(list);
    }
    cardEl.append(card);
  }

  function button(label, cls, onClick) {
    const node = el("button", cls, label);
    node.addEventListener("click", onClick);
    return node;
  }

  function openConductor(computer, child) {
    showSection("agents");
    sectionHandle("agents")?.openSession(computer, child);
  }

  // ---- actions --------------------------------------------------------

  async function startConductor(computer, harness, btn, note) {
    if (!computer) return;
    btn.disabled = true;
    note.textContent = `Starting on ${computer}\u2026`;
    try {
      await hookPost(computer, "/v1/workspaces/launch", { role: "conductor", kind: harness, label: "Conductor" });
      note.textContent = `Conductor starting on ${computer}.`;
      void poll();
    } catch (err) {
      note.textContent = err?.status === 409 ? "A conductor is already running." : `Could not start: ${err?.message || err}`;
    } finally {
      btn.disabled = false;
    }
  }

  async function stopConductor(computer) {
    const row = state.conductor;
    const body = row?.child?.target?.pane ? { paneId: row.child.target.pane } : {};
    try {
      await hookPost(computer, "/v1/conductor/stop", body);
      void poll();
    } catch (err) {
      setError(`Could not stop the conductor: ${err?.message || err}`);
    }
  }

  async function makeConductor(computer, child, item) {
    const target = child.target ?? {};
    item.disabled = true;
    try {
      await hookPost(computer, "/v1/conductor/make", {
        ...(target.workspace ? { workspaceId: target.workspace } : {}),
        ...(target.tab ? { tabId: target.tab } : {}),
        paneId: target.pane,
      });
      void poll();
    } catch (err) {
      item.disabled = false;
      setError(`Could not make a conductor: ${err?.message || err}`);
    }
  }

  // ---- tabs -----------------------------------------------------------

  function tabCount(id) {
    if (id === "dispatches") return dispatchRows().length;
    if (id === "inbox") return state.inbox?.items?.length ?? 0;
    if (id === "grants") return state.grants?.length ?? 0;
    if (id === "sets") return state.sets?.sets?.length ?? 0;
    if (id === "authority") return state.authority?.projects?.length ?? 0;
    return 0;
  }

  function renderTabs() {
    tabsEl.replaceChildren(...TABS.map(([id, label]) => {
      const tab = el("button", `conductor-tab${state.tab === id ? " selected" : ""}`);
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(state.tab === id));
      tab.append(document.createTextNode(label));
      const count = tabCount(id);
      if (count) tab.append(el("span", "conductor-tab-count", String(count)));
      tab.addEventListener("click", () => { selectTab(id); void loadActiveTab(); });
      return tab;
    }));
  }

  function selectTab(id) {
    state.tab = id;
    for (const [panelId, panel] of panels) panel.hidden = panelId !== id;
    renderTabs();
  }

  // ---- dispatch rows --------------------------------------------------

  function rowStamp(r) {
    const at = r?.returned?.at ?? r?.at ?? r?.updatedAt ?? r?.createdAt ?? "";
    const value = Date.parse(at);
    return Number.isFinite(value) ? value : 0;
  }

  function rowState(r) {
    if (r?.returned?.state) return r.returned.state;
    if (r?.worker?.state) return r.worker.state;
    return r?.state ?? "unknown";
  }

  function rowExcerpt(r) {
    return String(r?.returned?.reply ?? r?.returned?.question ?? r?.returned?.error
      ?? r?.reply ?? r?.question ?? r?.error ?? "").split("\n").find((line) => line.trim())?.trim() ?? "";
  }

  /** Receipts from every computer, each showing its latest return, newest first.
   * `/v1/dispatch/returns` is not read: it marks returns read, which would take
   * them from the conductor's own `dispatch_returns`. Receipts carry `returned`. */
  function dispatchRows() {
    const rows = [];
    const seen = new Set();
    for (const list of state.receipts.values()) {
      for (const entry of list) {
        const id = entry.receipt?.id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        rows.push(entry);
      }
    }
    rows.sort((a, b) => rowStamp(b.receipt) - rowStamp(a.receipt));
    return rows;
  }

  /** The overview child whose target matches a receipt's, so a row opens its chat. */
  function overviewChild(target) {
    if (!target) return null;
    for (const row of sessions()) {
      const t = row.child.target;
      if (t && t.server === target.server && t.workspace === target.workspace && t.tab === target.tab
        && t.pane === target.pane && t.session === target.session) return row;
    }
    return null;
  }

  function dispatchRow(entry) {
    const r = entry.receipt;
    const chip = stateChip(rowState(r));
    const row = el("div", "conductor-row");
    const main = el("div", "conductor-row-main");
    main.append(el("div", "conductor-row-title", r.label || r.project || r.id || "Worker"));
    const meta = el("div", "conductor-row-meta");
    meta.append(el("span", `conductor-chip ${chip.cls}`, chip.label));
    if (r.project) meta.append(el("span", "conductor-project", r.project));
    if (r.harness) meta.append(el("span", "conductor-harness", harnessLabel(r.harness)));
    meta.append(el("span", "conductor-host", entry.computer || r.computer || ""));
    const stamp = age(r.returned?.at ?? r.at ?? r.updatedAt ?? r.createdAt);
    if (stamp) meta.append(el("span", "conductor-age", stamp));
    main.append(meta);
    const excerpt = rowExcerpt(r);
    if (excerpt) main.append(el("div", "conductor-row-sub", excerpt.slice(0, 220)));
    row.append(main);
    const match = overviewChild(r.target);
    if (match) {
      row.classList.add("clickable");
      row.addEventListener("click", () => openConductor(match.computer, match.child));
    }
    return row;
  }

  function renderDispatches() {
    const panel = panels.get("dispatches");
    const rows = dispatchRows().slice(0, MAX_DISPATCHES);
    if (!state.loaded.dispatches) { panel.replaceChildren(el("div", "conductor-empty", "Loading dispatches\u2026")); return; }
    if (!rows.length) { panel.replaceChildren(el("div", "conductor-empty", "No dispatches yet.")); return; }
    panel.replaceChildren(...rows.map(dispatchRow));
  }

  // ---- inbox ----------------------------------------------------------

  function inboxRow(item) {
    const row = el("div", "conductor-row");
    const main = el("div", "conductor-row-main");
    main.append(el("div", "conductor-row-title", item.title));
    const meta = el("div", "conductor-row-meta");
    const kind = item.kind === "blocked" ? { label: "blocked", cls: "needs" }
      : item.kind === "needs-you" ? { label: "needs you", cls: "needs" } : { label: "manual", cls: "" };
    meta.append(el("span", `conductor-chip ${kind.cls}`, kind.label));
    if (item.project) meta.append(el("span", "conductor-project", item.project));
    const where = item.computer || item.inboxComputer;
    if (where) meta.append(el("span", "conductor-host", where));
    if (item.live === false) meta.append(el("span", "conductor-chip gone", "no longer live"));
    meta.append(el("span", "conductor-age", age(item.updatedAt || item.createdAt)));
    main.append(meta);
    row.append(main);
    const actions = el("div", "conductor-row-actions");
    const match = overviewChild(item.target);
    if (match) actions.append(button("Open", "conductor-btn ghost", () => openConductor(match.computer, match.child)));
    if (item.actionId && item.dispatch) {
      actions.append(button("Approve", "conductor-btn accent", () => { void answerInbox(item, "approve"); }));
      actions.append(button("Deny", "conductor-btn danger", () => { void answerInbox(item, "deny"); }));
    }
    actions.append(button("Resolve", "conductor-btn ghost", () => { void resolveInbox(item); }));
    row.append(actions);
    return row;
  }

  function renderInbox() {
    const panel = panels.get("inbox");
    if (!state.loaded.inbox) { panel.replaceChildren(el("div", "conductor-empty", "Loading inbox\u2026")); return; }
    const items = state.inbox?.items ?? [];
    const nodes = [];
    if (!items.length) nodes.push(el("div", "conductor-empty", "The owner inbox is empty."));
    else nodes.push(...items.map(inboxRow));
    for (const bad of state.inbox?.unreachable ?? []) {
      nodes.push(el("div", "conductor-note", `${bad.computer}: ${bad.error ?? "unreachable"}`));
    }
    panel.replaceChildren(...nodes);
  }

  // ---- grants ---------------------------------------------------------

  let grantFormOpen = false;

  function grantRow(grant, index, computer) {
    const row = el("div", "conductor-card-row");
    const main = el("div", "conductor-row-main");
    main.append(el("div", "conductor-row-title", scopeTitle(grant.scope)));
    const meta = el("div", "conductor-row-meta");
    for (const action of grant.actions ?? []) meta.append(el("span", "conductor-chip action", action === "hand_off" ? "Hand off" : "Dispatch"));
    meta.append(el("span", "conductor-chip host", grant.computers ? grant.computers.join(", ") : "Any computer"));
    main.append(meta);
    main.append(el("div", "conductor-row-sub", grant.until ? `Until ${new Date(grant.until).toLocaleString()}` : "Until revoked"));
    row.append(main);
    const actions = el("div", "conductor-row-actions");
    const wrap = el("span", "conductor-confirm");
    const revoke = button("Revoke", "conductor-btn danger", () => {
      wrap.replaceChildren(el("span", "conductor-ask", "Revoke?"),
        button("Revoke", "conductor-btn danger", () => { void revokeGrant(computer, index, grant); }),
        button("Keep", "conductor-btn ghost", () => wrap.replaceChildren(revoke)));
    });
    wrap.append(revoke);
    actions.append(wrap);
    row.append(actions);
    return row;
  }

  function grantForm(computer) {
    const form = el("div", "conductor-form");
    const scopeKind = el("select", "conductor-select");
    for (const [id, label] of [["global", "Everywhere"], ["project", "One project"]]) {
      const option = el("option", null, label);
      option.value = id;
      scopeKind.append(option);
    }
    const slug = el("input", "conductor-input");
    slug.placeholder = "project slug";
    slug.hidden = true;
    scopeKind.addEventListener("change", () => { slug.hidden = scopeKind.value !== "project"; });
    const dispatch = checkbox("Dispatch", true);
    const handOff = checkbox("Hand off", false);
    const computers = el("input", "conductor-input");
    computers.placeholder = "Computers (names, comma separated; any when blank)";
    const expires = el("input", "conductor-input");
    expires.type = "datetime-local";
    const note = el("span", "conductor-form-note");
    const save = button("Add grant", "conductor-btn accent", () => { void addGrant(computer, { scopeKind, slug, dispatch, handOff, computers, expires }, save, note); });
    const cancel = button("Cancel", "conductor-btn ghost", () => { grantFormOpen = false; renderGrants(); });
    const fields = el("div", "conductor-form-fields");
    fields.append(labelWrap("Scope", scopeKind), slug, labelWrap("Actions", rowOf(dispatch.node, handOff.node)), computers, labelWrap("Expires", expires));
    form.append(fields, el("div", "conductor-form-actions"), note);
    form.querySelector(".conductor-form-actions").append(save, cancel);
    return form;
  }

  function labelWrap(text, node) {
    const wrap = el("label", "conductor-form-label");
    wrap.append(el("span", null, text), node);
    return wrap;
  }

  function rowOf(...nodes) {
    const row = el("span", "conductor-form-row");
    row.append(...nodes);
    return row;
  }

  function checkbox(label, checked) {
    const wrap = el("label", "conductor-check");
    const input = el("input");
    input.type = "checkbox";
    input.checked = checked;
    wrap.append(input, el("span", null, label));
    return { node: wrap, input };
  }

  function renderGrants() {
    const panel = panels.get("grants");
    if (!state.loaded.grants) { panel.replaceChildren(el("div", "conductor-empty", "Loading grants\u2026")); return; }
    const computer = activeComputer();
    const nodes = [];
    const head = el("div", "conductor-panel-head");
    head.append(el("span", "conductor-panel-on", computer ? `On ${computer}` : "No computer online"));
    head.append(el("span", "conductor-spacer"));
    if (!grantFormOpen) head.append(button("Add grant", "conductor-btn", () => { grantFormOpen = true; renderGrants(); }));
    nodes.push(head);
    const grants = state.grants ?? [];
    if (!grants.length) nodes.push(el("div", "conductor-empty", "No standing grants. A conductor in auto mode does not need one."));
    else nodes.push(...grants.map((grant, index) => grantRow(grant, index, computer)));
    if (grantFormOpen) nodes.push(grantForm(computer));
    panel.replaceChildren(...nodes);
  }

  // ---- sets -----------------------------------------------------------

  const LINK_BADGE = { self: "done", "two-way": "done", "one-way": "needs", indirect: "", unknown: "" };
  const LINK_WORD = { self: "Linked", "two-way": "Linked", "one-way": "One-way", indirect: "Indirect", unknown: "Unknown" };

  function setRow(computer) {
    const row = el("div", "conductor-set-row");
    if (computer.conductor) row.classList.add("is-conductor");
    const name = el("span", "conductor-set-name", computer.name);
    if (computer.conductor) name.append(el("span", "conductor-chip conductor", "conductor"));
    row.append(name);
    const meta = el("div", "conductor-set-meta");
    const link = LINK_BADGE[computer.link] ?? "";
    meta.append(el("span", `conductor-chip ${link}`, LINK_WORD[computer.link] ?? "Unknown"));
    if (computer.reachable === false) meta.append(el("span", "conductor-chip failed", "unreachable"));
    row.append(meta);
    if (computer.hint || computer.error) row.append(el("div", "conductor-row-sub", computer.error || computer.hint));
    return row;
  }

  function renderSets() {
    const panel = panels.get("sets");
    if (!state.loaded.sets) { panel.replaceChildren(el("div", "conductor-empty", "Loading sets\u2026")); return; }
    const snapshot = state.sets ?? { sets: [], unlinked: [] };
    const nodes = [];
    if (snapshot.peerError) nodes.push(el("div", "conductor-note", `Peer directory: ${snapshot.peerError}`));
    for (const set of snapshot.sets ?? []) {
      const block = el("div", "conductor-set");
      const head = el("div", "conductor-set-head");
      const title = el("span", "conductor-set-title", set.name?.trim() || "Linked");
      head.append(title);
      if (set.local) head.append(el("span", "conductor-chip local", "this computer"));
      if ((set.conductors ?? 0) > 1) head.append(el("span", "conductor-chip failed", `${set.conductors} conductors`));
      if (set.local) {
        head.append(el("span", "conductor-spacer"));
        head.append(setRename(set));
      }
      block.append(head);
      block.append(...(set.computers ?? []).map(setRow));
      nodes.push(block);
    }
    if (!nodes.length) nodes.push(el("div", "conductor-empty", "No linked computers."));
    if (snapshot.unlinked?.length) {
      nodes.push(el("div", "conductor-panel-head", "Unlinked"));
      for (const row of snapshot.unlinked) {
        const item = el("div", "conductor-set-row");
        item.append(el("span", "conductor-set-name", row.name));
        item.append(el("div", "conductor-set-meta", el("span", "conductor-chip", "unlinked")));
        item.append(el("div", "conductor-row-sub", `Run phren bridge link ${row.name} on a linked computer.`));
        nodes.push(item);
      }
    }
    panel.replaceChildren(...nodes);
  }

  function setRename(set) {
    const wrap = el("span", "conductor-rename");
    const input = el("input", "conductor-input");
    input.value = set.name ?? "";
    input.placeholder = "Set name";
    input.maxLength = 60;
    const note = el("span", "conductor-form-note");
    const save = button("Rename", "conductor-btn ghost", () => { void renameSet(input.value, save, note); });
    wrap.append(input, save, note);
    return wrap;
  }

  // ---- authority ------------------------------------------------------

  function renderAuthority() {
    const panel = panels.get("authority");
    if (!state.loaded.authority) { panel.replaceChildren(el("div", "conductor-empty", "Loading release authority\u2026")); return; }
    const policy = state.authority ?? { projects: [], confirmations: [] };
    const nodes = [];
    nodes.push(el("div", "conductor-note", "Choose which release actions the conductor may carry out and which need your word. These rules do not lift an agent's own permission checks."));
    if (!(policy.projects ?? []).length) nodes.push(el("div", "conductor-empty", "No project has release restrictions. Everything is go."));
    for (const project of policy.projects ?? []) {
      const row = el("div", "conductor-card-row");
      const main = el("div", "conductor-row-main");
      main.append(el("div", "conductor-row-title", project.project));
      const meta = el("div", "conductor-row-meta");
      for (const action of project.go ?? []) meta.append(el("span", "conductor-chip done", `go: ${action}`));
      for (const action of project.ask ?? []) meta.append(el("span", "conductor-chip needs", `ask: ${action}`));
      main.append(meta);
      main.append(el("div", "conductor-row-sub", project.line));
      row.append(main);
      if (project.ask?.length) {
        const actions = el("div", "conductor-row-actions");
        actions.append(button("Confirm", "conductor-btn", () => { void confirmAuthority(project.project, project.ask); }));
        row.append(actions);
      }
      nodes.push(row);
    }
    const pending = policy.confirmations ?? [];
    if (pending.length) {
      nodes.push(el("div", "conductor-panel-head", "Confirmations waiting"));
      for (const confirmation of pending) {
        const row = el("div", "conductor-set-row");
        row.append(el("span", "conductor-set-name", confirmation.project));
        row.append(el("div", "conductor-set-meta", el("span", "conductor-chip needs", (confirmation.actions ?? []).join(", "))));
        row.append(el("div", "conductor-row-sub", `Expires ${new Date(confirmation.expiresAt).toLocaleString()}`));
        nodes.push(row);
      }
    }
    panel.replaceChildren(...nodes);
  }

  // ---- data loaders ---------------------------------------------------

  /** DELETE a Hook route (api.js has only GET and POST). */
  async function hookDelete(computer, route, body) {
    const res = await fetch(`/hosts/${encodeURIComponent(computer)}${route}`, {
      method: "DELETE", headers: { "Content-Type": "application/json", "X-Phren-Desktop": "1" }, body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { error: text.slice(0, 300) }; }
    if (!res.ok) {
      const error = new Error(parsed.error || `The Hook answered ${res.status}.`);
      error.status = res.status;
      error.code = parsed.code;
      error.body = parsed;
      throw error;
    }
    return parsed;
  }

  async function loadDispatches() {
    const online = onlineComputers().map((c) => c.computer);
    const results = await Promise.all(online.map(async (computer) => {
      const body = await hookGet(computer, "/v1/dispatch").catch(() => null);
      return { computer, dispatches: Array.isArray(body?.dispatches) ? body.dispatches : [] };
    }));
    state.receipts.clear();
    for (const result of results) {
      state.receipts.set(result.computer, result.dispatches.map((receipt) => ({ receipt, computer: receipt.computer || result.computer })));
    }
    state.loaded.dispatches = true;
    renderDispatches();
    renderTabs();
  }

  async function loadConductorStatus() {
    const results = await Promise.all(onlineComputers().map(async (c) => {
      try { return [c.computer, (await hookGet(c.computer, "/v1/conductor"))?.conductor ?? null]; }
      catch { return [c.computer, null]; }
    }));
    state.hookConductors = new Map(results);
  }

  async function loadInbox() {
    const computer = activeComputer();
    if (!computer) { state.inbox = { items: [], unreachable: [] }; state.loaded.inbox = true; renderInbox(); renderTabs(); return; }
    try {
      const body = await hookGet(computer, "/v1/owner-inbox");
      state.inbox = { items: Array.isArray(body.items) ? body.items : [], unreachable: Array.isArray(body.unreachable) ? body.unreachable : [] };
    } catch (err) {
      state.inbox = { items: [], unreachable: [] };
      setError(err?.status === 404 ? `The owner inbox needs a newer Phren on ${computer}.` : `Could not load the inbox: ${err?.message || err}`);
    }
    state.loaded.inbox = true;
    renderInbox();
    renderTabs();
  }

  async function loadGrants() {
    const computer = activeComputer();
    if (!computer) { state.grants = []; state.loaded.grants = true; renderGrants(); renderTabs(); return; }
    try {
      const body = await hookGet(computer, "/v1/conductor/grants");
      state.grants = Array.isArray(body.grants) ? body.grants : [];
    } catch (err) {
      state.grants = [];
      setError(err?.status === 404 ? `Grants need the conductor module on ${computer}.` : `Could not load grants: ${err?.message || err}`);
    }
    state.loaded.grants = true;
    renderGrants();
    renderTabs();
  }

  async function loadSets() {
    const computer = activeComputer();
    if (!computer) { state.sets = { sets: [], unlinked: [] }; state.loaded.sets = true; renderSets(); renderTabs(); return; }
    try {
      const body = await hookGet(computer, "/v1/sets");
      state.sets = { sets: Array.isArray(body.sets) ? body.sets : [], unlinked: Array.isArray(body.unlinked) ? body.unlinked : [], peerError: body.peerError };
    } catch (err) {
      state.sets = { sets: [], unlinked: [] };
      setError(err?.status === 404 ? `Sets need a newer Phren on ${computer}.` : `Could not load sets: ${err?.message || err}`);
    }
    state.loaded.sets = true;
    renderSets();
    renderTabs();
  }

  async function loadAuthority() {
    const computer = activeComputer();
    if (!computer) { state.authority = { projects: [], confirmations: [] }; state.loaded.authority = true; renderAuthority(); renderTabs(); return; }
    try {
      const body = await hookGet(computer, "/v1/authority");
      state.authority = { source: body.source, projects: Array.isArray(body.projects) ? body.projects : [], confirmations: Array.isArray(body.confirmations) ? body.confirmations : [] };
    } catch (err) {
      state.authority = { projects: [], confirmations: [] };
      setError(err?.status === 404 ? `Release authority needs the conductor module on ${computer}.` : `Could not load release authority: ${err?.message || err}`);
    }
    state.loaded.authority = true;
    renderAuthority();
    renderTabs();
  }

  function loadTab(tab) {
    if (tab === "dispatches") return loadDispatches();
    if (tab === "inbox") return loadInbox();
    if (tab === "grants") return loadGrants();
    if (tab === "sets") return loadSets();
    if (tab === "authority") return loadAuthority();
    return Promise.resolve();
  }

  const loadActiveTab = () => loadTab(state.tab);

  function updateSub() {
    const online = onlineComputers().length;
    const active = activeComputer();
    const remote = [...state.hookConductors].filter(([, value]) => value).map(([computer]) => computer);
    if (!online) subEl.textContent = "No computer online";
    else if (state.conductor) subEl.textContent = `${online} online \u00b7 ${active}`;
    else if (remote.length) subEl.textContent = `A conductor reports on ${remote.join(", ")}`;
    else subEl.textContent = `${online} online \u00b7 ${active}`;
  }

  async function poll() {
    if (state.loading) { state.pending = true; return; }
    state.loading = true;
    setError("");
    try {
      conductorCard();
      const jobs = [loadDispatches(), loadConductorStatus()];
      if (state.tab !== "dispatches") jobs.push(loadActiveTab());
      await Promise.all(jobs);
      updateSub();
    } finally {
      state.loading = false;
      if (state.pending) { state.pending = false; void poll(); }
    }
  }

  // ---- grant, set, authority, inbox actions ---------------------------

  async function revokeGrant(computer, index, grant) {
    try {
      await hookDelete(computer, "/v1/conductor/grants", { index, expected: grant });
      await loadGrants();
    } catch (err) {
      setError(err?.status === 409 ? "The grants list changed. Refresh it before revoking." : `Could not revoke: ${err?.message || err}`);
      await loadGrants();
    }
  }

  async function addGrant(computer, form, save, note) {
    if (!computer) return;
    const actions = [];
    if (form.dispatch.input.checked) actions.push("dispatch");
    if (form.handOff.input.checked) actions.push("hand_off");
    const kind = form.scopeKind.value;
    const slug = form.slug.value.trim();
    if (kind === "project" && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(slug)) { note.textContent = "Enter a project slug."; return; }
    if (!actions.length) { note.textContent = "Choose at least one action."; return; }
    const grant = { scope: kind === "project" ? `project:${slug}` : "global", actions };
    const names = form.computers.value.split(",").map((name) => name.trim()).filter(Boolean);
    if (names.length) grant.computers = names;
    if (form.expires.value) grant.until = new Date(form.expires.value).toISOString();
    save.disabled = true;
    try {
      await hookPost(computer, "/v1/conductor/grants", grant);
      grantFormOpen = false;
      await loadGrants();
    } catch (err) {
      note.textContent = err?.status === 409 ? (err?.message || "That grant is already listed.") : `Could not add: ${err?.message || err}`;
      save.disabled = false;
    }
  }

  async function renameSet(name, save, note) {
    const computer = activeComputer();
    if (!computer) return;
    const trimmed = name.trim();
    save.disabled = true;
    try {
      const body = await hookPost(computer, "/v1/sets/name", { name: trimmed || null });
      const missed = Array.isArray(body.unreachable) ? body.unreachable.map((row) => row.computer) : [];
      note.textContent = missed.length ? `Named; ${missed.join(", ")} did not answer.` : "Set named.";
      await loadSets();
    } catch (err) {
      note.textContent = `Could not rename: ${err?.message || err}`;
    } finally {
      save.disabled = false;
    }
  }

  async function confirmAuthority(project, actions) {
    const computer = activeComputer();
    if (!computer) return;
    try {
      await hookPost(computer, "/v1/authority/confirm", { project, actions });
      await loadAuthority();
    } catch (err) {
      setError(`Could not confirm: ${err?.message || err}`);
    }
  }

  function itemHost(item) {
    if (!item?.inboxComputer || item.inboxComputer === "local") return activeComputer();
    return item.inboxComputer;
  }

  async function resolveInbox(item) {
    const computer = itemHost(item);
    if (!computer) return;
    try {
      await hookPost(computer, "/v1/owner-inbox", { action: "resolve", id: item.id });
      await loadInbox();
    } catch (err) {
      setError(`Could not resolve: ${err?.message || err}`);
    }
  }

  async function answerInbox(item, decision) {
    const computer = itemHost(item);
    if (!computer || !item.dispatch || !item.actionId) return;
    try {
      await hookPost(computer, "/v1/dispatch/approve", { id: item.dispatch, decision, actionId: item.actionId });
      await loadInbox();
    } catch (err) {
      setError(err?.status === 409 ? "That approval changed or is gone." : `Could not answer: ${err?.message || err}`);
    }
  }

  // ---- wiring ---------------------------------------------------------

  root.querySelector("[data-refresh]").addEventListener("click", () => { void poll(); });

  let timer = null;
  function startPoll() { if (!timer) timer = setInterval(() => { void poll(); }, POLL_MS); }
  function stopPoll() { if (timer) { clearInterval(timer); timer = null; } }

  const unsubscribe = store.subscribe(() => { conductorCard(); });

  selectTab("dispatches");
  // A section first shown starts polling here; one mounted hidden waits for show().
  if (!root.hidden) { startPoll(); void poll(); }

  return {
    show() { startPoll(); void poll(); },
    hide() { stopPoll(); },
    destroy() { stopPoll(); unsubscribe(); },
  };
}

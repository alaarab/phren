// Home: the cockpit. Top to bottom, the conductor card, who needs you (with
// keyboard answers), what is working (with each agent's activity line), recent
// returns from dispatched workers, and how every computer is doing.
import { hookGet, hookPost, targetQuery } from "../api.js";
import { needsYou, projectOf, sessions, store } from "../shell/store.js";
import { showSection } from "../shell/sections.js";

// Receipts drive both the conductor's latest line and the recent-returns list.
const RETURN_POLL_MS = 30_000;
const MAX_RETURNS = 5;
const RETURN_STATE = { "done": "done", "needs-you": "needs you", "failed": "failed", "blocked": "blocked", "gone": "gone", "stalled": "stalled" };

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

/** Elapsed since a row last changed, from its `lastChangedAt`. */
function elapsed(child) {
  const iso = child && child.lastChangedAt;
  return iso ? age(iso) : "";
}

function gb(bytes) {
  return `${(Number(bytes) / 1_073_741_824).toFixed(1)} GB`;
}

export function mountHome(root, { openSession } = {}) {
  const open = typeof openSession === "function" ? openSession : () => {};
  root.innerHTML = `
    <div class="home">
      <section class="home-block" data-block="conductor">
        <div class="home-list" data-conductor></div>
      </section>
      <section class="home-block" data-block="needs">
        <h2 class="section-label">Needs you <span class="count"></span></h2>
        <p class="home-keys">Up/Down select &middot; <kbd>Enter</kbd> approve &middot; <kbd>P</kbd> allow for this project &middot; <kbd>D</kbd> deny &middot; <kbd>O</kbd> open</p>
        <div class="home-list"></div>
      </section>
      <section class="home-block" data-block="working">
        <h2 class="section-label">Working <span class="count"></span></h2>
        <div class="home-list"></div>
      </section>
      <section class="home-block" data-block="returns">
        <h2 class="section-label">Recent returns <span class="count"></span></h2>
        <div class="home-list"></div>
      </section>
      <section class="home-block" data-block="computers">
        <h2 class="section-label">Computers <span class="count"></span></h2>
        <div class="home-list"></div>
      </section>
    </div>`;
  const block = (name) => root.querySelector(`[data-block="${name}"]`);

  let merged = null;
  let visible = false;
  let selected = 0;
  let pollTimer = null;
  const approvals = new Map(); // row.key -> { actionId, summary }
  const watchers = new Map(); // row.key -> WebSocket
  const receipts = new Map(); // computer -> [{ receipt, computer }]

  /** The shared row shape: a title/sub column on the left, caller-added meta right. */
  function rowShell({ tone, sub, selected: on }) {
    const button = el("button", `home-row${tone ? ` tone-${tone}` : ""}${on ? " selected" : ""}`);
    const main = el("div", "home-row-main");
    const title = el("span", "home-row-title");
    main.append(title);
    if (sub) main.append(sub);
    button.append(main);
    return { button, title };
  }

  function needsSub(row) {
    const info = approvals.get(row.key);
    if (info?.summary) return el("span", "home-row-sub", info.summary);
    return undefined;
  }

  function sessionRow(row, { tone, selected: on, sub }) {
    const shell = rowShell({ tone, sub, selected: on });
    const child = row.child;
    shell.title.textContent = child.title || child.label || projectOf(child);
    const metaEl = el("span", "home-row-meta");
    metaEl.append(el("span", "home-project", projectOf(child)), el("span", "home-host", row.computer));
    if (child.approvalPending || child.agentStatus === "blocked") metaEl.append(el("span", "home-why", child.approvalPending ? "Approval" : "Blocked"));
    const age = elapsed(child);
    if (age) metaEl.append(el("span", "home-age", age));
    shell.button.append(metaEl);
    shell.button.addEventListener("click", () => open(row.computer, child));
    return shell.button;
  }

  function fill(name, rows, empty) {
    const scope = block(name);
    if (!scope) return;
    const count = scope.querySelector(".count");
    if (count) count.textContent = rows.length ? String(rows.length) : "";
    const list = scope.querySelector(".home-list");
    list.replaceChildren(...rows);
    if (!rows.length) list.append(el("div", "home-empty", empty));
  }

  function renderNeeds() {
    const rows = needsYou(merged);
    if (selected >= rows.length) selected = Math.max(0, rows.length - 1);
    fill("needs", rows.map((row, index) => sessionRow(row, {
      tone: "waiting", selected: index === selected, sub: needsSub(row),
    })), "Nothing needs you.");
    block("needs").querySelector(".home-keys").hidden = !rows.length;
    syncWatchers(rows);
  }

  function renderWorking() {
    const needKeys = new Set(needsYou(merged).map((r) => r.key));
    const rows = sessions(merged).filter((r) => r.child.agentStatus === "working" && !needKeys.has(r.key));
    fill("working", rows.map((row) => {
      // The overview's current step is the agent's activity verb ("Editing server.ts").
      const activity = row.child.currentStep || row.child.activity || row.child.activityVerb;
      const sub = activity ? el("span", "home-row-sub activity", String(activity)) : undefined;
      return sessionRow(row, { tone: "working", sub });
    }), "No agent is working.");
  }

  // ---- recent returns -------------------------------------------------

  function overviewChild(target) {
    if (!target) return null;
    for (const row of sessions(merged)) {
      const t = row.child.target;
      if (t && t.server === target.server && t.workspace === target.workspace && t.tab === target.tab
        && t.pane === target.pane && t.source === target.source && t.session === target.session) return row;
    }
    return null;
  }

  function returnRow(entry) {
    const r = entry.receipt;
    const state = String(r.returned.state);
    const chip = state === "failed" ? "failed" : state === "done" ? "done" : state === "gone" ? "gone" : "needs";
    const tone = chip === "needs" ? "waiting" : undefined;
    const excerpt = (r.returned.reply || r.returned.question || r.returned.error || "").split("\n").find((line) => line.trim());
    const sub = excerpt ? el("span", "home-row-sub", excerpt.trim().slice(0, 160)) : undefined;
    const shell = rowShell({ tone, sub });
    shell.title.textContent = r.label || r.project || "Worker";
    const meta = el("span", "home-row-meta");
    meta.append(el("span", `home-chip ${chip}`, RETURN_STATE[state] ?? state));
    if (r.project) meta.append(el("span", "home-project", r.project));
    meta.append(el("span", "home-host", entry.computer));
    meta.append(el("span", "home-age", age(r.returned.at)));
    shell.button.append(meta);
    const match = overviewChild(r.target);
    if (match) shell.button.addEventListener("click", () => open(match.computer, match.child));
    else { shell.button.disabled = true; shell.button.style.cursor = "default"; }
    return shell.button;
  }

  function renderReturns() {
    const rows = [];
    for (const list of receipts.values()) for (const entry of list) if (entry.receipt?.returned) rows.push(entry);
    rows.sort((a, b) => String(b.receipt.returned.at).localeCompare(String(a.receipt.returned.at)));
    fill("returns", rows.slice(0, MAX_RETURNS).map(returnRow), "No returns yet.");
    block("returns").querySelector(".count").textContent = rows.length ? String(rows.length) : "";
    if (rows.length > MAX_RETURNS) {
      const more = el("button", "home-more", `All ${rows.length} in Review`);
      more.addEventListener("click", () => showSection("review"));
      block("returns").querySelector(".home-list").append(more);
    }
  }

  // ---- computers ------------------------------------------------------

  function computerRow(c) {
    const row = el("div", `home-row home-computer state-${c.state}`);
    row.append(el("span", "home-computer-name", c.computer));
    const meta = el("span", "home-computer-meta");
    const r = c.resources && typeof c.resources === "object" ? c.resources : null;
    if (c.state === "online") meta.append(el("span", null, "Online"));
    else {
      meta.append(el("span", "home-error", c.error ? `${c.state}: ${c.error}` : c.state));
    }
    if (r) {
      const jobs = Array.isArray(r.heavy) ? r.heavy.length : 0;
      meta.append(el("span", "home-age", jobs ? `${jobs} heavy` : "no heavy jobs"));
      if (r.disk) meta.append(el("span", "home-age", `${gb(r.disk.freeBytes)} free`));
    } else if (c.state === "online") meta.append(el("span", "home-age", "no resources"));
    row.append(meta);
    const load = el("div", "home-load");
    const bar = el("div", "home-load-bar");
    const fillEl = el("span", "home-load-fill");
    const cores = r?.cpu?.cores ? Number(r.cpu.cores) : 0;
    const load1 = r?.cpu?.load1 !== undefined ? Number(r.cpu.load1) : 0;
    const fraction = cores > 0 ? Math.min(1, Math.max(0, load1 / cores)) : 0;
    fillEl.style.width = `${Math.round(fraction * 100)}%`;
    if (r?.level === "stressed") fillEl.classList.add("stressed");
    else if (r?.level === "busy") fillEl.classList.add("busy");
    bar.append(fillEl);
    load.append(bar);
    if (r && cores > 0) load.append(el("span", "home-load-text", `load ${load1.toFixed(1)} / ${cores} cores`));
    row.append(load);
    return row;
  }

  function renderComputers() {
    fill("computers", (merged?.computers ?? []).map(computerRow), "No computers linked.");
  }

  // ---- conductor ------------------------------------------------------

  function latestLine(computer) {
    const list = receipts.get(computer) ?? [];
    let best = null;
    for (const entry of list) {
      const r = entry.receipt;
      const at = r.returned?.at || r.updatedAt || r.createdAt;
      if (!at) continue;
      if (!best || at > best.at) best = { at, receipt: r };
    }
    if (!best) return "";
    const r = best.receipt;
    if (r.returned) return `Returned: ${r.label} ${RETURN_STATE[r.returned.state] ?? r.returned.state}`;
    if (r.worker?.state) return `${r.label}: ${r.worker.state}`;
    return `Dispatched ${r.label}`;
  }

  let conductorSig = "";

  function renderConductor() {
    const found = sessions(merged).find((row) => row.child.role === "conductor");
    const online = (merged?.computers ?? []).map((c) => c.computer).join(",");
    const sig = found
      ? `run:${found.computer}:${found.child.id}:${found.child.agentStatus}:${latestLine(found.computer)}`
      : `none:${online}`;
    if (sig === conductorSig) return;
    conductorSig = sig;
    const host = root.querySelector("[data-conductor]");

    if (found) {
      const card = el("div", "home-conductor");
      const head = el("div", "home-conductor-head");
      head.append(el("span", "home-conductor-title", "Conductor"));
      // The session's own title ("Agent status") is the harness's, not the role.
      const named = found.child.title || found.child.label;
      if (named && named !== "Conductor") head.append(el("span", "home-conductor-session", named));
      const meta = el("span", "home-conductor-meta");
      const live = found.child.agentStatus === "working" ? "working" : found.child.agentStatus === "blocked" || found.child.approvalPending ? "waiting" : found.child.agentStatus || "idle";
      meta.append(el("span", "home-host", found.computer), el("span", `home-conductor-state ${live === "waiting" ? "waiting" : ""}`, live));
      head.append(meta);
      card.append(head);
      const line = latestLine(found.computer);
      card.append(el("div", `home-conductor-line${line ? "" : " muted"}`, line || "No dispatches yet."));
      const actions = el("div", "home-conductor-actions");
      const openBtn = el("button", "home-btn ghost", "Open");
      openBtn.addEventListener("click", () => open(found.computer, found.child));
      actions.append(openBtn);
      card.append(actions);
      host.replaceChildren(card);
      return;
    }

    const card = el("div", "home-conductor");
    const head = el("div", "home-conductor-head");
    head.append(el("span", "home-conductor-title", "Start a conductor"));
    card.append(head);
    const computers = merged?.computers ?? [];
    const field = el("div", "home-field");
    field.append(el("span", "home-field-label", "On"));
    const select = el("select", "home-select");
    for (const c of computers) {
      const option = el("option", null, c.state === "online" ? c.computer : `${c.computer} (${c.state})`);
      option.value = c.computer;
      option.disabled = c.state !== "online";
      select.append(option);
    }
    const onlineFirst = computers.find((c) => c.state === "online");
    if (onlineFirst) select.value = onlineFirst.computer;
    const start = el("button", "home-btn", "Start");
    start.disabled = !onlineFirst;
    const note = el("span", "home-start-note");
    start.addEventListener("click", () => { void startConductor(select.value, start, note); });
    field.append(select, start, note);
    card.append(field);
    host.replaceChildren(card);
  }

  async function startConductor(computer, button, note) {
    if (!computer) return;
    button.disabled = true;
    note.textContent = `Starting on ${computer}\u2026`;
    try {
      await hookPost(computer, "/v1/workspaces/launch", { role: "conductor", kind: "codex", label: "Conductor" });
      note.textContent = `Conductor starting on ${computer}.`;
    } catch (err) {
      note.textContent = err?.status === 409 ? "A conductor is already running." : `Could not start: ${err?.message || err}`;
    } finally {
      button.disabled = false;
    }
  }

  // ---- approval watchers ---------------------------------------------

  function summaryOf(approval) {
    const text = approval.title || approval.command || approval.reason || approval.request || approval.tool;
    return text ? String(text).slice(0, 160) : "Approval required";
  }

  function watchApproval(row) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/hosts/${encodeURIComponent(row.computer)}/v1/status?${targetQuery(row.child.target)}`);
    ws.addEventListener("message", (event) => {
      let frame;
      try { frame = JSON.parse(event.data); } catch { return; }
      const approval = frame?.agentStatus?.pendingApproval;
      if (approval?.actionId) approvals.set(row.key, { actionId: String(approval.actionId), summary: summaryOf(approval) });
      else approvals.delete(row.key);
      renderNeeds();
    });
    ws.addEventListener("close", () => {
      if (watchers.get(row.key) === ws) { watchers.delete(row.key); approvals.delete(row.key); }
    });
    return ws;
  }

  function syncWatchers(rows) {
    const wanted = new Map();
    for (const row of rows) if (row.child.approvalPending && row.child.target) wanted.set(row.key, row);
    for (const [key, ws] of watchers) {
      if (wanted.has(key)) continue;
      try { ws.close(); } catch { /* already closing */ }
      watchers.delete(key); approvals.delete(key);
    }
    for (const [key, row] of wanted) if (!watchers.has(key)) watchers.set(key, watchApproval(row));
  }

  async function answer(row, decision, scope) {
    const info = approvals.get(row.key);
    if (!info || !row.child.target) return;
    try {
      const mod = await import("../chat/answers.js");
      await mod.answerApproval(row.computer, row.child.target, { actionId: info.actionId, decision, ...(scope ? { scope } : {}) });
    } catch { /* the answers module is not mounted yet */ }
  }

  // ---- receipts polling ----------------------------------------------

  async function pollReceipts() {
    const online = (merged?.computers ?? []).filter((c) => c.state === "online");
    const answers = await Promise.all(online.map(async (c) => {
      try {
        const body = await hookGet(c.computer, "/v1/dispatch");
        const list = Array.isArray(body.dispatches) ? body.dispatches : [];
        return [c.computer, list.map((receipt) => ({ receipt, computer: receipt.computer || c.computer }))];
      } catch {
        return [c.computer, []];
      }
    }));
    receipts.clear();
    for (const [computer, list] of answers) receipts.set(computer, list);
    renderReturns();
    renderConductor();
  }

  function startPolling() {
    stopPolling();
    void pollReceipts();
    pollTimer = setInterval(() => { void pollReceipts(); }, RETURN_POLL_MS);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // ---- render and keys -----------------------------------------------

  function render() {
    renderConductor();
    renderNeeds();
    renderWorking();
    renderReturns();
    renderComputers();
  }

  function onKeydown(event) {
    if (!visible) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const tag = (document.activeElement?.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    const rows = needsYou(merged);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!rows.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      selected = Math.max(0, Math.min(rows.length - 1, selected + step));
      renderNeeds();
      event.preventDefault();
      return;
    }
    const row = rows[selected];
    if (!row) return;
    const has = approvals.has(row.key);
    if (event.key === "Enter" && has) { void answer(row, "approve"); event.preventDefault(); }
    else if (event.key.toLowerCase() === "p" && has) { void answer(row, "approve", "project"); event.preventDefault(); }
    else if (event.key.toLowerCase() === "d" && has) { void answer(row, "deny"); event.preventDefault(); }
    else if (event.key.toLowerCase() === "o") { open(row.computer, row.child); event.preventDefault(); }
  }

  // Poll as soon as the set of online computers changes (the first poll at mount
  // usually runs before the overview has arrived and finds no computers).
  let polledFor = "";
  const unsubscribe = store.subscribe((value) => {
    merged = value;
    render();
    const online = (value?.computers ?? []).filter((c) => c.state === "online").map((c) => c.computer).sort().join("\n");
    if (visible && online && online !== polledFor) { polledFor = online; void pollReceipts(); }
  });
  document.addEventListener("keydown", onKeydown);
  visible = true;
  startPolling();

  return {
    show() { visible = true; startPolling(); },
    hide() { visible = false; stopPolling(); },
    destroy() {
      stopPolling();
      unsubscribe();
      document.removeEventListener("keydown", onKeydown);
      for (const ws of watchers.values()) { try { ws.close(); } catch { /* already closing */ } }
      watchers.clear();
    },
  };
}


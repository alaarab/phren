// Settings › Computers: each linked computer's health, resources, peers, activity and files, and linking.
import { store } from "../../shell/store.js";
import { hookGet, hookPost } from "../../api.js";
import { hookDrift, updateCommand } from "../../shell/hook-drift.js";
import { formatGitWrites } from "./git-writes.js";
import { api, button, el, heading, input, noticeLine, post, showNotice } from "./ui.js";

// ------------------------------------------------------------ page: Computers
export function buildComputers(page) {
  const [head, count] = heading("Computers");
  const intro = el("div", "settings-note", "Computers this desktop can reach. Expand one for its health, resources, peers, recent activity and files. Linking installs this desktop's key over your own ssh login.");
  const list = el("div", "settings-list comp-cards");
  const form = el("div", "settings-link");
  form.append(el("div", "section-label", "Link a computer"));
  const hostInput = input("user@host or ssh host");
  const nameInput = input("Name (optional)", "settings-input-name");
  const linkBtn = button("Link a computer", "accent");
  const field = el("div", "settings-field");
  field.append(hostInput, nameInput, linkBtn);
  const notice = noticeLine();
  form.append(field, notice);
  page.append(head, intro, list, form);

  const meta = new Map();
  api("/api/computers").then((computers) => {
    for (const c of Array.isArray(computers) ? computers : []) meta.set(c.name, c);
    render();
  }).catch(() => { /* addresses are optional detail */ });

  const cards = new Map();
  function render() {
    const computers = store.merged?.computers ?? [];
    count.textContent = computers.length ? String(computers.length) : "";
    if (!computers.length) {
      list.replaceChildren(el("div", "settings-empty", "No computers linked."));
      cards.clear();
      return;
    }
    const seen = new Set();
    const ordered = [];
    for (const c of computers) {
      seen.add(c.computer);
      let card = cards.get(c.computer);
      if (!card) {
        card = computerCard(c, meta, render);
        cards.set(c.computer, card);
        if (!page.closest("[hidden]")) card.loadHealth(false);
      }
      card.update(c);
      ordered.push(card.el);
    }
    for (const [name, card] of cards) if (!seen.has(name)) { card.el.remove(); cards.delete(name); }
    list.replaceChildren(...ordered);
  }

  linkBtn.addEventListener("click", async () => {
    const host = hostInput.value.trim();
    if (!host) {
      showNotice(notice, "Enter an ssh host or user@host.", true);
      return;
    }
    linkBtn.disabled = true;
    const label = linkBtn.textContent;
    linkBtn.textContent = "Linking…";
    try {
      const result = await post("/api/computers/link", { host, name: nameInput.value.trim() || undefined });
      showNotice(notice, `Linked ${result?.computer?.name ?? result?.name ?? host}.`, false);
      hostInput.value = "";
      nameInput.value = "";
      render();
    } catch (err) {
      showNotice(notice, err.message, true);
    } finally {
      linkBtn.disabled = false;
      linkBtn.textContent = label;
    }
  });

  store.subscribe(render);
  return () => {
    render();
    for (const card of cards.values()) card.loadHealth(true);
  };
}

// ------------------------------------------------------------ computer card
const TOOL_LABELS = { hook: "Phren Hook", herdr: "Herdr", claude: "Claude Code", codex: "Codex", copilot: "Copilot", opencode: "OpenCode" };
const WARNING_LINES = {
  "disk-low": "Under 10 GB free disk",
  "load-high": "Load above twice the cores",
  "memory-low": "Memory nearly exhausted",
  "battery-low": "Battery low",
};

function fmtBytes(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.abs(n), unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function ago(iso) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return iso || "";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** One ok/warn/fail row per thing worth noticing in `/v1/health/details`. */
function healthChecks(health) {
  const rows = [];
  for (const item of health.versions ?? []) {
    if (item.status === "ok") continue;
    rows.push({ level: item.status === "error" ? "fail" : "warn", label: TOOL_LABELS[item.tool] ?? item.tool,
      detail: item.status === "missing" ? "not installed" : (item.detail || "not working") });
  }
  for (const item of health.stores ?? []) {
    const counts = [item.branch ? `on ${item.branch}` : "",
      item.ahead !== undefined || item.behind !== undefined ? `${item.ahead ?? 0} ahead, ${item.behind ?? 0} behind` : ""].filter(Boolean).join(" · ");
    rows.push({ level: !item.available || item.degraded ? "fail" : item.error ? "warn" : "ok",
      label: `Store ${item.name}`, detail: item.warning || item.error || counts || (item.available ? "synced" : "folder missing") });
  }
  const run = health.schedules?.lastRun;
  if (!run) rows.push({ level: "warn", label: "Schedules", detail: health.schedules?.running === false ? "scheduler stopped" : "no runs yet" });
  else rows.push({ level: run.status === "failed" ? "fail" : "ok", label: run.name || `Scheduled run in ${run.project}`,
    detail: `${run.status} · ${ago(run.startedAt)}${run.reason ? ` · ${run.reason}` : ""}` });
  rows.push({ level: health.push?.configured ? "ok" : "warn", label: "Approval push",
    detail: health.push?.configured ? `configured${health.push.devices ? ` (${health.push.devices} devices)` : ""}` : "not configured" });
  const canary = health.canary;
  if (!canary) rows.push({ level: "warn", label: "Canary", detail: "not run yet" });
  else {
    rows.push({ level: canary.ok ? "ok" : "fail", label: "Canary", detail: `${canary.ok ? "passed" : "failed"} · ${ago(canary.startedAt)}` });
    for (const step of (canary.steps ?? []).filter((s) => s.status === "failed")) {
      rows.push({ level: "fail", label: `Canary · ${step.name}`, detail: step.reason || "failed" });
    }
  }
  return rows;
}

/** The files the phone keeps on a computer, outside any session (the phone's
 * Files tab): list, send one from this desk, delete with an inline confirm. */
function mountSharedFiles(root, computer) {
  const list = el("div", "comp-shared");
  const input = el("input");
  input.type = "file";
  input.hidden = true;
  const send = button("Send a file\u2026");
  send.addEventListener("click", () => input.click());
  const head = el("div", "comp-shared-head");
  head.append(el("div", "comp-section-label", "Shared files"), send, input);
  root.append(head, list);

  async function load() {
    list.replaceChildren(el("div", "settings-inline-note", "Loading\u2026"));
    try {
      const body = await hookGet(computer, "/v1/files");
      render(Array.isArray(body.files) ? body.files : []);
    } catch (err) {
      list.replaceChildren(el("div", "settings-inline-note", err.status === 404 ? `Needs a newer Phren on ${computer}.` : err.message));
      send.disabled = err.status === 404;
    }
  }

  function render(files) {
    list.replaceChildren();
    if (!files.length) { list.append(el("div", "settings-inline-note", "No files. Files sent from the phone or from here show up here.")); return; }
    for (const file of files.sort((a, b) => String(b.modified).localeCompare(String(a.modified)))) {
      const row = el("div", "comp-shared-row");
      row.append(el("span", "comp-shared-name", file.name), el("span", "comp-shared-size", formatBytes(file.size)));
      const actions = el("span", "settings-actions");
      const del = button("Delete", "danger");
      del.addEventListener("click", () => {
        const yes = button("Delete", "danger");
        const no = button("Cancel");
        actions.replaceChildren(el("span", "settings-inline-note", `Delete ${file.name}?`), yes, no);
        no.addEventListener("click", () => actions.replaceChildren(del));
        yes.addEventListener("click", async () => {
          yes.disabled = true;
          try { await hookPost(computer, "/v1/files/delete", { path: file.path }); await load(); }
          catch (err) { actions.replaceChildren(el("span", "settings-error", err.message), del); }
        });
      });
      actions.append(del);
      row.append(actions);
      list.append(row);
    }
  }

  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    // The Hook takes safe names only: letters, digits and _ .()- or spaces.
    const name = file.name.replace(/[^A-Za-z0-9_ .()-]/g, "_").replace(/^[^A-Za-z0-9_]+/, "").slice(0, 200) || "file";
    send.disabled = true;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      await hookPost(computer, "/v1/files", { name, data: btoa(binary) });
      await load();
    } catch (err) {
      list.prepend(el("div", "settings-error", err.message));
    } finally {
      send.disabled = false;
    }
  });

  return { load };
}

function formatBytes(n) {
  const value = Number(n) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1048576).toFixed(1)} MB`;
}

function computerCard(initial, meta, rerender) {
  const card = el("div", "comp-card");
  const head = el("div", "comp-head");
  const toggle = el("button", "comp-toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  const dot = el("span", `settings-dot state-${initial.state}`);
  const main = el("div", "settings-row-main");
  const title = el("div", "settings-row-title", initial.computer);
  const metaLine = el("div", "settings-row-meta");
  const version = el("span", "settings-version", "");
  const stateText = el("span", "", "");
  const addrText = el("span", "", "");
  metaLine.append(stateText, version, addrText);
  const gitWrites = el("div", "settings-inline-note", "Git writes without a repository check: Loading…");
  main.append(title, metaLine, gitWrites);
  const chevron = el("span", "comp-chevron", "\u203A");
  toggle.append(dot, main, chevron);

  const actions = el("div", "settings-actions");
  const refresh = button("Refresh");
  const revoke = button("Revoke", "danger");
  // This computer talks to its Hook over the local socket: there is no key to revoke.
  if (initial.computer === "This computer") actions.append(refresh); else actions.append(refresh, revoke);
  head.append(toggle, actions);

  revoke.addEventListener("click", () => {
    actions.replaceChildren(el("span", "settings-inline-note", `Revoke ${state.computer}?`));
    const yes = button("Revoke", "danger");
    const cancel = button("Cancel");
    yes.addEventListener("click", async () => {
      yes.disabled = true;
      try { await post("/api/computers/revoke", { name: state.computer }); rerender(); }
      catch (err) { actions.replaceChildren(el("span", "settings-error", err.message), revoke); }
    });
    cancel.addEventListener("click", () => actions.replaceChildren(refresh, revoke));
    actions.append(yes, cancel);
  });

  const body = el("div", "comp-body");
  body.hidden = true;
  const checks = el("div", "comp-section");
  const resources = el("div", "comp-section");
  const peers = el("div", "comp-section");
  const activity = el("div", "comp-section");
  const shared = el("div", "comp-section");
  const files = el("div", "comp-section");
  body.append(checks, resources, peers, activity, shared, files);
  card.append(head, body);

  const state = {
    computer: initial.computer, expanded: false,
    health: undefined, healthError: null, healthLoaded: false, healthLoading: false,
    activity: undefined, activityError: null, activityLoaded: false,
    resources: undefined, resourcesError: null, resourcesLoaded: false,
  };
  const filesBrowser = mountFileBrowser(files, initial.computer);
  const sharedFiles = mountSharedFiles(shared, initial.computer);

  function update(c) {
    const info = meta.get(c.computer) ?? {};
    dot.className = `settings-dot state-${c.state}`;
    stateText.textContent = c.error && c.state !== "online" ? `${c.state}: ${c.error}` : c.state;
    const v = store.version(c.computer);
    // Older than the newest Hook this desktop sees: say so, with the command in the tooltip.
    const drift = hookDrift(store.merged?.computers ?? []);
    const behind = drift.behind.has(c.computer);
    version.textContent = v ? `v${v}${behind ? ` · update to ${drift.newest}` : ""}` : "";
    version.classList.toggle("behind", behind);
    version.title = behind ? updateCommand(drift.newest) : "";
    version.hidden = !v;
    addrText.textContent = info.address ? `${info.username ? info.username + "@" : ""}${info.address}${info.port && Number(info.port) !== 22 ? ":" + info.port : ""}` : (info.local ? "local socket" : "");
    store.capabilities(c.computer).then((caps) => {
      const n = Object.values(caps ?? {}).filter(Boolean).length;
      toggle.title = n ? `${n} Hook capabilities` : "";
    });
    if (c.resources) state.resources = c.resources;
    if (state.expanded) renderResources();
  }

  async function loadHealth(force) {
    if (state.healthLoading || (state.healthLoaded && !force)) return;
    state.healthLoading = true;
    try { state.health = await hookGet(state.computer, "/v1/health/details"); state.healthError = null; }
    catch (err) { state.healthError = err.message; }
    finally {
      state.healthLoaded = true; state.healthLoading = false;
      gitWrites.textContent = state.healthError
        ? "Git writes without a repository check: Could not load"
        : formatGitWrites(state.health?.gitWrites);
      gitWrites.title = state.healthError || "Counts since this Hook started.";
      renderChecks(); renderPeers();
    }
  }

  async function loadActivity() {
    try { state.activity = (await hookGet(state.computer, "/v1/activity")).events ?? []; state.activityError = null; }
    catch (err) { state.activityError = err.message; }
    finally { renderActivity(); }
  }

  async function loadResources(force) {
    if (state.resources && !force) { renderResources(); return; }
    try { const res = await hookGet(state.computer, "/v1/resources"); state.resources = res.resources; state.resourcesError = null; }
    catch (err) { if (!state.resources) state.resourcesError = err.message; }
    finally { renderResources(); }
  }

  function expand() {
    state.expanded = true;
    body.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    renderChecks(); renderPeers(); renderActivity(); renderResources();
    if (!state.healthLoaded) loadHealth(false);
    if (!state.activityLoaded) { state.activityLoaded = true; loadActivity(); }
    if (!state.resources) loadResources(false);
    filesBrowser.load();
    sharedFiles.load();
  }

  function collapse() {
    state.expanded = false;
    body.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  }

  toggle.addEventListener("click", () => (state.expanded ? collapse() : expand()));
  refresh.addEventListener("click", () => {
    if (!state.expanded) { expand(); return; }
    state.healthLoaded = false; state.activityLoaded = false; state.resourcesLoaded = false;
    update(state.lastComputer ?? { computer: state.computer, state: "online" });
    loadHealth(true); state.activityLoaded = true; loadActivity(); loadResources(true); filesBrowser.reload();
  });

  function versionChips(health) {
    const wrap = el("div", "comp-chips");
    for (const item of health.versions ?? []) {
      const label = `${TOOL_LABELS[item.tool] ?? item.tool} ${item.status === "ok" ? item.version : item.status === "missing" ? "not installed" : "?"}`;
      const chip = el("span", `comp-chip ${item.status === "ok" ? "" : item.status === "missing" ? "missing" : "warn"}`, label);
      wrap.append(chip);
    }
    return wrap;
  }

  function renderChecks() {
    checks.replaceChildren(el("div", "comp-section-label", "Health"));
    if (state.healthLoading && !state.health) { checks.append(el("div", "settings-note", "Asking…")); return; }
    if (state.healthError) { checks.append(el("div", "settings-error", state.healthError)); return; }
    if (!state.health) { checks.append(el("div", "settings-note", "Not loaded.")); return; }
    checks.append(versionChips(state.health));
    const rows = healthChecks(state.health);
    if (!rows.length) checks.append(el("div", "comp-check ok", "Everything looks healthy."));
    for (const row of rows) {
      const line = el("div", `comp-check ${row.level}`);
      line.append(el("span", "comp-check-dot"));
      const text = el("div", "comp-check-text");
      text.append(el("div", "comp-check-label", row.label));
      if (row.detail) text.append(el("div", "comp-check-detail", row.detail));
      line.append(text);
      checks.append(line);
    }
  }

  function renderPeers() {
    peers.replaceChildren(el("div", "comp-section-label", "Peers"));
    const health = state.health;
    if (!health) { peers.append(el("div", "settings-note", "Not loaded.")); return; }
    const info = health.peers ?? {};
    if (!info.configured) { peers.append(el("div", "settings-note", info.error || "None enrolled.")); return; }
    if (info.error) peers.append(el("div", "settings-error", info.error));
    if (!(info.computers ?? []).length) peers.append(el("div", "settings-note", "None enrolled."));
    for (const peer of info.computers ?? []) {
      const level = !peer.reachable ? "fail" : peer.oneWay || peer.listsBack === false ? "warn" : "ok";
      const line = el("div", `comp-check ${level}`);
      line.append(el("span", "comp-check-dot"));
      const text = el("div", "comp-check-text");
      text.append(el("div", "comp-check-label", peer.name));
      const detail = peer.reachable
        ? (peer.version ? `v${peer.version} · ` : "") + `${peer.ms} ms`
        : (peer.error || "unreachable");
      text.append(el("div", "comp-check-detail", detail));
      line.append(text);
      peers.append(line);
      if (peer.reachable && peer.listsBack === false) {
        peers.append(el("div", "comp-oneway", `One-way: ${peer.name} does not list this computer back.`));
      }
    }
  }

  function renderActivity() {
    activity.replaceChildren(el("div", "comp-section-label", "Recent activity"));
    if (state.activityError) { activity.append(el("div", "settings-error", state.activityError)); return; }
    if (!state.activity) { activity.append(el("div", "settings-note", "Loading…")); return; }
    const events = state.activity.slice(-20).reverse();
    if (!events.length) { activity.append(el("div", "settings-note", "No recent activity.")); return; }
    const list = el("div", "comp-activity");
    for (const event of events) {
      const row = el("div", "comp-activity-row");
      row.append(el("span", "comp-activity-time", ago(event.at)));
      const text = el("div", "comp-activity-text");
      text.append(el("div", "comp-activity-title", [event.provider, event.state].filter(Boolean).join(" · ") || event.source || "event"));
      text.append(el("div", "comp-activity-dir", event.directory || [event.server, event.workspace, event.pane].filter(Boolean).join("/")));
      row.append(text);
      list.append(row);
    }
    activity.append(list);
  }

  function renderResources() {
    resources.replaceChildren(el("div", "comp-section-label", "Resources"));
    if (state.resourcesError && !state.resources) { resources.append(el("div", "settings-error", state.resourcesError)); return; }
    if (!state.resources) { resources.append(el("div", "settings-note", "Waiting for this computer's first reading…")); return; }
    resources.append(resourceCard(state.resources));
  }

  return { el: card, loadHealth, update: (c) => { state.lastComputer = c; update(c); } };
}

function meterColor(fill) { return fill >= 0.9 ? "stressed" : fill >= 0.6 ? "busy" : "ok"; }

function meter(label, fill, value, detail) {
  const wrap = el("div", "comp-meter");
  const top = el("div", "comp-meter-top");
  top.append(el("span", "comp-meter-label", label));
  top.append(el("span", "comp-meter-value", value));
  const bar = el("div", "comp-meter-bar");
  const inner = el("span", `comp-meter-fill ${meterColor(fill)}`);
  inner.style.width = `${Math.round(Math.min(1, Math.max(0, fill)) * 100)}%`;
  bar.append(inner);
  wrap.append(top, bar);
  if (detail) wrap.append(el("div", "comp-meter-detail", detail));
  return wrap;
}

function resourceCard(res) {
  const box = el("div", "comp-resources");
  const level = res.level === "stressed" ? "Stressed" : res.level === "busy" ? "Busy" : "Normal";
  const head = el("div", "comp-res-head");
  head.append(el("span", `comp-level ${res.level || "ok"}`, level));
  if (res.collectedAt) head.append(el("span", "comp-res-when", `updated ${ago(res.collectedAt)}`));
  box.append(head);
  if (res.hardware) {
    box.append(el("div", "comp-hardware", [res.hardware.model, res.hardware.chip, res.hardware.memoryBytes ? fmtBytes(res.hardware.memoryBytes) : ""].filter(Boolean).join(" · ")));
  }
  for (const warning of res.warnings ?? []) box.append(el("div", "comp-warn-line", WARNING_LINES[warning] ?? warning));
  const cpu = res.cpu ?? {};
  box.append(meter("Load", res.pressure?.cpu ?? 0, `load ${cpu.load1 ?? "?"} on ${cpu.cores ?? "?"} cores`,
    cpu.load5 !== undefined ? `1 min average · 5 min ${cpu.load5} · 15 min ${cpu.load15}` : ""));
  const memory = res.memory ?? {};
  box.append(meter("Memory", res.pressure?.memory ?? 0,
    memory.availablePercent !== undefined ? `${Math.round(memory.availablePercent)}% free` : fmtBytes(memory.totalBytes),
    [memory.totalBytes ? `${fmtBytes(memory.totalBytes)} total` : "", memory.pressure && memory.pressure !== "normal" ? `pressure ${memory.pressure}` : "", memory.swapUsedBytes ? `swap ${fmtBytes(memory.swapUsedBytes)}` : ""].filter(Boolean).join(" · ")));
  if (res.disk) box.append(meter("Disk", res.pressure?.disk ?? 0, `${fmtBytes(res.disk.freeBytes)} free`, `${fmtBytes(res.disk.totalBytes)} total on the home volume`));
  const foot = el("div", "comp-res-foot");
  if (res.battery) foot.append(el("span", "comp-res-note", `${Math.round(res.battery.percent)}%${res.battery.charging ? " charging" : res.battery.onAC ? " on power" : ""}`));
  if (res.uptimeSeconds !== undefined) foot.append(el("span", "comp-res-note", `up ${Math.round(res.uptimeSeconds / 3600)}h`));
  if (foot.childNodes.length) box.append(foot);
  const heavy = res.heavy ?? [];
  box.append(el("div", "comp-heavy-title", heavy.length ? "Processes using resources" : "No notable resource use"));
  for (const job of heavy) {
    const row = el("div", "comp-heavy");
    const text = el("div", "comp-heavy-text");
    text.append(el("div", "comp-heavy-name", job.name));
    text.append(el("div", "comp-heavy-detail", `${job.processes} proc · ${job.resourceReason ?? "cpu"}`));
    if (job.pane) text.append(el("div", "comp-heavy-pane", [job.pane.workspace, job.pane.label ?? job.pane.pane, job.pane.agent].filter(Boolean).join(" · ")));
    row.append(text);
    row.append(el("span", "comp-heavy-cpu", `${(job.cpuPercent ?? 0).toFixed(1)}%`));
    box.append(row);
  }
  return box;
}

// ------------------------------------------------------------ files browser
/** A read-only browser of a computer's discovered checkouts
 * (`GET /v1/projects/files`): folders and files, a text file opens in place. */
function mountFileBrowser(container, computer) {
  const s = { loaded: false, repos: null, repoError: null, index: 0, path: "", listing: undefined, listingError: null, file: undefined, fileError: null };
  let token = 0;

  const name = () => { const r = s.repos?.[s.index]; return r ? r.name : undefined; };
  const query = (path) => { const q = { path }; const r = s.repos?.[s.index]; if (r) { q.project = r.name; q.directory = r.directory; } return q; };

  async function fetchRepos() {
    const mine = ++token;
    try {
      const body = await hookGet(computer, "/v1/projects/repos");
      if (mine !== token) return;
      const repos = body.repos ?? [];
      s.repos = repos;
      s.repoError = null;
      const preferred = repos.findIndex((r) => r.registered);
      s.index = preferred >= 0 ? preferred : 0;
      if (repos.length) await browse("", mine);
    } catch (err) {
      if (mine === token) { s.repoError = err.message; s.repos = []; }
    }
    render();
  }

  async function browse(path, mine = ++token) {
    s.path = path; s.file = undefined; s.listingError = null;
    render();
    try {
      const body = await hookGet(computer, "/v1/projects/files", query(path));
      if (mine !== token) return;
      s.listing = body;
    } catch (err) {
      if (mine !== token) return;
      s.listing = undefined;
      s.listingError = err.message;
    }
    render();
  }

  async function openFile(path) {
    const mine = ++token;
    s.fileError = null; s.file = { path, loading: true };
    render();
    try {
      const body = await hookGet(computer, "/v1/projects/files", query(path));
      if (mine !== token) return;
      s.file = { path, size: body.size ?? 0, ...decodeText(body.data) };
    } catch (err) {
      if (mine !== token) return;
      s.file = undefined;
      s.fileError = err.message;
    }
    render();
  }

  function up() {
    const parts = s.path.split("/").filter(Boolean);
    parts.pop();
    browse(parts.join("/"));
  }

  function render() {
    const nodes = [el("div", "comp-section-label", "Files")];
    if (s.repoError) {
      nodes.push(el("div", "settings-error", s.repoError));
      container.replaceChildren(...nodes);
      return;
    }
    if (s.repos === null) { nodes.push(el("div", "settings-note", "Loading…")); container.replaceChildren(...nodes); return; }
    if (!s.repos.length) { nodes.push(el("div", "settings-note", "No projects are available on this computer.")); container.replaceChildren(...nodes); return; }

    const bar = el("div", "comp-filebar");
    if (s.repos.length > 1) {
      const select = document.createElement("select");
      select.className = "settings-select comp-select";
      select.setAttribute("aria-label", "Project");
      s.repos.forEach((repo, i) => {
        const option = document.createElement("option");
        option.value = String(i);
        option.textContent = repo.name || repo.directory;
        select.append(option);
      });
      select.value = String(s.index);
      select.addEventListener("change", () => { s.index = Number(select.value); s.listing = undefined; browse(""); });
      bar.append(select);
    } else {
      bar.append(el("span", "comp-crumb", name() || ""));
    }
    if (s.file || s.path) {
      const back = s.file ? button("Back") : button("Up");
      back.className = "settings-btn comp-up";
      back.addEventListener("click", () => { if (s.file) { s.file = undefined; s.fileError = null; render(); } else up(); });
      bar.append(back);
    }
    if (s.path) bar.append(el("span", "comp-crumb-path", s.path));
    nodes.push(bar);

    if (s.file) {
      nodes.push(fileViewer(s.file));
    } else if (s.fileError) {
      nodes.push(el("div", "settings-error", s.fileError));
    } else if (s.listingError) {
      nodes.push(el("div", "settings-error", s.listingError));
    } else if (!s.listing) {
      nodes.push(el("div", "settings-note", "Loading…"));
    } else {
      const entries = s.listing.entries ?? [];
      if (!entries.length) nodes.push(el("div", "settings-note", "This folder is empty."));
      const list = el("div", "comp-files");
      for (const entry of entries) {
        const isDir = entry.kind === "directory";
        const row = el("button", `comp-file ${isDir ? "dir" : "text"}`);
        row.type = "button";
        row.append(el("span", "comp-file-icon", isDir ? "\u25B8" : "\u25A4"));
        row.append(el("span", "comp-file-name", entry.name));
        row.append(el("span", "comp-file-kind", isDir ? "folder" : "file"));
        row.addEventListener("click", () => (isDir ? browse(entry.path) : openFile(entry.path)));
        list.append(row);
      }
      nodes.push(list);
      if (s.listing.truncated) nodes.push(el("div", "settings-note", "Showing the first 500 entries."));
    }
    container.replaceChildren(...nodes);
  }

  return {
    load() { if (s.loaded) { render(); return; } s.loaded = true; fetchRepos(); },
    reload() { s.loaded = true; s.repos = null; s.repoError = null; s.path = ""; s.listing = undefined; s.file = undefined; s.fileError = null; fetchRepos(); },
  };
}

function decodeText(data) {
  if (typeof data !== "string") return { text: "", binary: false };
  try {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    if (bytes.some((b) => b === 0)) return { text: "", binary: true };
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), binary: false };
  } catch {
    return { text: "", binary: true };
  }
}

function fileViewer(file) {
  const box = el("div", "comp-fileview");
  const head = el("div", "comp-fileview-head");
  head.append(el("span", "comp-fileview-name", file.path.split("/").pop() || file.path));
  if (!file.loading) head.append(el("span", "comp-fileview-size", fmtBytes(file.size)));
  box.append(head);
  if (file.loading) box.append(el("div", "settings-note", "Opening…"));
  else if (file.binary) box.append(el("div", "settings-note", "Binary file. Open it on the computer to read it."));
  else {
    const pre = el("pre", "comp-filetext");
    pre.textContent = file.text || "(empty file)";
    box.append(pre);
  }
  return box;
}

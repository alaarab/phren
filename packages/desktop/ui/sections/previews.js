// Previews: each computer's running web servers (Vite, Next, anything on a
// loopback port) opened in an embedded iframe, and its booted iOS simulators
// with a live screen and Home / Screenshot / Open app. Ports the phone's
// WebServersView, WebPreviewTunnel and SimulatorsView; the daemon's
// /api/previews opens a local listener on its own loopback port; the iframe loads that
// port directly, so preview code never runs on the daemon's origin.
import { hookGet, hookPost } from "../api.js";
import { store } from "../shell/store.js";

const CSS_HREF = "./sections/previews.css";
const SERVERS_POLL_MS = 15_000;
const SCREENSHOT_MS = 2_000;

/** Same-origin daemon call (the preview routes live on the daemon, not a Hook). */
async function daemon(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), "X-Phren-Desktop": "1" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { error: text.slice(0, 300) }; }
  if (!res.ok) {
    const error = new Error(parsed.error || `The daemon answered ${res.status}.`);
    error.status = res.status;
    throw error;
  }
  return parsed;
}

function ensureCss() {
  if (document.querySelector("link[data-pv-css]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = CSS_HREF;
  link.dataset.pvCss = "1";
  document.head.append(link);
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function screenshotUrl(computer, udid) {
  return `/hosts/${encodeURIComponent(computer)}/v1/simulators/screenshot?udid=${encodeURIComponent(udid)}&t=${Date.now()}`;
}

const status = (computer) => store.merged?.computers?.find((c) => c.computer === computer)?.state ?? "offline";

export function mountPreviews(root) {
  ensureCss();
  root.innerHTML = `
    <div class="pv">
      <div class="pv-head">
        <h1 class="pv-title">Previews</h1>
        <span class="pv-note" data-status></span>
        <span class="pv-spacer"></span>
        <button class="pv-btn" data-refresh>Refresh</button>
      </div>
      <div class="pv-error" data-error hidden></div>
      <div class="pv-body">
        <div class="pv-rail">
          <section class="pv-panel">
            <h2 class="section-label">Web servers <span class="pv-count" data-servers-count></span></h2>
            <div data-servers></div>
          </section>
          <section class="pv-panel">
            <h2 class="section-label">Simulators <span class="pv-count" data-sims-count></span></h2>
            <div data-simulators></div>
          </section>
        </div>
        <div class="pv-stage">
          <div class="pv-bar">
            <button class="pv-icon" data-pv-back title="Back" aria-label="Back" disabled>‹</button>
            <button class="pv-icon" data-pv-forward title="Forward" aria-label="Forward" disabled>›</button>
            <span class="pv-url" data-pv-url>No preview open</span>
            <span class="pv-spacer"></span>
            <button class="pv-btn small" data-pv-reload title="Reload" disabled>Reload</button>
            <button class="pv-btn small" data-pv-open title="Open in your browser" disabled>Open</button>
            <button class="pv-btn small" data-pv-close title="Close preview" disabled>Close</button>
          </div>
          <div class="pv-frame-wrap">
            <iframe class="pv-frame" data-pv-frame hidden title="Web preview" referrerpolicy="no-referrer"></iframe>
            <div class="pv-empty" data-pv-empty>Open a web server to preview it here.</div>
          </div>
        </div>
      </div>
    </div>`;

  const statusEl = root.querySelector("[data-status]");
  const errorEl = root.querySelector("[data-error]");
  const serversEl = root.querySelector("[data-servers]");
  const serversCount = root.querySelector("[data-servers-count]");
  const simsEl = root.querySelector("[data-simulators]");
  const simsCount = root.querySelector("[data-sims-count]");
  const frame = root.querySelector("[data-pv-frame]");
  const emptyEl = root.querySelector("[data-pv-empty]");
  const urlEl = root.querySelector("[data-pv-url]");
  const closeBtn = root.querySelector("[data-pv-close]");
  const reloadBtn = root.querySelector("[data-pv-reload]");
  const openBtn = root.querySelector("[data-pv-open]");
  const backBtn = root.querySelector("[data-pv-back]");
  const forwardBtn = root.querySelector("[data-pv-forward]");

  const state = {
    visible: false,
    computers: [],
    servers: new Map(),    // computer -> { servers:[], error }
    simulators: new Map(), // computer -> { simulators:[], error }
    preview: null,         // the open preview { id, computer, port, url, ... }
    timers: [],
  };

  function setError(text) {
    errorEl.hidden = !text;
    errorEl.textContent = text ?? "";
  }

  // ---- data ------------------------------------------------------------

  async function loadComputer(computer) {
    await Promise.all([loadServers(computer), loadSimulators(computer)]);
  }

  async function loadServers(computer) {
    try {
      const body = await hookGet(computer, "/v1/web-servers");
      state.servers.set(computer, { servers: Array.isArray(body.servers) ? body.servers : [], error: null });
    } catch (err) {
      state.servers.set(computer, { servers: state.servers.get(computer)?.servers ?? [], error: err });
    }
  }

  async function loadSimulators(computer) {
    try {
      const body = await hookGet(computer, "/v1/simulators");
      state.simulators.set(computer, { simulators: Array.isArray(body.simulators) ? body.simulators : [], error: null });
    } catch (err) {
      state.simulators.set(computer, { simulators: state.simulators.get(computer)?.simulators ?? [], error: err });
    }
  }

  async function refreshLists() {
    const online = (store.merged?.computers ?? []).filter((c) => c.state === "online").map((c) => c.computer);
    state.computers = online;
    statusEl.textContent = online.length ? `${online.length} computer${online.length === 1 ? "" : "s"} online` : "No computers online";
    for (const computer of [...state.servers.keys()]) if (!online.includes(computer)) state.servers.delete(computer);
    for (const computer of [...state.simulators.keys()]) if (!online.includes(computer)) state.simulators.delete(computer);
    await Promise.all(online.map(loadComputer));
    render();
  }

  // ---- preview ---------------------------------------------------------

  async function openPreview(computer, port) {
    setError("");
    try {
      const preview = await daemon("POST", "/api/previews", { computer, port });
      state.preview = preview;
      showPreview(preview.url);
      render();
    } catch (err) {
      setError(err?.message ?? String(err));
    }
  }

  function showPreview(url) {
    frame.hidden = false;
    emptyEl.hidden = true;
    frame.src = url;
    urlEl.textContent = url;
    closeBtn.disabled = false;
    openBtn.disabled = false;
    reloadBtn.disabled = false;
    backBtn.disabled = false;
    forwardBtn.disabled = false;
  }

  async function closePreview() {
    const preview = state.preview;
    state.preview = null;
    frame.src = "about:blank";
    frame.hidden = true;
    emptyEl.hidden = false;
    urlEl.textContent = "No preview open";
    closeBtn.disabled = true;
    openBtn.disabled = true;
    reloadBtn.disabled = true;
    backBtn.disabled = true;
    forwardBtn.disabled = true;
    render();
    if (preview) await daemon("DELETE", `/api/previews/${encodeURIComponent(preview.id)}`).catch(() => undefined);
  }

  // ---- mount lifecycle -------------------------------------------------

  function startTimers() {
    stopTimers();
    state.timers.push(setInterval(() => { void refreshLists(); }, SERVERS_POLL_MS));
    state.timers.push(setInterval(refreshScreenshots, SCREENSHOT_MS));
  }

  function stopTimers() {
    for (const timer of state.timers) clearInterval(timer);
    state.timers = [];
  }

  function refreshScreenshots() {
    if (!state.visible) return;
    for (const img of simsEl.querySelectorAll("img[data-udid]")) {
      const computer = img.dataset.computer;
      const udid = img.dataset.udid;
      img.src = screenshotUrl(computer, udid);
    }
  }

  root.querySelector("[data-refresh]").addEventListener("click", () => { void refreshLists(); });
  closeBtn.addEventListener("click", () => { void closePreview(); });
  reloadBtn.addEventListener("click", () => { if (frame.src) frame.src = frame.src; });
  openBtn.addEventListener("click", () => { if (state.preview) window.open(state.preview.url, "_blank", "noopener"); });
  backBtn.addEventListener("click", () => { try { frame.contentWindow.history.back(); } catch { /* cross-origin */ } });
  forwardBtn.addEventListener("click", () => { try { frame.contentWindow.history.forward(); } catch { /* cross-origin */ } });

  const unsubscribe = store.subscribe(() => {
    if (state.visible) void refreshLists();
  });

  // ---- render ----------------------------------------------------------

  function render() {
    renderServers();
    renderSimulators();
  }

  function renderServers() {
    serversEl.replaceChildren();
    let total = 0;
    const computers = state.computers;
    if (!computers.length) { serversEl.append(el("div", "pv-empty-row", "No computers online")); serversCount.textContent = ""; return; }
    for (const computer of computers) {
      const entry = state.servers.get(computer);
      const servers = entry?.servers ?? [];
      total += servers.length;
      serversEl.append(el("div", "pv-computer", computer));
      if (entry?.error && !servers.length) {
        serversEl.append(el("div", "pv-warn", entry.error?.message ?? String(entry.error)));
        continue;
      }
      if (!servers.length) { serversEl.append(el("div", "pv-empty-row", "No web servers running")); continue; }
      const sorted = [...servers].sort((a, b) => Number(!serverName(a)) - Number(!serverName(b)) || a.port - b.port);
      for (const server of sorted) serversEl.append(serverRow(computer, server));
    }
    serversCount.textContent = total ? String(total) : "";
  }

  /** The page's own title, or "" when the Hook only knows a placeholder or an error page. */
  function serverName(server) {
    const name = String(server.name ?? "").trim();
    if (!name || /^Web server on port \d+$/i.test(name) || /^(Error response|404 Not Found|Not Found)$/i.test(name)) return "";
    return name;
  }

  function serverRow(computer, server) {
    const row = el("button", "pv-row");
    row.type = "button";
    const main = el("div", "pv-row-main");
    const name = serverName(server);
    main.append(el("div", "pv-row-title", name || server.process || `Port ${server.port}`));
    const detail = [name ? server.process : "", `:${server.port}`].filter(Boolean).join(" · ");
    main.append(el("div", "pv-row-sub", detail));
    row.append(main, el("span", "pv-row-open", "Open"));
    row.addEventListener("click", () => { void openPreview(computer, server.port); });
    return row;
  }

  function renderSimulators() {
    simsEl.replaceChildren();
    let total = 0;
    if (!state.computers.length) { simsEl.append(el("div", "pv-empty-row", "No computers online")); simsCount.textContent = ""; return; }
    for (const computer of state.computers) {
      const entry = state.simulators.get(computer);
      const simulators = entry?.simulators ?? [];
      total += simulators.length;
      simsEl.append(el("div", "pv-computer", computer));
      if (entry?.error) { simsEl.append(el("div", "pv-warn", entry.error?.message ?? String(entry.error))); continue; }
      if (!simulators.length) { simsEl.append(el("div", "pv-empty-row", "No simulator is booted")); continue; }
      for (const simulator of simulators) simsEl.append(simulatorRow(computer, simulator));
    }
    simsCount.textContent = total ? String(total) : "";
  }

  function simulatorRow(computer, simulator) {
    const row = el("div", "pv-sim");
    const screen = el("div", "pv-sim-screen");
    const img = document.createElement("img");
    img.alt = simulator.name;
    img.dataset.computer = computer;
    img.dataset.udid = simulator.udid;
    img.src = screenshotUrl(computer, simulator.udid);
    screen.append(img);
    row.append(screen);
    const main = el("div", "pv-row-main");
    main.append(el("div", "pv-row-title", simulator.name));
    main.append(el("div", "pv-row-sub", simulator.runtime ?? ""));
    row.append(main);
    const actions = el("div", "pv-sim-actions");
    actions.append(simButton("Home", () => simulatorAct(computer, simulator.udid, { action: "home" })));
    actions.append(simButton("Capture", () => { img.src = screenshotUrl(computer, simulator.udid); }));
    actions.append(simButton("Apps", () => toggleApps(row, computer, simulator.udid)));
    row.append(actions);
    return row;
  }

  function simButton(label, onClick) {
    const button = el("button", "pv-btn small", label);
    button.addEventListener("click", onClick);
    return button;
  }

  async function simulatorAct(computer, udid, action) {
    setError("");
    try {
      await hookPost(computer, "/v1/simulators/action", { udid, ...action });
    } catch (err) {
      setError(err?.status === 403 ? "Touches need Accessibility for Phren's simulator helper on the Mac." : (err?.message ?? String(err)));
    }
  }

  async function toggleApps(row, computer, udid) {
    const existing = row.querySelector(".pv-apps");
    if (existing) { existing.remove(); return; }
    const menu = el("div", "pv-apps");
    menu.append(el("span", "pv-apps-note", "Loading apps…"));
    row.append(menu);
    try {
      const body = await hookGet(computer, "/v1/simulators/apps", { udid });
      const apps = Array.isArray(body.apps) ? body.apps : [];
      if (!apps.length) { menu.replaceChildren(el("span", "pv-apps-note", "No apps installed")); return; }
      menu.replaceChildren(...apps.map((app) => {
        const button = el("button", "pv-app", app.name);
        button.title = app.bundleId;
        button.addEventListener("click", () => {
          menu.remove();
          void simulatorAct(computer, udid, { action: "launch", bundleId: app.bundleId });
        });
        return button;
      }));
    } catch (err) {
      menu.replaceChildren(el("span", "pv-apps-note", err?.message ?? String(err)));
    }
  }

  void backBtn; void forwardBtn;

  return {
    show() {
      state.visible = true;
      void refreshLists();
      startTimers();
    },
    hide() {
      state.visible = false;
      stopTimers();
    },
    destroy() { stopTimers(); unsubscribe(); },
  };
}

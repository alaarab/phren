// Workbench Extensions pane: browse Open VSX, install/uninstall, toggle, and
// pick a contributed color theme. Talks to the daemon's same-origin
// /api/extensions routes; the VS Code editor host is optional (window.PhrenEditorHost).

const STYLE_ID = "ext-style";

/** Inject the pane's CSS once. Phren Charcoal variables only. */
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.ext { display: flex; flex-direction: column; height: 100%; min-height: 0; position: relative; }
.ext-head { flex: none; display: flex; align-items: center; gap: 8px; padding: 12px; border-bottom: 1px solid var(--border); }
.ext-search { flex: 1; min-width: 0; height: 34px; padding: 0 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--sunken); color: var(--text); font: inherit; outline: none; }
.ext-search::placeholder { color: var(--dim); }
.ext-search:focus { border-color: var(--accent); }
.ext-theme { display: flex; align-items: center; gap: 8px; flex: none; color: var(--muted); font-size: 12px; }
.ext-theme[hidden] { display: none; }
.ext-theme-select { height: 34px; padding: 0 8px; border: 1px solid var(--border); border-radius: 10px; background: var(--sunken); color: var(--text); font: inherit; outline: none; }
.ext-theme-select:focus { border-color: var(--accent); }
.ext-body { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 12px 20px; }
.ext-section-label { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 12px 0 8px; }
.ext-row { min-height: 56px; display: flex; align-items: center; gap: 12px; padding: 8px 4px; border-bottom: 1px solid var(--border); }
.ext-icon { width: 32px; height: 32px; border-radius: 8px; flex: none; object-fit: cover; background: var(--raised); }
.ext-letter { width: 32px; height: 32px; border-radius: 8px; flex: none; display: grid; place-items: center; background: var(--raised); color: var(--accent); font-weight: 600; }
.ext-main { flex: 1; min-width: 0; }
.ext-name { color: var(--text); font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ext-meta { color: var(--muted); font-size: 12px; }
.ext-desc { color: var(--muted); font-size: 12px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ext-kind { flex: none; font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--raised); white-space: nowrap; }
.ext-kind.web { color: var(--done); }
.ext-kind.declarative { color: var(--muted); }
.ext-kind.node { color: var(--waiting); }
.ext-kind.verified { color: var(--done); }
.ext-actions { flex: none; display: flex; gap: 6px; }
.ext-btn { height: 28px; padding: 0 12px; border: 1px solid var(--border-strong); border-radius: 999px; background: var(--raised); color: var(--text); font: inherit; font-size: 12px; cursor: pointer; transition: color .18s ease, background .18s ease; }
.ext-btn:hover { color: var(--accent-hover); }
.ext-btn.danger { color: var(--danger); }
.ext-btn:disabled { opacity: .5; cursor: default; }
.ext-error { color: var(--danger); font-size: 12px; margin-top: 4px; }
.ext-note { color: var(--muted); font-size: 12px; }
.ext-empty { color: var(--muted); font-size: 12px; padding: 8px 0; }
.ext-reload { color: var(--waiting); padding: 8px 12px; border: 1px solid var(--border); border-radius: 10px; margin: 8px 0; background: var(--sunken); display: flex; align-items: center; gap: 10px; }
.ext-consent { position: absolute; inset: 0; background: rgba(0,0,0,.55); display: grid; place-items: center; padding: 24px; z-index: 5; }
.ext-consent-card { width: 100%; max-width: 420px; background: var(--raised); border: 1px solid var(--border); border-radius: 12px; padding: 20px; box-shadow: 0 12px 40px rgba(0,0,0,.4); }
.ext-consent-title { margin: 0 0 10px; font-size: 15px; font-weight: 600; color: var(--text); }
.ext-consent-text { margin: 0 0 18px; color: var(--muted); font-size: 13px; line-height: 1.5; }
.ext-consent-actions { display: flex; justify-content: flex-end; gap: 8px; }
`;
  document.head.append(style);
}

/** Same-origin JSON call; throws Error with .status/.body on non-2xx. */
async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const headers = { "X-Phren-Desktop": "1", ...(options.headers || {}) };
  if (method !== "GET") headers["Content-Type"] = "application/json";
  const res = await fetch(path, { ...options, headers });
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0, 300) }; }
  if (!res.ok) {
    const error = new Error(body.error || `Request failed (${res.status}).`);
    error.status = res.status;
    error.body = body;
    throw error;
  }
  return body;
}

const CONSENT_KEY = "phren.extensions.consented";

function hasConsented() {
  try { return localStorage.getItem(CONSENT_KEY) === "1"; } catch { return false; }
}

function rememberConsent() {
  try { localStorage.setItem(CONSENT_KEY, "1"); } catch { /* private window: this session only */ }
}

const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function button(label, kind) {
  const b = document.createElement("button");
  b.className = kind ? `ext-btn ${kind}` : "ext-btn";
  b.textContent = label;
  return b;
}

function noteLine(text, danger) {
  const div = document.createElement("div");
  div.className = danger ? "ext-note ext-error" : "ext-note";
  div.textContent = text;
  return div;
}

function emptyLine(text) {
  const div = document.createElement("div");
  div.className = "ext-empty";
  div.textContent = text;
  return div;
}

function showError(scope, message) {
  let error = scope.querySelector(".ext-error");
  if (!error) { error = document.createElement("div"); error.className = "ext-error"; scope.append(error); }
  error.textContent = message;
}

function formatCount(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}

function letterTile(item) {
  const tile = document.createElement("div");
  tile.className = "ext-letter";
  const label = item.displayName || item.name || item.publisher || item.namespace || "?";
  tile.textContent = label.trim().charAt(0).toUpperCase() || "?";
  return tile;
}

function icon(item) {
  const src = typeof item.icon === "string" ? item.icon : "";
  if (src.startsWith("http") || src.startsWith("/")) {
    const img = document.createElement("img");
    img.className = "ext-icon";
    img.alt = "";
    img.src = src;
    img.addEventListener("error", () => img.replaceWith(letterTile(item))); // fall back to the letter tile
    return img;
  }
  return letterTile(item);
}

function kindChip(kind, rehAvailable) {
  const chip = document.createElement("span");
  chip.className = `ext-kind ${kind || "declarative"}`;
  chip.textContent = kind === "web"
    ? "Runs here"
    : kind === "node"
      ? (rehAvailable ? "Runs in the Node host" : "Needs a Node host")
      : "Themes and grammars";
  return chip;
}

/** Build the body of a row; returns [main, appendAction]. */
function rowShell(item) {
  const row = document.createElement("div");
  row.className = "ext-row";
  row.append(icon(item));
  const main = document.createElement("div");
  main.className = "ext-main";
  const name = document.createElement("div");
  name.className = "ext-name";
  name.textContent = item.displayName || item.id || `${item.namespace}.${item.name}`;
  main.append(name);
  if (item.description) {
    const desc = document.createElement("div");
    desc.className = "ext-desc";
    desc.textContent = item.description;
    main.append(desc);
  }
  row.append(main);
  return { row, main };
}

/** Run an action with a busy label on its button. */
async function withBusy(buttonEl, label, action) {
  const original = buttonEl.textContent;
  buttonEl.disabled = true;
  buttonEl.textContent = label;
  try { await action(); } finally {
    buttonEl.disabled = false;
    buttonEl.textContent = original;
  }
}

/**
 * Open the Extensions pane in el.
 * @param {HTMLElement} el
 * @param {{ computer: string }} ctx
 * @returns {{ close(): void }}
 */
/** The VS Code editor host, loaded on demand; undefined when it is not built. */
async function editorHost() {
  if (!window.PhrenEditorHost) {
    try { await import("/editor-host/editor-host.js"); } catch { /* standalone Monaco or no editor */ }
  }
  return window.PhrenEditorHost;
}

export function openExtensions(el, ctx) {
  ensureStyle();

  let closed = false;
  let searchTimer = 0;
  let searchSeq = 0;
  const state = { installed: [], results: [], query: "", rehAvailable: false };

  const root = document.createElement("div");
  root.className = "ext";
  const head = document.createElement("div");
  head.className = "ext-head";
  const input = document.createElement("input");
  input.className = "ext-search";
  input.type = "search";
  input.placeholder = "Search Open VSX";
  input.setAttribute("aria-label", "Search Open VSX");
  const themeWrap = document.createElement("label");
  themeWrap.className = "ext-theme";
  const themeCaption = document.createElement("span");
  themeCaption.textContent = "Color theme";
  const themeSelect = document.createElement("select");
  themeSelect.className = "ext-theme-select";
  themeSelect.setAttribute("aria-label", "Color theme");
  themeWrap.append(themeCaption, themeSelect);
  head.append(input, themeWrap);

  const body = document.createElement("div");
  body.className = "ext-body";
  const reloadNote = document.createElement("div");
  reloadNote.className = "ext-note ext-reload";
  reloadNote.textContent = "Reload the window to finish";
  reloadNote.hidden = true;
  const restartNote = document.createElement("div");
  restartNote.className = "ext-note ext-reload";
  restartNote.hidden = true;
  const restartLabel = document.createElement("span");
  restartLabel.textContent = "Restart the extension host to apply";
  const restartBtn = button("Restart");
  restartBtn.addEventListener("click", () => withBusy(restartBtn, "Restarting\u2026", reloadHost));
  restartNote.append(restartLabel, restartBtn);

  const makeSection = (label) => {
    const section = document.createElement("section");
    section.className = "ext-section";
    const heading = document.createElement("div");
    heading.className = "ext-section-label";
    heading.textContent = label;
    const rows = document.createElement("div");
    rows.className = "ext-rows";
    section.append(heading, rows);
    return { section, rows };
  };
  const installed = makeSection("INSTALLED");
  const results = makeSection("RESULTS");
  body.append(reloadNote, restartNote, installed.section, results.section);
  root.append(head, body);
  el.replaceChildren(root);

  /** Call the editor host's reload, surfacing a note when it asks for a window reload. */
  async function reloadHost() {
    const host = await editorHost();
    if (!host || typeof host.reloadExtensions !== "function") return;
    let ok;
    try { ok = await host.reloadExtensions(); } catch { ok = false; }
    if (ok === false && !closed) reloadNote.hidden = false;
  }

  /** Inline consent sheet shown before the first install ever. */
  function askConsent() {
    return new Promise((resolve) => {
      const sheet = document.createElement("div");
      sheet.className = "ext-consent";
      const card = document.createElement("div");
      card.className = "ext-consent-card";
      const title = document.createElement("h2");
      title.className = "ext-consent-title";
      title.textContent = "Extensions run as you";
      const text = document.createElement("p");
      text.className = "ext-consent-text";
      text.textContent = "An extension can read and change files on this computer and can use this desktop's key to reach every linked computer. Install only extensions you trust.";
      const actions = document.createElement("div");
      actions.className = "ext-consent-actions";
      const cancel = button("Cancel");
      const install = button("Install");
      const finish = (ok) => { sheet.remove(); resolve(ok); };
      cancel.addEventListener("click", () => finish(false));
      install.addEventListener("click", () => { rememberConsent(); finish(true); });
      actions.append(cancel, install);
      card.append(title, text, actions);
      sheet.append(card);
      root.append(sheet);
      install.focus();
    });
  }

  async function ensureConsent() {
    if (hasConsented()) return true;
    return askConsent();
  }

  function renderInstalled() {
    if (state.installed.length === 0) {
      installed.rows.replaceChildren(emptyLine("No extensions installed."));
      return;
    }
    installed.rows.replaceChildren(...state.installed.map(installedRow));
  }

  function installedRow(ext) {
    const { row, main } = rowShell(ext);
    const meta = document.createElement("div");
    meta.className = "ext-meta";
    meta.textContent = `${ext.publisher || ext.id} · v${ext.version || "?"}`;
    main.prepend(meta);
    row.append(kindChip(ext.kind, state.rehAvailable));
    if (ext.publisherVerified) {
      const verified = document.createElement("span");
      verified.className = "ext-kind verified";
      verified.textContent = "Verified publisher";
      row.append(verified);
    }
    const actions = document.createElement("div");
    actions.className = "ext-actions";
    const enabled = ext.enabled !== false;
    const toggle = button(enabled ? "Disable" : "Enable");
    toggle.addEventListener("click", () => withBusy(toggle, enabled ? "Disabling…" : "Enabling…", async () => {
      try {
        const result = await api(`/api/extensions/${encodeURIComponent(ext.id)}/enable`, json("POST", { enabled: !enabled }));
        restartNote.hidden = !(result && result.restartRequired);
        await refreshInstalled();
        await reloadHost();
      } catch (err) { showError(main, err.message); }
    }));
    const remove = button("Uninstall", "danger");
    remove.addEventListener("click", () => withBusy(remove, "Removing…", async () => {
      try {
        await api(`/api/extensions/${encodeURIComponent(ext.id)}`, { method: "DELETE" });
        await refreshInstalled();
        await reloadHost();
      } catch (err) { showError(main, err.message); }
    }));
    actions.append(toggle, remove);
    row.append(actions);
    return row;
  }

  function renderResults() {
    if (!state.query) { results.rows.replaceChildren(); return; }
    const installedIds = new Set(state.installed.map((e) => String(e.id).toLowerCase()));
    if (state.results.length === 0) { results.rows.replaceChildren(emptyLine("No results.")); return; }
    results.rows.replaceChildren(...state.results.map((item) => resultRow(item, installedIds)));
  }

  function resultRow(item, installedIds) {
    const id = `${item.namespace}.${item.name}`;
    const { row, main } = rowShell(item);
    const meta = document.createElement("div");
    meta.className = "ext-meta";
    const downloads = item.downloadCount != null ? ` · ${formatCount(item.downloadCount)} installs` : "";
    meta.textContent = `${item.namespace} · v${item.version || "?"}${downloads}`;
    main.prepend(meta);
    if (installedIds.has(id.toLowerCase())) {
      const remove = button("Uninstall", "danger");
      remove.addEventListener("click", () => withBusy(remove, "Removing…", async () => {
        try {
          await api(`/api/extensions/${encodeURIComponent(id)}`, { method: "DELETE" });
          await refreshInstalled();
          await reloadHost();
        } catch (err) { showError(main, err.message); }
      }));
      row.append(remove);
    } else {
      const install = button("Install");
      install.addEventListener("click", () => withBusy(install, "Installing…", async () => {
        try {
          if (!(await ensureConsent())) return;
          await api("/api/extensions/install", json("POST", { namespace: item.namespace, name: item.name }));
          reloadNote.hidden = true;
          await refreshInstalled();
          await refreshReh();
          await reloadHost();
        } catch (err) { showError(main, err.message); }
      }));
      row.append(install);
    }
    return row;
  }

  async function refreshInstalled() {
    try {
      const data = await api("/api/extensions");
      if (closed) return;
      state.installed = data.extensions || [];
      renderInstalled();
      renderResults(); // install/uninstall flips the results buttons
    } catch (err) {
      if (closed) return;
      installed.rows.replaceChildren(noteLine(err.message, true));
    }
  }

  /** Re-check the Node host so a stale "Needs a Node host" badge clears. */
  async function refreshReh() {
    try {
      const data = await api("/api/reh");
      if (closed) return;
      state.rehAvailable = !!data.available;
    } catch {
      if (closed) return;
      state.rehAvailable = false;
    }
    renderInstalled();
  }

  async function runSearch(q, token) {
    results.rows.replaceChildren(noteLine("Searching…"));
    try {
      const data = await api(`/api/extensions/search?q=${encodeURIComponent(q)}`);
      if (closed || token !== searchSeq) return; // a newer query already answered
      state.results = data.extensions || [];
      renderResults();
    } catch (err) {
      if (closed || token !== searchSeq) return;
      results.rows.replaceChildren(noteLine(err.message, true));
    }
  }

  input.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    const token = ++searchSeq; // invalidate any in-flight search
    state.query = q;
    if (!q) { state.results = []; renderResults(); return; }
    searchTimer = setTimeout(() => runSearch(q, token), 300);
  });

  /** Populate the theme select from the editor host; hide it when there is no host. */
  async function setupThemes() {
    const host = await editorHost();
    if (!host || typeof host.themes !== "function") { themeWrap.hidden = true; return; }
    try { await host.ready; } catch { /* themes() still worth a try */ }
    if (closed) return;
    let themes = [];
    try { themes = (await host.themes()) || []; } catch { themes = []; }
    themeSelect.replaceChildren(...themes.map((t) => {
      const option = document.createElement("option");
      option.value = t.id;
      option.textContent = t.label || t.id;
      return option;
    }));
    try { const current = await host.currentTheme?.(); if (current) themeSelect.value = current; } catch { /* first option stays */ }
    themeSelect.addEventListener("change", () => {
      try { host.setTheme?.(themeSelect.value); } catch { /* host owns failures */ }
    });
  }

  setupThemes();
  refreshInstalled();
  refreshReh();

  return {
    close() {
      closed = true;
      clearTimeout(searchTimer);
      el.replaceChildren();
    },
  };
}

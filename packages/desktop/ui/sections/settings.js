// Settings: one home for global configuration, a left list of pages and the
// page on the right. Computers, Keys, Extensions, Appearance and Notifications.
// The theme picker is filled by app.js into #appearance-themes; notifications
// and the dock badge are read back through notifyEnabled()/badgeEnabled().
import { store } from "../shell/store.js";
import { openExtensions } from "../extensions.js";
import { applyTheme, currentTheme, themes as themeList } from "../shell/theme.js";

const TRANSCRIPT_KEY = "phren.desktop.transcriptSize";
const NOTIFY_KEY = "phren.desktop.notify";
const BADGE_KEY = "phren.desktop.badge";
const SIZES = [12, 13, 14];

// ------------------------------------------------------------ preferences
function readFlag(key, fallback = true) {
  try { const value = localStorage.getItem(key); return value === null ? fallback : value !== "0"; }
  catch { return fallback; }
}

function writeFlag(key, on) {
  try { localStorage.setItem(key, on ? "1" : "0"); } catch { /* private window: this session only */ }
}

export function notifyEnabled() { return readFlag(NOTIFY_KEY); }
export function badgeEnabled() { return readFlag(BADGE_KEY); }

function readTranscriptSize() {
  try { const value = Number(localStorage.getItem(TRANSCRIPT_KEY)); return SIZES.includes(value) ? value : 13; }
  catch { return 13; }
}

function applyTranscriptSize(px) {
  document.documentElement.style.setProperty("--transcript-size", `${px}px`);
}
applyTranscriptSize(readTranscriptSize());

// ------------------------------------------------------------ helpers
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

const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function input(placeholder, className) {
  const field = document.createElement("input");
  field.type = "text";
  field.className = className ? `settings-input ${className}` : "settings-input";
  field.placeholder = placeholder;
  field.setAttribute("aria-label", placeholder);
  return field;
}

function button(label, kind) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = kind ? `settings-btn ${kind}` : "settings-btn";
  b.textContent = label;
  return b;
}

/** A small-caps heading with an optional live count span. Returns [heading, count]. */
function heading(label) {
  const h = el("h2", "section-label settings-heading");
  h.append(document.createTextNode(label));
  const count = el("span", "settings-count");
  h.append(count);
  return [h, count];
}

function noticeLine() {
  const line = el("div", "settings-notice");
  line.hidden = true;
  return line;
}

function showNotice(line, text, danger) {
  line.textContent = text;
  line.className = danger ? "settings-notice settings-error" : "settings-notice";
  line.hidden = !text;
}

// ------------------------------------------------------------ section
const PAGES = [
  { id: "computers", label: "Computers" },
  { id: "keys", label: "Keys" },
  { id: "extensions", label: "Extensions" },
  { id: "appearance", label: "Appearance" },
  { id: "notifications", label: "Notifications" },
];

export function mountSettings(root) {
  const wrap = el("div", "settings");
  const nav = el("nav", "settings-nav");
  nav.setAttribute("aria-label", "Settings");
  const body = el("div", "settings-body");
  wrap.append(nav, body);
  root.replaceChildren(wrap);

  const panes = new Map();
  for (const def of PAGES) {
    const tab = button(def.label);
    tab.className = "settings-tab";
    tab.dataset.page = def.id;
    nav.append(tab);
    const page = el("div", `settings-page settings-page-${def.id}`);
    page.dataset.page = def.id;
    page.hidden = true;
    body.append(page);
    panes.set(def.id, { tab, page, built: false, refresh: null });
  }

  let current = null;
  function select(id) {
    const pane = panes.get(id);
    if (!pane) return;
    current = id;
    for (const [pid, p] of panes) {
      const on = pid === id;
      p.tab.classList.toggle("selected", on);
      p.tab.setAttribute("aria-selected", String(on));
      p.page.hidden = !on;
    }
    if (!pane.built) {
      pane.built = true;
      pane.refresh = BUILDERS[id]?.(pane.page) ?? null;
    } else {
      pane.refresh?.();
    }
  }

  for (const def of PAGES) panes.get(def.id).tab.addEventListener("click", () => select(def.id));
  select("computers");

  return { show() { if (current) panes.get(current)?.refresh?.(); } };
}

const BUILDERS = {
  computers: buildComputers,
  keys: buildKeys,
  extensions: buildExtensions,
  appearance: buildAppearance,
  notifications: buildNotifications,
};

// ------------------------------------------------------------ page: Computers
function buildComputers(page) {
  const [head, count] = heading("Computers");
  const intro = el("div", "settings-note", "Computers this desktop can reach. Linking installs this desktop's key over your own ssh login.");
  const list = el("div", "settings-list");
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

  function render() {
    const computers = store.merged?.computers ?? [];
    count.textContent = computers.length ? String(computers.length) : "";
    if (!computers.length) {
      list.replaceChildren(el("div", "settings-empty", "No computers linked."));
      return;
    }
    list.replaceChildren(...computers.map(computerRow));
  }

  function computerRow(c) {
    const info = meta.get(c.computer) ?? {};
    const row = el("div", "settings-row");
    row.append(el("span", `settings-dot state-${c.state}`));
    const main = el("div", "settings-row-main");
    main.append(el("div", "settings-row-title", c.computer));
    const metaLine = el("div", "settings-row-meta");
    const version = el("span", "settings-version", "");
    metaLine.append(version);
    metaLine.append(el("span", "", c.state === "online" ? "online" : c.error ? `${c.state}: ${c.error}` : c.state));
    if (info.address) metaLine.append(el("span", "", `${info.username ? info.username + "@" : ""}${info.address}${info.port ? ":" + info.port : ""}`));
    metaLine.append(el("span", "", info.local ? "Local socket" : "Desktop key"));
    main.append(metaLine);
    row.append(main);

    const actions = el("div", "settings-actions");
    const revoke = button("Revoke", "danger");
    revoke.addEventListener("click", () => confirmRevoke(actions, revoke, c.computer));
    actions.append(revoke);
    row.append(actions);

    store.capabilities(c.computer).then(() => {
      const v = store.version(c.computer);
      if (v) version.textContent = `v${v}`;
      else version.remove();
    });
    return row;
  }

  function confirmRevoke(actions, revokeBtn, name) {
    actions.replaceChildren();
    actions.append(el("span", "settings-inline-note", `Revoke ${name}?`));
    const yes = button("Revoke", "danger");
    const cancel = button("Cancel");
    yes.addEventListener("click", async () => {
      yes.disabled = true;
      try {
        await post("/api/computers/revoke", { name });
        showNotice(notice, `Revoked ${name}.`, false);
        render();
      } catch (err) {
        showNotice(notice, err.message, true);
        yes.disabled = false;
      }
    });
    cancel.addEventListener("click", () => actions.replaceChildren(revokeBtn));
    actions.append(yes, cancel);
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
  return render;
}

// ------------------------------------------------------------ page: Keys
function buildKeys(page) {
  const [head, count] = heading("Keys");
  const reload = button("Reload");
  const toolbar = el("div", "settings-toolbar");
  toolbar.append(el("div", "settings-note", "Shortcut bindings the desktop reads at startup."), reload);
  const notice = noticeLine();
  const content = el("div", "settings-keys");
  page.append(head, toolbar, notice, content);

  function fileLine(label, path) {
    const line = el("div", "settings-note");
    line.append(document.createTextNode(`${label}: `));
    line.append(el("span", "settings-config-path", path || "unknown"));
    return line;
  }

  function bindingTable(definitions, bindings, app) {
    const table = el("div", "settings-keytable");
    const groups = new Map();
    for (const def of definitions.values()) {
      if (Boolean(def.app) !== app) continue;
      if (!groups.has(def.group)) groups.set(def.group, []);
      groups.get(def.group).push(def);
    }
    for (const [group, list] of groups) {
      table.append(el("div", "settings-subgroup-label", group));
      for (const def of list) {
        const row = el("div", "settings-keyrow");
        row.append(el("span", "settings-keylabel", def.label));
        const caps = el("span", "settings-caps");
        const keys = (bindings ?? {})[def.action] ?? [];
        if (!keys.length) caps.append(el("span", "settings-unbound", "unbound"));
        else for (const key of keys) caps.append(el("kbd", "settings-kbd", key));
        row.append(caps);
        table.append(row);
      }
    }
    if (!table.childNodes.length) table.append(el("div", "settings-note", "No shortcuts."));
    return table;
  }

  function render(config) {
    const definitions = new Map((config.actions ?? []).map((a) => [a.action, a]));
    count.textContent = config.actions?.length ? String(config.actions.length) : "";
    const frag = document.createDocumentFragment();
    const files = el("div", "settings-files");
    files.append(fileLine("Desktop config", config.files?.desktop));
    files.append(fileLine("Herdr config", config.files?.herdr));
    frag.append(files);
    const prefix = (config.bindings?.prefix ?? []).join("  ");
    if (prefix) {
      const p = el("div", "settings-prefix");
      p.append(el("span", "settings-keylabel", "Prefix"));
      p.append(el("kbd", "settings-kbd", prefix));
      frag.append(p);
    }
    frag.append(el("div", "settings-group-label", "PREFIX SHORTCUTS"));
    frag.append(bindingTable(definitions, config.bindings, false));
    frag.append(el("div", "settings-group-label", "APP SHORTCUTS"));
    frag.append(bindingTable(definitions, config.appBindings, true));
    for (const error of config.errors ?? []) frag.append(el("div", "settings-error", error));
    content.replaceChildren(frag);
  }

  async function load() {
    content.replaceChildren(el("div", "settings-note", "Loading…"));
    try {
      render(await api("/api/keys"));
    } catch (err) {
      content.replaceChildren(el("div", "settings-error", err.message));
    }
  }

  reload.addEventListener("click", async () => {
    await load();
    showNotice(notice, "Reloaded from disk. Restart the app to apply changes to the keys.", false);
  });

  load();
  return load;
}

// ------------------------------------------------------------ page: Extensions
function buildExtensions(page) {
  const [head] = heading("Extensions");
  const host = el("div", "settings-ext-host");
  page.append(head, host);
  openExtensions(host, {});
  return null;
}

// ------------------------------------------------------------ page: Appearance
function buildAppearance(page) {
  const [head] = heading("Appearance");
  page.append(head);
  page.append(el("div", "settings-group-label", "THEMES"));
  const themes = el("div", "settings-themes");
  themes.id = "appearance-themes";
  themes.setAttribute("role", "radiogroup");
  themes.setAttribute("aria-label", "Theme");
  const paint = () => {
    for (const b of themes.children) {
      const on = b.dataset.theme === currentTheme();
      b.classList.toggle("selected", on);
      b.setAttribute("aria-checked", String(on));
    }
  };
  for (const t of themeList()) {
    const b = el("button", "settings-theme", t.name);
    b.dataset.theme = t.id;
    b.setAttribute("role", "radio");
    b.addEventListener("click", async () => { await applyTheme(t.id); paint(); });
    themes.append(b);
  }
  paint();
  page.append(themes);
  page.append(el("div", "settings-group-label", "TRANSCRIPT TEXT"));
  const field = el("div", "settings-field");
  field.append(el("label", "settings-field-label", "Font size"));
  const select = document.createElement("select");
  select.className = "settings-select";
  select.setAttribute("aria-label", "Transcript font size");
  for (const px of SIZES) {
    const option = document.createElement("option");
    option.value = String(px);
    option.textContent = `${px} px`;
    select.append(option);
  }
  select.value = String(readTranscriptSize());
  select.addEventListener("change", () => {
    const px = Number(select.value);
    applyTranscriptSize(px);
    try { localStorage.setItem(TRANSCRIPT_KEY, String(px)); } catch { /* private window: this session only */ }
  });
  field.append(select);
  page.append(field);
  return null;
}

// ------------------------------------------------------------ page: Notifications
function toggleRow(labelText, checked, onChange) {
  const row = el("label", "settings-toggle");
  row.append(el("span", "settings-toggle-label", labelText));
  const control = el("span", "settings-switch");
  const field = document.createElement("input");
  field.type = "checkbox";
  field.checked = checked;
  field.addEventListener("change", () => onChange(field.checked));
  control.append(field, el("span", "track"));
  row.append(control);
  return row;
}

function buildNotifications(page) {
  const [head] = heading("Notifications");
  const list = el("div", "settings-list");
  list.append(toggleRow("Notify when an agent needs me", notifyEnabled(), (on) => writeFlag(NOTIFY_KEY, on)));
  list.append(toggleRow("Show the needs-you count on the dock icon", badgeEnabled(), (on) => writeFlag(BADGE_KEY, on)));
  page.append(head, list);
  return null;
}

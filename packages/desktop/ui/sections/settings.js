// Settings: one home for global configuration, a left list of pages and the
// page on the right. Each page lives in ./settings/ (Computers, Keys, Appearance,
// Notifications, Diagnostics, About); Extensions is the extensions host.
// The theme picker is filled by app.js into #appearance-themes; notifications
// and the dock badge are read back through notifyEnabled()/badgeEnabled().
import { openExtensions } from "../extensions.js";
import { registerPauseCommand } from "../shell/pause-all.js";
import { button, el, heading } from "./settings/ui.js";
import { buildComputers } from "./settings/computers.js";
import { buildKeys } from "./settings/keys.js";
import { buildAppearance } from "./settings/appearance.js";
import { buildNotifications } from "./settings/notifications.js";
import { buildDiagnostics } from "./settings/diagnostics.js";
import { buildAbout } from "./settings/about.js";

export { badgeEnabled, ciNotifyEnabled, notifyEnabled, prNotifyEnabled, recentSwitchEnabled, stallNotifyEnabled } from "./settings/prefs.js";

// The "Pause all agents" palette command is app-wide: register it once, at
// import, so it is there before the Computers page is ever opened.
registerPauseCommand();

// ------------------------------------------------------------ section
const PAGES = [
  { id: "computers", label: "Computers" },
  { id: "keys", label: "Keys" },
  { id: "extensions", label: "Extensions" },
  { id: "appearance", label: "Appearance" },
  { id: "notifications", label: "Notifications" },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "about", label: "About" },
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
    if (current && current !== id) panes.get(current)?.refresh?.hide?.();
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

  return {
    show() { if (current) panes.get(current)?.refresh?.(); },
    hide() { if (current) panes.get(current)?.refresh?.hide?.(); },
    close() { for (const pane of panes.values()) pane.refresh?.close?.(); },
  };
}

const BUILDERS = {
  computers: buildComputers,
  keys: buildKeys,
  extensions: buildExtensions,
  appearance: buildAppearance,
  notifications: buildNotifications,
  diagnostics: buildDiagnostics,
  about: buildAbout,
};


// ------------------------------------------------------------ page: Extensions
function buildExtensions(page) {
  const [head] = heading("Extensions");
  const host = el("div", "settings-ext-host");
  page.append(head, host);
  openExtensions(host, {});
  return null;
}

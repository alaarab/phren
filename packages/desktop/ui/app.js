// Phren desktop's UI entry: the titlebar, the section registry and the
// overview store. Sections live in ./sections, shared plumbing in ./shell.
import { installKeys } from "./keys.js";
import { connectStore, store } from "./shell/store.js";
import { installSections, registerSection, sectionHandle, setSectionBadge, showSection } from "./shell/sections.js";
import { mountAgents } from "./sections/agents.js";
import { mountHome } from "./sections/home.js";
import { mountProjects } from "./sections/projects.js";
import { mountTasks } from "./sections/tasks.js";
import { initTheme } from "./shell/theme.js";
import { mountSettings, notifyEnabled, badgeEnabled } from "./sections/settings.js";
import { mountUsageRings } from "./shell/usage-rings.js";

// The Electron shell exposes window.phrenDesktop; in a browser it is absent.
const shell = window.phrenDesktop;
void initTheme();
if (shell) document.documentElement.classList.add("electron", `platform-${shell.platform}`);

const countEl = document.getElementById("conn-count");
const needsEl = document.getElementById("needs-pill");

const agents = () => sectionHandle("agents");

registerSection("home", { label: "Home", order: 10, badge: true, mount: (el) => mountHome(el, {
  openSession(computer, child) { showSection("agents"); agents().openSession(computer, child); },
}) });
registerSection("agents", { label: "Agents", order: 20, mount: (el) => mountAgents(el) });
registerSection("projects", { label: "Projects", order: 30, mount: (el) => mountProjects(el) });
registerSection("tasks", { label: "Tasks", order: 40, mount: (el) => mountTasks(el) });
registerSection("settings", { label: "Settings", order: 90, mount: (el) => mountSettings(el) });

installSections(document.getElementById("section-pills"), document.getElementById("sections"));
mountUsageRings(document.getElementById("usage-rings"));

// Titlebar status: computers online and the needs-you count.
store.subscribe((merged) => {
  const computers = merged?.computers ?? [];
  const online = computers.filter((c) => c.state === "online").length;
  countEl.textContent = `${online}/${computers.length} computers`;
  countEl.title = computers.map((c) => `${c.computer}: ${c.state}`).join("\n");
  const needs = store.needsYou().length;
  needsEl.hidden = !needs;
  needsEl.textContent = `${needs} need${needs === 1 ? "s" : ""} you`;
  setSectionBadge("home", needs);
});
needsEl.addEventListener("click", () => {
  const [first] = store.needsYou();
  if (first) { showSection("agents"); agents().openSession(first.computer, first.child); }
});

// Native badge and notifications for new needs-you rows.
let notified = null; // keys already announced; null until the first frame
store.subscribe(() => {
  const rows = store.needsYou();
  shell?.setBadge(badgeEnabled() ? rows.length : 0);
  document.title = rows.length ? `(${rows.length}) Phren` : "Phren";
  const keys = new Set(rows.map((r) => r.key));
  if (notified && shell && notifyEnabled()) {
    for (const r of rows) {
      if (notified.has(r.key)) continue;
      const project = (r.child.cwd ?? r.child.label ?? "").split("/").filter(Boolean).pop() ?? r.child.label;
      shell.notify(`${project} needs you`, `${r.child.title ?? r.child.label} · ${r.computer}`);
    }
  }
  notified = keys;
});

connectStore();
// Mount Agents first (keys.js binds to its sidebar), then open the section the
// URL names, else Home: the window opens on what needs you.
showSection("agents");
const initial = location.hash.replace(/^#\/?/, "") || "home";
if (initial !== "agents") showSection(initial);

installKeys({
  showPane: (key) => { showSection("agents"); agents().showPane(key); },
  toggleZoom: () => agents().toggleZoom(),
  closePanel: () => agents().closePanel(),
  closeTab: () => agents().closeTab(),
  get tiles() { return agents().tiles; },
  toggleConsole: () => agents().toggleConsole(),
  nextTab: () => agents().nextTab(),
  previousTab: () => agents().previousTab(),
  currentSession: () => agents().currentSession(),
});

// ⇧⌘F opens Search for the open session, as in VS Code.
window.addEventListener("keydown", (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.shiftKey && ev.key.toLowerCase() === "f" && agents().currentSession()) {
    ev.preventDefault();
    showSection("agents");
    agents().showPane("search");
  }
});

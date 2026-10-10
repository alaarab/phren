// Phren desktop's UI entry: the titlebar, the section registry and the
// overview store. Sections live in ./sections, shared plumbing in ./shell.
import { installKeys } from "./keys.js";
import { connectStore, store } from "./shell/store.js";
import { installSections, registerSection, sectionHandle, setSectionBadge, showSection } from "./shell/sections.js";
import { mountAgents } from "./sections/agents.js";
import { mountHome } from "./sections/home.js";
import { mountProjects } from "./sections/projects.js";
import { mountTasks } from "./sections/tasks.js";
import { mountSchedules } from "./sections/schedules.js";
import { mountPreviews } from "./sections/previews.js";
import { mountMemory } from "./sections/memory.js";
import { mountConductor } from "./sections/conductor.js";
import { mountReview } from "./sections/review.js";
import { mountCode } from "./sections/code.js";
import "./shell/launch.js"; // registers "Launch an agent…" in the palette
import { registerPauseCommand } from "./shell/pause-all.js";
registerPauseCommand();
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

const GEAR = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M8 5.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6Zm0 4.2a1.4 1.4 0 1 1 0-2.8 1.4 1.4 0 0 1 0 2.8Zm6.1-2.3-1.2-.2a5 5 0 0 0-.5-1.2l.7-1a.7.7 0 0 0-.1-.9l-.8-.8a.7.7 0 0 0-.9-.1l-1 .7a5 5 0 0 0-1.2-.5L8.9 1.9A.7.7 0 0 0 8.2 1.3H7.8a.7.7 0 0 0-.7.6l-.2 1.2a5 5 0 0 0-1.2.5l-1-.7a.7.7 0 0 0-.9.1l-.8.8a.7.7 0 0 0-.1.9l.7 1a5 5 0 0 0-.5 1.2l-1.2.2a.7.7 0 0 0-.6.7v.4c0 .3.3.6.6.7l1.2.2c.1.4.3.8.5 1.2l-.7 1a.7.7 0 0 0 .1.9l.8.8c.2.2.6.3.9.1l1-.7c.4.2.8.4 1.2.5l.2 1.2c.1.3.4.6.7.6h.4c.3 0 .6-.3.7-.6l.2-1.2c.4-.1.8-.3 1.2-.5l1 .7c.3.2.7.1.9-.1l.8-.8c.2-.2.3-.6.1-.9l-.7-1c.2-.4.4-.8.5-1.2l1.2-.2c.3-.1.6-.4.6-.7v-.4a.7.7 0 0 0-.6-.7Z"/></svg>';
registerSection("home", { label: "Home", order: 10, badge: true, mount: (el) => mountHome(el, {
  openSession(computer, child) { showSection("agents"); agents().openSession(computer, child); },
}) });
registerSection("agents", { label: "Agents", order: 20, mount: (el) => mountAgents(el) });
registerSection("review", { label: "Review", order: 22, mount: (el) => mountReview(el) });
registerSection("conductor", { label: "Conductor", order: 70, group: "fleet", groupLabel: "Fleet", mount: (el) => mountConductor(el) });
registerSection("projects", { label: "Projects", order: 30, group: "work", groupLabel: "Projects", mount: (el) => mountProjects(el) });
registerSection("tasks", { label: "Tasks", order: 40, group: "work", mount: (el) => mountTasks(el) });
registerSection("memory", { label: "Memory", order: 45, group: "work", mount: (el) => mountMemory(el) });
registerSection("code", { label: "Code", order: 47, group: "work", mount: (el) => mountCode(el) });
registerSection("schedules", { label: "Schedules", order: 72, group: "fleet", mount: (el) => mountSchedules(el) });
registerSection("previews", { label: "Previews", order: 74, group: "fleet", mount: (el) => mountPreviews(el) });
registerSection("settings", { label: "Settings", order: 90, icon: GEAR, mount: (el) => mountSettings(el) });

installSections(document.getElementById("section-pills"), document.getElementById("sections"), {
  sub: document.getElementById("section-sub"),
  icons: document.getElementById("section-icons"),
});
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
// Read the hash first: showing a section rewrites it.
const initial = location.hash.replace(/^#\/?/, "") || "home";
sectionHandle("agents"); // mounted hidden, without touching the hash
showSection(initial);

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

// Desk first: while the owner types or moves the mouse here, approval alerts
// wait before reaching the phone. Reported at most every 15 s, only while focused.
let presenceAt = 0;
function reportPresence() {
  if (!document.hasFocus() || Date.now() - presenceAt < 15_000) return;
  presenceAt = Date.now();
  fetch("/api/presence", { method: "POST", headers: { "Content-Type": "application/json", "X-Phren-Desktop": "1" }, body: "{}" }).catch(() => {});
}
for (const type of ["keydown", "pointerdown", "pointermove", "wheel"]) window.addEventListener(type, reportPresence, { passive: true, capture: true });

// Push-to-talk (hold F5) speaks to the conductor from anywhere in the app.
import("./chat/talk.js").then(({ installPushToTalk }) => installPushToTalk({
  conductor() {
    const row = store.sessions().find(({ child }) => child.role === "conductor");
    return row ? { computer: row.computer, target: row.child.target } : null;
  },
  send: (computer, target, text) => fetch(`/hosts/${encodeURIComponent(computer)}/v1/prompt`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Phren-Desktop": "1" },
    body: JSON.stringify({ target, text, deliveryId: crypto.randomUUID() }),
  }),
})).catch(() => {});

// Settings › Notifications: what notifies, quiet hours and the menu bar icon.
import { quietSettings, saveQuietSettings } from "../../shell/quiet.js";
import { setTrayEnabled, trayAvailable, trayEnabled } from "../../shell/tray.js";
import { el, heading, toggleRow } from "./ui.js";
import { BADGE_KEY, CI_KEY, NOTIFY_KEY, STALL_KEY, badgeEnabled, ciNotifyEnabled, notifyEnabled, stallNotifyEnabled, writeFlag } from "./prefs.js";

// ------------------------------------------------------------ page: Notifications

export function buildNotifications(page) {
  const [head] = heading("Notifications");
  const list = el("div", "settings-list");
  list.append(toggleRow("Notify when an agent needs me", notifyEnabled(), (on) => writeFlag(NOTIFY_KEY, on)));
  list.append(toggleRow("Show the needs-you count on the dock icon", badgeEnabled(), (on) => writeFlag(BADGE_KEY, on)));
  list.append(toggleRow("Notify when a session's pull request checks pass or fail", ciNotifyEnabled(), (on) => writeFlag(CI_KEY, on)));
  list.append(toggleRow("Notify when an agent looks stuck", stallNotifyEnabled(), (on) => writeFlag(STALL_KEY, on)));
  list.append(quietRow());
  if (trayAvailable()) {
    const where = window.phrenDesktop.platform === "darwin" ? "menu bar" : "system tray";
    list.append(toggleRow(`Show who needs you in the ${where}`, trayEnabled(), setTrayEnabled));
  }
  page.append(head, list);
  return null;
}

/** Quiet hours: a toggle, then the from/to times on their own line (inputs
 * inside the toggle's label would flip it when clicked). */
function quietRow() {
  const q = quietSettings();
  const wrap = el("div", "settings-quiet");
  const times = el("div", `settings-quiet-times${q.on ? "" : " off"}`);
  const toggle = toggleRow("Quiet hours: no notifications", q.on, (on) => { saveQuietSettings({ on }); times.classList.toggle("off", !on); });
  const time = (value, label, key) => {
    const field = document.createElement("input");
    field.type = "time";
    field.value = value;
    field.className = "settings-time";
    field.setAttribute("aria-label", label);
    field.addEventListener("change", () => { if (field.value) saveQuietSettings({ [key]: field.value }); });
    return field;
  };
  times.append(el("span", "settings-note", "From"), time(q.from, "Quiet from", "from"), el("span", "settings-note", "until"), time(q.to, "Quiet until", "to"));
  wrap.append(toggle, times);
  return wrap;
}

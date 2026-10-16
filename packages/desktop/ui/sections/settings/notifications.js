import { loadQuotaState, quotaSettings, saveQuotaSettings } from "../../shell/quota-warn-prefs.js";
// Settings › Notifications: what notifies, quiet hours, and where the needs-you count shows.
import { quietSettings, saveQuietSettings } from "../../shell/quiet.js";
import { setTrayEnabled, trayAvailable, trayEnabled } from "../../shell/tray.js";
import { el, heading, toggleRow } from "./ui.js";
import { BADGE_KEY, CI_KEY, NOTIFY_KEY, PR_KEY, STALL_KEY, badgeEnabled, ciNotifyEnabled, notifyEnabled, prNotifyEnabled, stallNotifyEnabled, writeFlag } from "./prefs.js";

// ------------------------------------------------------------ page: Notifications

export function buildNotifications(page) {
  const [head] = heading("Notifications");
  // Three groups: what notifies, when it stays quiet, and where the needs-you count shows.
  const notify = el("div", "settings-list");
  notify.append(toggleRow("An agent needs me", notifyEnabled(), (on) => writeFlag(NOTIFY_KEY, on)));
  notify.append(toggleRow("An agent stalls", stallNotifyEnabled(), (on) => writeFlag(STALL_KEY, on)));
  notify.append(toggleRow("A session's pull request checks pass or fail", ciNotifyEnabled(), (on) => writeFlag(CI_KEY, on)));
  notify.append(toggleRow("Pull request reviews and conflicts", prNotifyEnabled(), (on) => writeFlag(PR_KEY, on)));
  const quota = el("div", "settings-list");
  const prefs = quotaSettings();
  const quotaToggle = toggleRow("Account usage warnings", prefs.on, (on) => {
    void saveQuotaSettings({ on }).then(refreshQuota).catch(quotaError);
  });
  const backToggle = toggleRow("Notify when an account has room again", prefs.backOn, (backOn) => {
    void saveQuotaSettings({ backOn }).then(refreshQuota).catch(quotaError);
  });
  quota.append(quotaToggle);
  const quotaLabel = el("label", "settings-toggle");
  const threshold = el("input", "settings-input");
  threshold.type = "number";
  threshold.min = "50";
  threshold.max = "99";
  threshold.step = "1";
  threshold.value = String(prefs.threshold);
  threshold.disabled = true;
  threshold.setAttribute("aria-label", "Account usage warning percentage");
  threshold.style.width = "80px";
  threshold.addEventListener("change", () => {
    void saveQuotaSettings({ threshold: threshold.value }).then(refreshQuota).catch(quotaError);
  });
  quotaLabel.append(el("span", "settings-toggle-label", "Warn when an account reaches"), threshold, el("span", "settings-note", "% of its limit"));
  const quotaNotice = el("div", "settings-error");
  const quotaSwitch = quotaToggle.querySelector("input");
  quotaSwitch.disabled = true;
  const backSwitch = backToggle.querySelector("input");
  backSwitch.disabled = true;
  function refreshQuota() {
    const settings = quotaSettings();
    quotaSwitch.checked = settings.on;
    quotaSwitch.disabled = false;
    backSwitch.checked = settings.backOn;
    backSwitch.disabled = false;
    threshold.value = String(settings.threshold);
    threshold.disabled = !settings.on;
    quotaNotice.textContent = "";
  }
  function quotaError() { quotaNotice.textContent = "Account warning preferences could not be saved or loaded. Reopen this page to retry."; }
  quota.append(quotaLabel, backToggle, quotaNotice);
  const refresh = () => { void loadQuotaState().then(refreshQuota).catch(quotaError); };
  refresh();
  const quiet = el("div", "settings-list");
  quiet.append(quietRow());
  const show = el("div", "settings-list");
  show.append(toggleRow("On the dock icon", badgeEnabled(), (on) => writeFlag(BADGE_KEY, on)));
  if (trayAvailable()) {
    const where = window.phrenDesktop.platform === "darwin" ? "menu bar" : "system tray";
    show.append(toggleRow(`In the ${where}, with who it is`, trayEnabled(), setTrayEnabled));
  }
  page.append(head,
    el("div", "settings-group-label", "Notify me when"), notify,
    el("div", "settings-group-label", "Account usage"), quota,
    el("div", "settings-group-label", "Quiet hours"), quiet,
    el("div", "settings-group-label", "Show the needs-you count"), show);
  return refresh;
}

/** Quiet hours: a toggle, then the from/to times on their own line (inputs
 * inside the toggle's label would flip it when clicked). */
function quietRow() {
  const q = quietSettings();
  const wrap = el("div", "settings-quiet");
  const times = el("div", `settings-quiet-times${q.on ? "" : " off"}`);
  const toggle = toggleRow("No notifications during these hours", q.on, (on) => { saveQuietSettings({ on }); times.classList.toggle("off", !on); });
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

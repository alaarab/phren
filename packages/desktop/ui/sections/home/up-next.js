import { el } from "../../dom.js";
import { rowShell } from "./rows.js";
import { showSection } from "../../shell/sections.js";
import { clockLabel, promptLine, untilLabel, upNext } from "../../shell/up-next.js";
import { harnessLabel } from "../../harness.js";

export function createUpNext({ block, scheduleLists }) {
  // Rows are keyed by schedule: an unchanged poll or overview update keeps the
  // same buttons (and keyboard focus) and only refreshes their wait labels.
  let upNextRows = new Map(); // key -> { button, sig, when }

  function upNextRow(entry, sig) {
    const { schedule } = entry;
    const line = promptLine(schedule);
    const shell = rowShell({ sub: line ? el("span", "home-row-sub", line) : undefined });
    shell.button.classList.add("home-upnext");
    shell.button.dataset.key = entry.key;
    shell.title.textContent = schedule.name || "Scheduled prompt";
    const meta = el("span", "home-row-meta");
    if (schedule.harness) meta.append(el("span", "home-tag", harnessLabel(schedule.harness)));
    // Project and computer names can be long: they shrink and truncate, full text on hover.
    if (schedule.project) {
      const project = el("span", "home-project home-upnext-label", schedule.project);
      project.title = schedule.project;
      meta.append(project);
    }
    const host = el("span", "home-host home-upnext-label", entry.computer);
    host.title = entry.computer;
    meta.append(host);
    const when = el("span", "home-upnext-when");
    meta.append(when);
    shell.button.append(meta);
    shell.button.addEventListener("click", () => showSection("schedules"));
    return { button: shell.button, sig, when };
  }

  /** The scheduled prompts due in the next hours, from the schedules Home already reads. */
  function renderUpNext() {
    const scope = block("upnext");
    const list = scope.querySelector(".home-list");
    const now = Date.now();
    const rows = upNext(scheduleLists, now);
    scope.hidden = !rows.length;
    scope.querySelector(".count").textContent = rows.length ? String(rows.length) : "";
    const active = document.activeElement;
    const focusKey = active && scope.contains(active) ? active.dataset?.key : undefined;
    const next = new Map();
    const buttons = rows.map((entry) => {
      const { schedule } = entry;
      const sig = JSON.stringify([schedule.name, schedule.prompt, schedule.harness, schedule.project, entry.computer]);
      let row = upNextRows.get(entry.key);
      if (!row || row.sig !== sig) row = upNextRow(entry, sig);
      const until = untilLabel(entry.at, now);
      const clock = clockLabel(entry.at, now);
      if (row.when.textContent !== until) row.when.textContent = until;
      if (row.when.title !== clock) row.when.title = clock;
      row.button.setAttribute("aria-label", `${schedule.name || "Scheduled prompt"}, runs ${until} at ${clock} on ${entry.computer}`);
      next.set(entry.key, row);
      return row.button;
    });
    upNextRows = next;
    const current = [...list.children];
    if (buttons.length === current.length && buttons.every((button, i) => button === current[i])) return;
    list.replaceChildren(...buttons);
    if (focusKey) buttons.find((button) => button.dataset.key === focusKey)?.focus();
  }
  return renderUpNext;
}

import { el } from "../../dom.js";
import { rowShell } from "./rows.js";
import { showSection } from "../../shell/sections.js";
import { clockLabel, promptLine, untilLabel, upNext } from "../../shell/up-next.js";
import { runSchedule } from "../../shell/schedule-run.js";
import { store } from "../../shell/store.js";
import { harnessLabel } from "../../harness.js";

export function createUpNext({ block, scheduleLists, state }) {
  // Rows are keyed by schedule: an unchanged poll or overview update keeps the
  // same buttons (and keyboard focus) and only refreshes their wait labels.
  let upNextRows = new Map(); // schedule key -> mounted row and launch state

  function upNextRow(entry) {
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
    const wrap = el("div", "home-upnext-wrap");
    const actions = el("div", "home-upnext-actions");
    const run = el("button", "home-upnext-run", "Run now");
    const cancel = el("button", "home-upnext-run", "Cancel");
    run.type = cancel.type = "button";
    cancel.hidden = true;
    const note = el("span", "home-upnext-note");
    note.setAttribute("role", "status");
    note.hidden = true;
    actions.append(run, cancel);
    wrap.append(shell.button, actions, note);
    const row = { wrap, button: shell.button, when, title: shell.title, meta,
      entry, run, cancel, note, timer: null, confirming: false, busy: false, disposed: false, unavailable: false };
    row.allowed = () => !row.entry.schedule.running && !row.unavailable
      && store.can?.(row.entry.computer, "schedules") !== false
      && (!state || state.merged?.computers?.some((c) => c.computer === row.entry.computer && c.state === "online"));
    row.update = () => {
      run.disabled = row.busy || !row.allowed();
      run.setAttribute("aria-busy", String(row.busy));
      run.textContent = row.busy ? "Starting…" : row.confirming ? "Run? Yes" : "Run now";
      cancel.hidden = !row.confirming;
      run.title = row.entry.schedule.running ? "Already running" : !row.allowed() ? "Run now unavailable on this computer" : "Run this schedule now";
    };
    row.reset = () => { row.confirming = false; row.update(); };
    cancel.addEventListener("click", (event) => {
      event.stopPropagation(); clearTimeout(row.timer); row.reset(); run.focus();
    });
    run.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (row.disposed || row.busy || !row.allowed()) return;
      clearTimeout(row.timer);
      if (!row.confirming) {
        row.confirming = true; row.update();
        row.timer = setTimeout(row.reset, 5000);
        return;
      }
      row.confirming = false; row.busy = true; note.hidden = true; row.update();
      try {
        await runSchedule(row.entry.computer, row.entry.schedule);
        note.textContent = "Started";
      } catch (error) {
        note.textContent = error?.message || "Could not start this schedule.";
        if (error?.status === 404 || error?.status === 501) row.unavailable = true;
      } finally {
        if (!row.disposed) {
          row.busy = false; note.hidden = false; row.update();
          row.timer = setTimeout(() => { note.hidden = true; }, 4000);
        }
      }
    });
    return row;
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
    const keepFocus = active && scope.contains(active);
    const next = new Map();
    const buttons = rows.map((entry) => {
      const { schedule } = entry;
      let row = upNextRows.get(entry.key);
      if (!row) row = upNextRow(entry);
      row.entry = entry;
      row.title.textContent = schedule.name || "Scheduled prompt";
      const line = promptLine(schedule);
      const main = row.button.children[0];
      if (row.line !== line) {
        main.replaceChildren(row.title, ...(line ? [el("span", "home-row-sub", line)] : []));
        row.line = line;
      }
      const metaSig = JSON.stringify([schedule.harness, schedule.project, entry.computer]);
      if (row.metaSig !== metaSig) {
        const labels = [];
        if (schedule.harness) labels.push(el("span", "home-tag", harnessLabel(schedule.harness)));
        for (const [kind, text] of [["project", schedule.project], ["host", entry.computer]]) {
          if (!text) continue;
          const label = el("span", `home-${kind} home-upnext-label`, text);
          label.title = text;
          labels.push(label);
        }
        row.meta.replaceChildren(...labels, row.when);
        row.metaSig = metaSig;
      }
      row.update();
      const until = untilLabel(entry.at, now);
      const clock = clockLabel(entry.at, now);
      if (row.when.textContent !== until) row.when.textContent = until;
      if (row.when.title !== clock) row.when.title = clock;
      row.button.setAttribute("aria-label", `${schedule.name || "Scheduled prompt"}, runs ${until} at ${clock} on ${entry.computer}`);
      next.set(entry.key, row);
      return row.wrap;
    });
    for (const [key, row] of upNextRows) if (!next.has(key)) { row.disposed = true; clearTimeout(row.timer); }
    upNextRows = next;
    const current = [...list.children];
    if (buttons.length === current.length && buttons.every((button, i) => button === current[i])) return;
    list.replaceChildren(...buttons);
    if (keepFocus && buttons.some((button) => button.contains(active))) active.focus();
  }
  renderUpNext.destroy = () => { for (const row of upNextRows.values()) { row.disposed = true; clearTimeout(row.timer); } upNextRows.clear(); };
  return renderUpNext;
}

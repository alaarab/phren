import { el } from "../../dom.js";
import { hookDrift, hookVersion, updateCommand } from "../../shell/hook-drift.js";
import { renderJobs } from "./jobs.js";
function gb(bytes) {
  return `${(Number(bytes) / 1_073_741_824).toFixed(1)} GB`;
}


export function createComputers({ state, open, block }) {
  /** The Hook's version, and when it is older than the newest seen, a chip that copies its update command. */
  function hookMeta(c, drift) {
    const version = hookVersion(c);
    if (!version) return [];
    const behind = drift.behind.has(c.computer);
    const label = el("span", `home-hook${behind ? " behind" : ""}`, `Hook ${version}`);
    if (!behind) return [label];
    const command = updateCommand(drift.newest);
    const chip = el("button", "home-hook-update", `update to ${drift.newest}`);
    chip.type = "button";
    chip.title = `Copy: ${command}`;
    chip.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(command); chip.textContent = "command copied"; }
      catch { chip.textContent = command; }
    });
    return [label, chip];
  }

  function computerRow(c, drift) {
    const row = el("div", `home-row home-computer state-${c.state}`);
    row.append(el("span", "home-computer-name", c.computer));
    const meta = el("span", "home-computer-meta");
    meta.append(...hookMeta(c, drift));
    if (c.state === "online") meta.append(el("span", null, "Online"));
    else meta.append(el("span", "home-error", c.error ? `${c.state}: ${c.error}` : c.state));
    // Resource readings change independently of the Hook version controls.
    const resourceMeta = el("span", "home-computer-resources");
    meta.append(resourceMeta);
    const load = el("div", "home-load");
    row.append(meta, load);
    function updateResources(r) {
      const details = [];
      if (r && c.state === "online") {
        const jobs = Array.isArray(r.heavy) ? r.heavy.length : 0;
        details.push(el("span", "home-age", jobs ? `${jobs} heavy` : "no heavy jobs"));
        if (r.disk) details.push(el("span", "home-age", `${gb(r.disk.freeBytes)} free`));
      } else if (c.state === "online") details.push(el("span", "home-age", "no resources"));
      resourceMeta.replaceChildren(...details);
      const bar = el("div", "home-load-bar");
      const fillEl = el("span", "home-load-fill");
      const cores = r?.cpu?.cores ? Number(r.cpu.cores) : 0;
      const load1 = r?.cpu?.load1 !== undefined ? Number(r.cpu.load1) : 0;
      const fraction = cores > 0 ? Math.min(1, Math.max(0, load1 / cores)) : 0;
      fillEl.style.width = `${Math.round(fraction * 100)}%`;
      if (r?.level === "stressed") fillEl.classList.add("stressed");
      else if (r?.level === "busy") fillEl.classList.add("busy");
      bar.append(fillEl);
      load.replaceChildren(bar);
      if (r && cores > 0) load.append(el("span", "home-load-text", `load ${load1.toFixed(1)} / ${cores} cores`));
    }
    return { row, updateResources };
  }

  const computerRows = new Map();

  function renderComputers() {
    const computers = state.merged?.computers ?? [];
    const drift = hookDrift(computers);
    const scope = block("computers");
    const list = scope.querySelector(".home-list");
    scope.querySelector(".count").textContent = computers.length ? String(computers.length) : "";
    const rows = computers.map((c) => {
      let record = computerRows.get(c.computer);
      if (!record) {
        const row = el("div", "home-computer-card");
        const summary = el("div", "home-computer-summary");
        const jobs = el("div", "home-jobs");
        row.append(summary, jobs);
        record = { row, summary, list: jobs, jobs: new Map(), observed: new Map(), more: el("div", "home-jobs-more") };
        computerRows.set(c.computer, record);
      }
      const sig = JSON.stringify([c.state, c.error, hookVersion(c), drift.newest]);
      if (record.sig !== sig) {
        const summary = computerRow(c, drift);
        record.summary.replaceChildren(summary.row);
        record.updateResources = summary.updateResources;
        record.sig = sig;
      }
      record.updateResources(c.state === "online" ? c.resources : null);
      renderJobs(record, c, { merged: state.merged, open });
      return record.row;
    });
    for (const name of computerRows.keys()) if (!computers.some((c) => c.computer === name)) computerRows.delete(name);
    const current = [...list.children];
    if (rows.length !== current.length || rows.some((row, i) => row !== current[i])) {
      const active = document.activeElement;
      list.replaceChildren(...rows);
      if (rows.some((row) => row.contains(active))) active.focus();
    }
    if (!rows.length) list.replaceChildren(el("div", "home-empty", "No computers linked."));
  }
  return renderComputers;
}

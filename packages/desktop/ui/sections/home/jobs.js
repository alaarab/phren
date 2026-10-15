import { el } from "../../dom.js";
import { sessions } from "../../shell/store.js";
import { age } from "./rows.js";

export function renderJobs(record, c, { merged, open }) {
  const heavy = c.state === "online" && Array.isArray(c.resources?.heavy) ? [...c.resources.heavy] : [];
  heavy.sort((a, b) => (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0) || a.pid - b.pid);
  const now = Date.now();
  const next = new Map();
  // Remember even jobs below the three-row limit while they remain in the reading.
  const observed = new Map(heavy.map((job) => [job.pid, record.observed.get(job.pid) ?? now]));
  const nodes = heavy.slice(0, 3).map((job) => {
    const pane = job.pane;
    // Resource workspace is a label; targets use IDs. Pane IDs belong to the server.
    const match = pane && sessions(merged).find((entry) => {
      const target = entry.child.target;
      return entry.computer === c.computer && target?.server === pane.server
        && target.pane === pane.pane;
    });
    let item = record.jobs.get(job.pid);
    const clickable = Boolean(match);
    if (!item || item.clickable !== clickable) {
      const node = el(clickable ? "button" : "div", "home-job");
      if (clickable) {
        node.type = "button";
        node.addEventListener("click", () => {
          if (item.session) open(c.computer, item.session.child);
        });
      }
      const name = el("span", "home-job-name");
      const cpu = el("span", "home-job-cpu");
      const duration = el("span", "home-job-duration");
      node.append(name, cpu, duration);
      item = { node, name, cpu, duration, clickable };
    }
    item.session = match;
    item.name.textContent = job.name;
    item.name.title = job.name;
    item.cpu.textContent = `${(job.cpuPercent ?? 0).toFixed(1)}% CPU`;
    item.duration.textContent = `seen ${age(new Date(observed.get(job.pid)).toISOString())}`;
    item.duration.title = "Time observed by Home; process start time is unavailable";
    item.node.title = match ? `Open ${match.child.title || match.child.label || "session"}`
      : pane ? "The starting pane has no known session" : "No starting pane is known for this job";
    next.set(job.pid, item);
    return item.node;
  });
  if (heavy.length > 3) {
    record.more.textContent = `+${heavy.length - 3} more`;
    nodes.push(record.more);
  }
  const active = document.activeElement;
  const focusPid = [...record.jobs].find(([, item]) => item.node === active)?.[0];
  const current = [...record.list.children];
  if (nodes.length !== current.length || nodes.some((node, i) => node !== current[i])) {
    record.list.replaceChildren(...nodes);
    if (focusPid !== undefined) next.get(focusPid)?.node.focus();
  }
  record.list.hidden = !heavy.length;
  record.jobs = next;
  record.observed = observed;
}


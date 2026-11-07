import { el } from "../dom.js";
import { sectionHandle, showSection } from "../shell/sections.js";
import { createFixture } from "./forge/fixture.js";
import { ansiSpans, duration, matches, statusOf, terminal, webUrl } from "./forge/presentation.js";

export function openForge(scope) {
  showSection("forge");
  sectionHandle("forge")?.open(scope);
}
export function runsButton(scope, className = "") {
  const button = el("button", className, "Runs");
  button.type = "button";
  button.setAttribute("aria-label", `Runs for ${scope.pull ? `PR #${scope.pull}` : scope.project}`);
  button.addEventListener("click", (event) => { event.stopPropagation(); openForge(scope); });
  return button;
}

export function mountForge(root) {
  if (!document.getElementById("forge-styles")) {
    const link = el("link"); link.id = "forge-styles"; link.rel = "stylesheet";
    link.href = new URL("forge.css", import.meta.url).href; document.head.append(link);
  }
  root.classList.add("forge");
  const header = el("header", "forge-header"), banner = el("div", "forge-notice"), controls = el("div", "forge-controls"), body = el("div", "forge-body");
  root.replaceChildren(header, banner, controls, body);
  let scope = {}, source = null, run = null, job = null, visible = false, timer = null, generation = 0;
  let logText = "", spans = [], query = "", selected = -1, logNodes = [], searchStatus, output, following = true;
  const button = (text, action) => { const b = el("button", "forge-button", text); b.type = "button"; b.onclick = action; return b; };
  function stop() { generation++; clearTimeout(timer); timer = null; }
  function openWeb(url, host) {
    const safe = webUrl(url);
    if (!safe) return;
    controls.append(button(`Open on ${host} ↗`, () => window.open(safe, "_blank", "noopener,noreferrer")));
  }
  function heading() {
    header.replaceChildren(el("h1", "", `${scope.project || "Project"} · CI`), el("span", "forge-meta", [scope.computer, scope.pull && `PR #${scope.pull}`, scope.branch].filter(Boolean).join(" · ")));
    banner.textContent = source ? `Preview · ${source.hostName} sample data. These are not this project's runs.` : "CI runs and job logs need new Phren Hook routes. This computer currently exposes PR checks only.";
  }
  function unavailable() {
    stop(); source = null; run = null; job = null; heading(); controls.replaceChildren();
    const disabled = button("Live CI unavailable", () => {}); disabled.disabled = true;
    disabled.title = "Needs a newer Phren Hook with Forge run and log routes";
    controls.append(disabled);
    openWeb(scope.webUrl, scope.host?.name || "code host");
    body.replaceChildren(el("p", "forge-meta", "Preview the CI interface with sample runs, jobs and logs:"));
    body.append(button("Preview GitHub", () => preview("github")), button("Preview gitboy", () => preview("gitboy")));
  }
  function preview(kind) { stop(); source = createFixture(kind); run = null; job = null; heading(); void list(); }
  function status(raw) { const word = statusOf(raw); return el("span", `forge-status ${word}`, word[0].toUpperCase() + word.slice(1)); }
  function meta(item) { return [item.branch, item.sha?.slice(0, 7), item.actor && `@${item.actor}`, duration(item.startedAt || item.createdAt, item.finishedAt)].filter(Boolean).join(" · "); }
  async function list() {
    stop(); const ticket = generation; run = null; job = null;
    controls.replaceChildren(button("Exit preview", unavailable), button("Refresh", () => void list()));
    body.replaceChildren(el("p", "forge-meta", "Loading runs…"));
    try {
      const page = await source.runs(scope);
      if (ticket !== generation) return;
      body.replaceChildren(el("h2", "", source.hostName === "gitboy" ? "Pipelines" : "Runs"));
      if (!page.items.length) body.append(el("p", "forge-meta", "No runs yet."));
      for (const item of page.items) {
        const row = button("", () => void detail(item)); row.className = "forge-row";
        const main = el("span", "forge-main");
        main.append(el("strong", "", `#${item.number ?? item.id} ${item.title}`), el("span", "forge-meta", meta(item)));
        row.append(status(item.status), main); body.append(row);
      }
    } catch (error) { failure(error, () => void list()); }
  }
  function failure(error, retry) {
    body.append(el("p", "forge-error", error?.message || "Couldn't load CI."), button("Retry", retry));
  }
  async function detail(item) {
    stop(); run = item; job = null; const ticket = generation;
    controls.replaceChildren(button("‹ Runs", () => void list()), button("Refresh", () => void detail(item)));
    openWeb(item.webUrl, source.hostName);
    body.replaceChildren(el("h2", "", item.title));
    try {
      const data = await source.detail(item.id);
      if (ticket !== generation) return;
      body.append(status(data.run.status), el("p", "forge-meta", meta(data.run)));
      if (!data.jobs.length) body.append(el("p", "forge-meta", "No jobs yet."));
      for (const j of data.jobs) {
        const group = el("section", "forge-job");
        const row = button("", () => void logs(j)); row.className = "forge-row";
        row.append(status(j.status), el("strong", "forge-main", j.name), el("span", "forge-meta", duration(j.startedAt, j.finishedAt)));
        group.append(row);
        for (const step of j.steps || []) { const line = el("div", "forge-step"); line.append(status(step.status), el("span", "", step.name)); group.append(line); }
        if (!j.steps?.length) group.append(el("p", "forge-meta", "No step details reported by this host."));
        body.append(group);
      }
    } catch (error) { if (ticket === generation) failure(error, () => void detail(item)); }
  }
  function paintLog() {
    const hits = matches(logText, query);
    if (selected >= hits.length) selected = hits.length - 1;
    searchStatus.textContent = hits.length ? `${selected + 1} of ${hits.length} matches` : query ? "No matches" : "";
    output.replaceChildren(); logNodes = [];
    let offset = 0, h = 0;
    for (const span of spans) {
      const node = el("span", span.cls); let pos = 0;
      while (pos < span.text.length) {
        while (h < hits.length && hits[h][1] <= offset + pos) h++;
        const hit = hits[h];
        const inside = hit && hit[0] <= offset + pos && hit[1] > offset + pos;
        const end = Math.min(span.text.length, hit ? (inside ? hit[1] : hit[0]) - offset : span.text.length);
        const part = el(inside ? "mark" : "span", inside && h === selected ? "forge-current" : "", span.text.slice(pos, end));
        if (inside && h === selected) logNodes.push(part);
        node.append(part); pos = end;
      }
      output.append(node); offset += span.text.length;
    }
    if (following && !query) output.scrollTop = output.scrollHeight;
  }
  async function logs(j) {
    stop(); job = j; const ticket = generation; const currentSource = source; const currentRun = run;
    logText = ""; spans = []; query = ""; selected = -1; following = true;
    controls.replaceChildren(button("‹ Jobs", () => void detail(currentRun)));
    openWeb(j.webUrl, currentSource.hostName);
    const find = el("input"); find.type = "search"; find.placeholder = "Find in log"; find.setAttribute("aria-label", "Find in log");
    searchStatus = el("span", "forge-meta"); searchStatus.setAttribute("role", "status");
    const move = (delta) => { const count = matches(logText, query).length; if (!count) return; selected = (selected + delta + count) % count; following = false; paintLog(); logNodes[0]?.scrollIntoView({ block: "nearest" }); };
    find.oninput = () => { query = find.value; selected = query ? 0 : -1; paintLog(); };
    find.onkeydown = (event) => { if (event.key === "Enter") { event.preventDefault(); move(event.shiftKey ? -1 : 1); } };
    controls.append(find, button("Previous match", () => move(-1)), button("Next match", () => move(1)), searchStatus, button("Jump to end", () => { following = true; output.scrollTop = output.scrollHeight; }));
    const state = el("p", "forge-meta", "Waiting for logs…"); state.setAttribute("role", "status");
    output = el("pre", "forge-log"); output.tabIndex = 0; output.setAttribute("aria-label", `${j.name} job log`);
    output.onscroll = () => { following = output.scrollHeight - output.clientHeight - output.scrollTop < 60; };
    body.replaceChildren(el("h2", "", j.name), state, output);
    const poll = async () => {
      if (!visible || ticket !== generation) return;
      try {
        const data = await currentSource.log(currentRun.id, j.id);
        if (ticket !== generation) return;
        // Snapshots, bounded like the phone's buffer; iterate code points so no surrogate is split.
        const bytes = new TextEncoder().encode(data.text);
        const trimmed = bytes.length > 512 * 1024;
        let start = Math.max(0, bytes.length - (512 * 1024 - 64));
        while (start && (bytes[start] & 0xc0) === 0x80) start++;
        const text = trimmed ? `… earlier output trimmed\n${new TextDecoder().decode(bytes.subarray(start))}` : data.text;
        spans = ansiSpans(text); logText = spans.map((span) => span.text).join(""); paintLog();
        state.textContent = data.finished ? "Log complete" : currentSource.hostName === "GitHub" ? "Waiting for GitHub logs · available when the job finishes" : "Live log · checking every 5 seconds";
        if (!data.finished) timer = setTimeout(poll, currentSource.cadence);
      } catch (error) {
        if (ticket !== generation) return;
        state.textContent = error?.message || "Couldn't read the log.";
        controls.append(button("Retry log", () => void logs(j)));
      }
    };
    void poll();
  }
  unavailable();
  return {
    open(next) { scope = next; unavailable(); },
    show() { visible = true; if (job && !terminal(job.status)) void logs(job); },
    hide() { visible = false; stop(); },
    destroy() { stop(); },
  };
}

// Settings › Diagnostics.
import { store } from "../../shell/store.js";
import { api, button, el, heading, noticeLine, post, showNotice, toggleRow } from "./ui.js";

// ------------------------------------------------------------ page: Diagnostics
function formatSize(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${unit === 0 ? value : value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  return minutes ? `${minutes}:${String(total % 60).padStart(2, "0")}` : `${total}s`;
}

function formatWhen(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export function buildDiagnostics(page) {
  const [head, count] = heading("Diagnostics");
  const intro = el("div", "settings-note", "Records every Hook request and reply, with secrets removed, so a bug can be replayed as a test.");
  const toolbar = el("div", "settings-toolbar");
  const recordBtn = button("Start recording", "accent");
  const state = el("div", "settings-inline-note", "");
  toolbar.append(el("div", "settings-note", "Computers to record"), recordBtn);
  const computers = el("div", "settings-list");
  const notice = noticeLine();
  const list = el("div", "settings-list");
  page.append(head, intro, toolbar, computers, state, notice, list);

  const deselected = new Set();
  let recording = false;
  let ticker = null;

  const names = () => (store.merged?.computers ?? []).map((c) => c.computer);
  const selected = () => names().filter((name) => !deselected.has(name));

  function updateRecordButton() {
    if (recording) {
      recordBtn.textContent = "Stop recording";
      recordBtn.className = "settings-btn danger";
      recordBtn.disabled = false;
    } else {
      recordBtn.textContent = "Start recording";
      recordBtn.className = "settings-btn accent";
      recordBtn.disabled = selected().length === 0;
    }
  }

  function renderComputers() {
    const all = names();
    if (!all.length) {
      computers.replaceChildren(el("div", "settings-empty", "No computers yet."));
      return;
    }
    computers.replaceChildren(...all.map((name) => toggleRow(name, !deselected.has(name), (on) => {
      if (on) deselected.delete(name); else deselected.add(name);
      updateRecordButton();
    })));
    updateRecordButton();
  }

  function setState(status) {
    state.textContent = status && status.recording
      ? `${formatElapsed(status.elapsedMs)} · ${formatSize(status.bytes)}`
      : "";
  }

  function renderTraces(traces) {
    count.textContent = traces.length ? String(traces.length) : "";
    if (!traces.length) {
      list.replaceChildren(el("div", "settings-empty", "No recordings yet."));
      return;
    }
    list.replaceChildren(...traces.map((trace) => {
      const row = el("div", "settings-row");
      const main = el("div", "settings-row-main");
      main.append(el("div", "settings-row-title", trace.name));
      const meta = el("div", "settings-row-meta");
      meta.append(el("span", null, formatSize(trace.size)));
      meta.append(el("span", null, formatWhen(trace.modifiedAt)));
      meta.append(el("span", "settings-config-path", trace.file));
      main.append(meta);
      const copy = button("Copy");
      copy.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(trace.file); showNotice(notice, "Path copied.", false); }
        catch { showNotice(notice, trace.file, false); }
      });
      const actions = el("div", "settings-actions");
      actions.append(copy);
      row.append(main, actions);
      return row;
    }));
  }

  function startTicker() {
    ticker = setInterval(async () => {
      try { setState((await api("/api/trace")).status); }
      catch { /* a dropped poll retries on the next tick */ }
    }, 1000);
  }

  async function refresh() {
    renderComputers();
    try {
      const data = await api("/api/trace");
      recording = !!data.status?.recording;
      setState(data.status);
      renderTraces(data.traces ?? []);
      if (recording && !ticker) startTicker();
      if (!recording && ticker) { clearInterval(ticker); ticker = null; }
      updateRecordButton();
    } catch (err) {
      list.replaceChildren(el("div", "settings-error", err.message));
    }
  }

  recordBtn.addEventListener("click", async () => {
    recordBtn.disabled = true;
    try {
      if (!recording) {
        const started = await post("/api/trace/start", { computers: selected() });
        showNotice(notice, `Recording to ${started.file}`, false);
      } else {
        const stopped = await post("/api/trace/stop", {});
        showNotice(notice, `Saved ${stopped.file}`, false);
      }
    } catch (err) {
      showNotice(notice, err.message, true);
    }
    await refresh();
  });

  refresh();
  return refresh;
}

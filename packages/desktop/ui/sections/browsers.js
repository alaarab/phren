import { el } from "../dom.js";
import { hookGet } from "../api.js";
import { store } from "../shell/store.js";
import { createTabs } from "../shell/tabs.js";
import { registerCommand } from "../shell/palette.js";
import { showSection } from "../shell/sections.js";
import { mountLive } from "../browsers/live.js";
import { mountReplay } from "../browsers/replay.js";
import { duration } from "../browsers/logic.js";

registerCommand({ id: "browsers", title: "Browsers", run: () => showSection("browsers") });

export function mountBrowsers(root) {
  if (!document.querySelector("link[data-browsers-css]")) {
    const css = el("link"); css.rel = "stylesheet"; css.href = "./browsers/browsers.css"; css.dataset.browsersCss = "1"; document.head.append(css);
  }
  const header = el("div", "br-header"), heading = el("h1", "", "Browsers"), refresh = el("button", "br-button", "Refresh");
  header.append(heading, refresh);
  const layout = el("div", "br-layout"), rail = el("div", "br-rail"), stage = el("div", "br-stage");
  const bar = el("div", "doc-bar"), body = el("div", "doc-body br-docs"), empty = el("div", "br-empty", "Open a live browser to watch, or a recording to replay.");
  stage.append(bar, empty, body); layout.append(rail, stage); root.append(header, layout);
  const tabs = createTabs(bar, body, { storageKey: null, onActivate() { empty.hidden = true; }, onEmpty() { empty.hidden = false; } });
  let visible = false, timer = null, generation = 0, onlineKey = "", loading = false;
  const rows = new Map();
  const computers = () => (store.merged?.computers ?? []).filter(c => c.state === "online").map(c => c.computer);
  function updateAges(group) {
    for (const age of group.querySelectorAll("[data-started]")) age.textContent = `${duration(Date.now() - Number(age.dataset.started))} ago`;
  }
  function open(computer, item, replay) {
    const id = `${replay ? "replay" : "live"}:${computer}:${item.id}`;
    tabs.open({ id, kind: "browser", computer, replay, title: replay ? "Recording" : item.pages?.filter(p => p.live).at(-1)?.title || "Browser", subtitle: `${computer} · ${item.session || "Agent"}`,
      mount: node => replay ? mountReplay(node, computer, item) : mountLive(node, computer, item) });
  }
  function render() {
    // Keep list nodes (and focused buttons) for unchanged polls.
    const liveKeys = new Set();
    const hosts = computers();
    rail.querySelector(".br-offline")?.remove();
    if (!hosts.length) rail.replaceChildren(el("p", "br-note br-offline", "No computers online."));
    for (const computer of hosts) {
      let group = rail.querySelector(`[data-host="${CSS.escape(computer)}"]`);
      if (!group) { group = el("section", "br-computer"); group.dataset.host = computer; rail.append(group); }
      const entry = rows.get(computer);
      const signature = JSON.stringify(entry);
      liveKeys.add(computer);
      if (entry && group.dataset.signature === signature) { updateAges(group); continue; }
      group.dataset.signature = signature; group.replaceChildren(el("h2", "", computer));
      if (!entry) { group.append(el("p", "br-note", "Loading…")); continue; }
      if (entry.error) { group.append(el("p", "br-note", entry.error)); continue; }
      group.append(el("h3", "", "Live browsers"));
      if (!entry.browsers.length) group.append(el("p", "br-note", "No live browsers."));
      for (const browser of entry.browsers) {
        const page = browser.pages?.filter(p => p.live).at(-1);
        const button = el("button", "br-row");
        const age = el("span", "br-note"); age.dataset.started = String(browser.startedAt);
        button.append(el("strong", "", page?.title || page?.url || "Browser"), el("span", "br-row-url", page?.url || "Waiting for a page"), el("span", "br-note", browser.session || "Agent"), age);
        if (browser.help) button.append(el("span", "br-badge", "Needs you"));
        if (browser.control?.held) button.append(el("span", "br-note", "Being driven"));
        button.onclick = () => open(computer, browser, false); group.append(button);
      }
      updateAges(group);
      group.append(el("h3", "", "Recordings"));
      if (entry.recordingsError) group.append(el("p", "br-note", entry.recordingsError));
      else if (!entry.recordings.length) group.append(el("p", "br-note", "No recordings."));
      for (const recording of entry.recordings) {
        const button = el("button", "br-row");
        button.append(el("strong", "", recording.pages?.at(-1)?.title || recording.session || "Recording"), el("span", "br-note", new Date(recording.startedAt).toLocaleString()), el("span", "br-note", `${duration((recording.endedAt ?? Date.now()) - recording.startedAt)} · ${(recording.navigations ?? recording.pages ?? []).length} navigations${recording.endedAt === null ? " · Recording" : ""}`));
        button.onclick = () => open(computer, recording, true); group.append(button);
      }
    }
    for (const group of rail.querySelectorAll("[data-host]")) if (!liveKeys.has(group.dataset.host)) group.remove();
  }
  async function load() {
    if (!visible || loading) return;
    loading = true; const round = generation;
    try {
      await Promise.all(computers().map(async computer => {
        try {
          const caps = await store.capabilities(computer);
          if (!caps?.browsers) {
            if (round === generation) rows.set(computer, { error: `Needs a newer Phren on ${computer}.` });
            return;
          }
          const [live, recordings] = await Promise.allSettled([hookGet(computer, "/v1/browsers"), hookGet(computer, "/v1/browsers/recordings")]);
          if (round !== generation) return;
          if (live.status === "rejected") throw live.reason;
          rows.set(computer, { browsers: (live.value.browsers ?? []).filter(b => b.live), recordings: recordings.status === "fulfilled" ? recordings.value.recordings ?? [] : [], recordingsError: recordings.status === "rejected" ? recordings.reason.message : null });
        } catch (error) { if (round === generation) rows.set(computer, { error: error.message }); }
      }));
      if (round === generation && visible) render();
    } finally {
      loading = false;
      if (round !== generation && visible) void load();
    }
  }
  refresh.onclick = () => { rows.clear(); render(); void load(); };
  store.subscribe(() => {
    const key = computers().sort().join("\n");
    if (key === onlineKey) return; onlineKey = key;
    // Offline viewers must drop ownership even when their last frame remains mounted.
    for (const doc of tabs.list()) {
      if (!doc.replay) tabs.handle(doc.id)?.setOnline(computers().includes(doc.computer));
    }
    if (visible) { render(); void load(); }
  });
  return {
    show() { visible = true; render(); void load(); clearInterval(timer); timer = setInterval(() => void load(), 15_000); tabs.activeHandle()?.show?.(); },
    hide() { visible = false; generation++; clearInterval(timer); timer = null; tabs.activeHandle()?.hide?.(); },
    closeTab() { tabs.close(); }, nextTab() { tabs.step(1); }, previousTab() { tabs.step(-1); },
  };
}

import { createActiveTasks } from "./home/active-tasks.js";
import { createSavedToday } from "./home/saved-today.js";
import { hookGet, hookPost } from "../api.js";
import { store } from "../shell/store.js";
import { approvals } from "../shell/approvals.js";
import { followUsage } from "../shell/usage-rings.js";
import { loadQuotaState } from "../shell/quota-warn-prefs.js";
import { homeRows } from "./home/rows.js";
import { createNeeds } from "./home/needs-you.js";
import { createRunningLow } from "./home/running-low.js";
import { createWorking } from "./home/working.js";
import { createFinished } from "./home/finished.js";
import { createChecks } from "./home/checks.js";
import { createUpNext } from "./home/up-next.js";
import { createComputers } from "./home/computers.js";
import { createConductor } from "./home/conductor.js";

const RETURN_POLL_MS = 30_000;
// index.html loads home.css before first paint (Home is the first screen); this covers other hosts.
function ensureCss() {
  if (!document.head || document.getElementById("home-css")) return;
  const link = document.createElement("link");
  link.id = "home-css";
  link.rel = "stylesheet";
  link.href = "./sections/home.css";
  document.head.append(link);
}

export function mountHome(root, { openSession, openPulls } = {}) {
  ensureCss();
  const open = typeof openSession === "function" ? openSession : () => {};
  const openPrs = typeof openPulls === "function" ? openPulls : open;
  root.innerHTML = `
    <div class="home">
      <section class="home-block" data-block="conductor">
        <div class="home-list" data-conductor></div>
      </section>
      <section class="home-block" data-block="needs">
        <h2 class="section-label">Needs you <span class="count"></span></h2>
        <p class="home-keys">Up/Down select &middot; <kbd>Enter</kbd> approve &middot; <kbd>P</kbd> allow for this project &middot; <kbd>D</kbd> deny &middot; <kbd>O</kbd> open</p>
        <div class="home-list"></div>
        <details class="home-snoozed" hidden>
          <summary class="home-snoozed-label">Snoozed (0)</summary>
          <div class="home-snoozed-list"></div>
        </details>
      </section>
      <section class="home-block" data-block="finished">
        <h2 class="section-label">Finished <span class="count"></span><span class="home-away-for"></span></h2>
        <button class="home-away-dismiss" type="button" hidden>Dismiss</button>
        <div class="home-list"></div>
      </section>
      <section class="home-block" data-block="low" hidden>
        <h2 class="section-label">Running low <span class="count"></span></h2>
        <div class="home-list"></div>
      </section>
      <section class="home-block" data-block="working">
        <h2 class="section-label">Working <span class="count"></span></h2>
        <div class="home-list"></div>
      </section>
      <section class="home-block" data-block="checks" hidden>
        <h2 class="section-label">Checks <span class="count"></span></h2>
        <div class="home-checks"></div>
      </section>
      <section class="home-block" data-block="upnext" hidden>
        <h2 class="section-label">Up next <span class="count"></span></h2>
        <div class="home-list"></div>
      </section>
      <section class="home-block" data-block="active-tasks" hidden>
        <h2 class="section-label">Active tasks <span class="count"></span></h2>
        <div class="home-list"></div>
      </section>
      <section class="home-block" data-block="saved-today" hidden>
        <h2 class="section-label">Saved today <span class="count"></span></h2>
        <div class="home-list"></div>
      </section>
      <section class="home-block" data-block="computers">
        <h2 class="section-label">Computers <span class="count"></span></h2>
        <div class="home-list"></div>
      </section>
    </div>`;
  const block = (name) => root.querySelector(`[data-block="${name}"]`);

  const state = { merged: null };
  let visible = false;
  let pollTimer = null;
  let stopUsage = null;
  const receipts = new Map();
  const runs = new Map();
  const scheduleLists = new Map();
  const shared = { root, state, open, block, ...homeRows({ state, open, block }) };
  const working = createWorking(shared);
  const needs = createNeeds({ ...shared, isVisible: () => visible });
  const low = createRunningLow(shared);
  const finished = createFinished({ ...shared, openPrs, receipts, runs });
  const checks = createChecks({ block, openPrs });
  const renderUpNext = createUpNext({ block, scheduleLists, state });
  const activeTasks = createActiveTasks({ block, state });
  const savedToday = createSavedToday({ block, state });
  const renderComputers = createComputers(shared);
  const renderConductor = createConductor({ root, state, receipts, open });
  const unsubscribeAway = finished.subscribe();
  const { onKeydown } = needs;

  async function pollReceipts() {
    const online = (state.merged?.computers ?? []).filter((c) => c.state === "online");
    const answers = await Promise.all(online.map(async (c) => {
      try {
        const body = await hookGet(c.computer, "/v1/dispatch");
        const list = Array.isArray(body.dispatches) ? body.dispatches : [];
        return [c.computer, list.map((receipt) => ({ receipt, computer: receipt.computer || c.computer }))];
      } catch {
        return [c.computer, []];
      }
    }));
    receipts.clear();
    for (const [computer, list] of answers) receipts.set(computer, list);
    if (!visible) return;
    // Finished runs of the schedules each computer owns.
    const scheduled = await Promise.all(online.map(async (c) => {
      try {
        const body = await hookPost(c.computer, "/v1/schedules", {});
        const out = [];
        const list = Array.isArray(body.schedules) ? body.schedules : [];
        scheduleLists.set(c.computer, list);
        for (const schedule of list) {
          if (schedule.owned === false) continue;
          for (const run of Array.isArray(schedule.lastRuns) ? schedule.lastRuns : []) {
            if (run.status === "launched" || run.status === "running") continue;
            out.push({ id: `run:${run.id}`, at: String(run.finishedAt ?? run.startedAt ?? ""), run, schedule, computer: c.computer });
          }
        }
        return [c.computer, out];
      } catch {
        scheduleLists.delete(c.computer);
        return [c.computer, []];
      }
    }));
    for (const computer of [...scheduleLists.keys()]) if (!online.some((c) => c.computer === computer)) scheduleLists.delete(computer);
    runs.clear();
    for (const [computer, list] of scheduled) runs.set(computer, list);
    finished.seed(online);
    finished.renderReturns();
    renderUpNext();
    renderConductor();
  }

  function startPolling() {
    if (pollTimer !== null) return;
    polledFor = (state.merged?.computers ?? []).filter((c) => c.state === "online").map((c) => c.computer).sort().join("\n");
    void pollReceipts();
    pollTimer = setInterval(() => { void pollReceipts(); }, RETURN_POLL_MS);
  }

  function stopPolling() {
    if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
  }

  function render() {
    renderConductor();
    needs.render();
    finished.renderAway();
    low.render();
    working.render();
    checks.render();
    finished.renderReturns();
    renderUpNext();
    activeTasks.render();
    savedToday.render();
    renderComputers();
  }

  // Poll when online computers change while visible; show() reads on every visit.
  let polledFor = "";
  const unsubscribe = store.subscribe((value) => {
    state.merged = value;
    render();
    const online = (value?.computers ?? []).filter((c) => c.state === "online").map((c) => c.computer).sort().join("\n");
    if (visible && online && online !== polledFor) { polledFor = online; void pollReceipts(); }
  });
  const unsubscribeApprovals = approvals.subscribe(needs.render);

  return {
    show() {
      if (visible) return;
      visible = true;
      startPolling();
      activeTasks.show();
      savedToday.show();
      checks.follow();
      stopUsage = followUsage(low.update);
      void loadQuotaState().then(() => { low.ready(); if (visible) low.render(); }).catch((error) => console.warn("Home usage preferences:", error));
      document.addEventListener("keydown", onKeydown);
    },
    hide() {
      visible = false;
      stopPolling();
      activeTasks.hide();
      savedToday.hide();
      checks.unfollow();
      stopUsage?.();
      stopUsage = null;
      document.removeEventListener("keydown", onKeydown);
    },
    destroy() {
      visible = false;
      stopPolling();
      activeTasks.hide();
      savedToday.hide();
      checks.unfollow();
      stopUsage?.();
      stopUsage = null;
      working.destroy();
      renderUpNext.destroy();
      unsubscribe();
      unsubscribeAway();
      unsubscribeApprovals();
      document.removeEventListener("keydown", onKeydown);
    },
  };
}

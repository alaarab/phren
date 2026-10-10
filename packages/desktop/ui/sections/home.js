// Home: what needs the owner, what is working, and how every computer is
// doing, across the fleet. Rows open their session in Agents.
// (Milestone 1 adds the conductor card, recent returns and usage here.)
import { store, needsYou, sessions, projectOf } from "../shell/store.js";

export function mountHome(root, { openSession }) {
  root.innerHTML = `
    <div class="home">
      <section class="home-block" data-block="needs">
        <h2 class="section-label">Needs you <span class="count"></span></h2>
        <div class="home-list"></div>
      </section>
      <section class="home-block" data-block="working">
        <h2 class="section-label">Working <span class="count"></span></h2>
        <div class="home-list"></div>
      </section>
      <section class="home-block" data-block="computers">
        <h2 class="section-label">Computers <span class="count"></span></h2>
        <div class="home-list"></div>
      </section>
    </div>`;
  const block = (name) => root.querySelector(`[data-block="${name}"]`);

  function sessionRow({ computer, child }, tone) {
    const row = document.createElement("button");
    row.className = `home-row tone-${tone}`;
    const title = document.createElement("span");
    title.className = "home-row-title";
    title.textContent = child.title || child.label || projectOf(child);
    const meta = document.createElement("span");
    meta.className = "home-row-meta";
    const project = document.createElement("span");
    project.className = "home-project";
    project.textContent = projectOf(child);
    const host = document.createElement("span");
    host.className = "home-host";
    host.textContent = computer;
    meta.append(project, host);
    if (child.approvalPending || child.agentStatus === "blocked") {
      const why = document.createElement("span");
      why.className = "home-why";
      why.textContent = child.approvalPending ? "Approval" : "Blocked";
      meta.append(why);
    }
    row.append(title, meta);
    row.addEventListener("click", () => openSession(computer, child));
    return row;
  }

  function fill(name, rows, empty) {
    const el = block(name);
    el.querySelector(".count").textContent = rows.length ? String(rows.length) : "";
    const list = el.querySelector(".home-list");
    list.replaceChildren(...rows);
    if (!rows.length) {
      const none = document.createElement("div");
      none.className = "home-empty";
      none.textContent = empty;
      list.append(none);
    }
  }

  store.subscribe((merged) => {
    const needs = needsYou(merged);
    const needKeys = new Set(needs.map((r) => r.key));
    const working = sessions(merged).filter((r) => r.child.agentStatus === "working" && !needKeys.has(r.key));
    fill("needs", needs.map((r) => sessionRow(r, "waiting")), "Nothing needs you.");
    fill("working", working.map((r) => sessionRow(r, "working")), "No agent is working.");
    fill("computers", (merged.computers ?? []).map((c) => {
      const row = document.createElement("div");
      row.className = `home-row home-computer state-${c.state}`;
      const name = document.createElement("span");
      name.className = "home-row-title";
      name.textContent = c.computer;
      const state = document.createElement("span");
      state.className = "home-row-meta";
      state.textContent = c.state === "online" ? "Online" : c.error ? `${c.state}: ${c.error}` : c.state;
      row.append(name, state);
      return row;
    }), "No computers linked.");
  });

  return {};
}

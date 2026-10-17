// The Projects section's sheets: connect a git host, add a project, edit knobs.
import { el } from "../../dom.js";
import { hookGet, hookPost } from "../../api.js";
import { connectProjectHost, hostTokenError, tokenDestinationText } from "../../project-host-token.js";
import { tokenPage } from "../../git-review.js";
import { KNOBS, age, applyKnobs, autoFocus, clear, encodeBase64, parseKnobs } from "./data.js";

export function createDialogs(ctx) {
  const { state, sheets, onlineComputers, loadComputer } = ctx;
  const { openSheet, closeSheet, field, selectEl, noticeBox, setNotice, current } = sheets;
  const loadForge = (options) => ctx.loadForge(options);
  const renderDetail = () => ctx.renderDetail();

  function openHostConnect(detail, displayedHost) {
    const host = { ...displayedHost };
    const { bodyEl, footer } = openSheet(`Connect ${host.name}`);
    const sheet = current();
    const previousFocus = document.activeElement;
    sheet.onClose = () => { input.value = ""; previousFocus?.focus(); };
    const panel = sheet.backdrop.querySelector(".pj-sheet");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", `Connect ${host.name}`);
    bodyEl.append(el("div", "pj-notice", `${tokenDestinationText(host)}. Saved only on ${detail.computer}.`));
    const page = el("button", "pj-btn", "Open token page ↗");
    page.addEventListener("click", () => window.open(tokenPage(host), "_blank", "noopener"));
    bodyEl.append(el("div", "pj-notice", host.kind === "gitlab" ? "Create a personal access token with the api scope." : "Use gitboy's Phren Hook token preset (read:user, read:repo, write:repo)."), page);
    const input = el("input", "pj-input");
    input.type = "password"; input.autocomplete = "off"; input.spellcheck = false;
    bodyEl.append(field("Token", input));
    const notice = noticeBox();
    notice.setAttribute("role", "status");
    bodyEl.append(notice);
    const cancel = el("button", "pj-btn", "Cancel");
    cancel.addEventListener("click", closeSheet);
    const connect = el("button", "pj-btn primary", "Connect");
    connect.disabled = true;
    let busy = false, changed = false;
    input.addEventListener("input", () => { connect.disabled = busy || changed || !input.value.trim(); });
    async function submit() {
      if (busy || changed || !input.value.trim()) return;
      busy = true; connect.disabled = true; connect.textContent = "Checking…";
      setNotice(notice, "", false);
      try {
        await connectProjectHost(detail.computer, detail.name, host, input.value);
        if (current() === sheet) closeSheet();
        if (state.detail === detail) await loadForge({ force: true });
      } catch (error) {
        changed = error?.code === "host-changed";
        setNotice(notice, hostTokenError(error), true);
        if (changed && state.detail === detail) await loadForge({ force: true });
      } finally {
        input.value = ""; busy = false;
        connect.textContent = "Connect"; connect.disabled = true;
      }
    }
    connect.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); void submit(); } });
    // Keep keyboard focus inside the modal while it is open.
    sheet.backdrop.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      const controls = [...sheet.backdrop.querySelectorAll("button:not(:disabled), input")];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    footer.append(cancel, connect);
    input.focus();
  }

  function openAddProject() {
    const hosts = onlineComputers();
    const { bodyEl, footer } = openSheet("Add project", { width: 520 });
    if (!hosts.length) {
      bodyEl.append(el("div", "pj-empty", "No computer is online. Phren adds a project from a computer running Phren Hook."));
      return;
    }
    const computer = selectEl(hosts.map((c) => [c.computer, c.computer]));
    const pathInput = document.createElement("input");
    pathInput.type = "text";
    pathInput.className = "pj-input mono";
    pathInput.placeholder = "/path/to/repository";
    bodyEl.append(field("Computer", computer), field("Repository folder", pathInput));

    const candidates = el("div", "pj-list");
    const repos = el("div", "pj-list");
    bodyEl.append(el("div", "pj-subhead", "Locate"), candidates, el("div", "pj-subhead", "Repositories on this computer"), repos);
    const notice = noticeBox();
    bodyEl.append(notice);

    async function loadRepos() {
      clear(repos);
      try {
        const found = await hookGet(computer.value, "/v1/projects/repos");
        const list = (found.repos ?? []).filter((repo) => !repo.registered);
        if (!list.length) { repos.append(el("div", "pj-empty slim", "Every repository here is already in phren.")); return; }
        for (const repo of list.slice(0, 40)) {
          const row = el("button", "pj-row");
          const main = el("div", "pj-row-main");
          main.append(el("span", "pj-row-title", repo.name));
          main.append(el("span", "pj-row-sub mono", repo.directory));
          row.append(main);
          row.addEventListener("click", () => { pathInput.value = repo.directory; setNotice(notice, ""); });
          repos.append(row);
        }
      } catch (err) {
        repos.append(el("div", "pj-error", err?.message ?? String(err)));
      }
    }

    const locate = footer.appendChild(el("button", "pj-btn", "Locate"));
    locate.addEventListener("click", async () => {
      const raw = pathInput.value.trim().replace(/\/+$/, "");
      const name = raw.split(/[\\/]/).filter(Boolean).pop() ?? "";
      if (!name) { setNotice(notice, "Enter a folder or project name to locate.", true); return; }
      locate.disabled = true;
      clear(candidates);
      try {
        const found = await hookGet(computer.value, "/v1/projects/locate", { project: name });
        const list = found.candidates ?? [];
        if (!list.length) { candidates.append(el("div", "pj-empty slim", `Nothing on ${computer.value} matches ${name}.`)); return; }
        for (const candidate of list) {
          const row = el("button", "pj-row");
          const main = el("div", "pj-row-main");
          main.append(el("span", "pj-row-title mono", candidate.directory));
          main.append(el("span", "pj-row-sub", `${candidate.source}${candidate.lastSeen ? ` \u00b7 ${age(candidate.lastSeen)}` : ""}`));
          row.append(main);
          row.addEventListener("click", () => { pathInput.value = candidate.directory; setNotice(notice, ""); });
          candidates.append(row);
        }
      } catch (err) {
        candidates.append(el("div", "pj-error", err?.message ?? String(err)));
      } finally {
        locate.disabled = false;
      }
    });

    const add = el("button", "pj-btn accent", "Add to phren");
    add.addEventListener("click", async () => {
      const directory = pathInput.value.trim();
      if (!directory) { setNotice(notice, "Enter or locate a repository folder first.", true); return; }
      add.disabled = true;
      setNotice(notice, `Adding on ${computer.value}\u2026`);
      try {
        const result = await hookPost(computer.value, "/v1/projects/add", { directory });
        const where = result.store === "pushed" ? "and synced its store" : result.store === "committed" ? "and committed its store" : "";
        setNotice(notice, `Added ${result.project} on ${computer.value}${where ? ` ${where}` : ""}.`);
        await loadComputer(computer.value, { force: true });
        state.computer = computer.value;
        setTimeout(closeSheet, 900);
      } catch (err) {
        setNotice(notice, err?.message ?? String(err), true);
        add.disabled = false;
      }
    });
    footer.append(add);
    computer.addEventListener("change", loadRepos);
    void loadRepos();
    autoFocus(pathInput);
  }

  async function openKnobs(detail) {
    const entry = state.data.get(detail.computer);
    const project = entry?.projects.get(detail.name);
    if (!project) return;
    const { bodyEl, footer } = openSheet(`Knobs for ${detail.name}`, { width: 460 });
    bodyEl.append(el("div", "pj-subhead", "Per-project overrides. Inherit global removes the key."));
    const selects = new Map();
    for (const [key, def] of Object.entries(KNOBS)) {
      const options = [["", "Inherit global"], ...def.options.map((value) => [value, value])];
      const select = selectEl(options, project.knobs?.[key] ?? "");
      selects.set(key, select);
      const wrap = field(def.label, select);
      wrap.title = def.caption;
      bodyEl.append(wrap);
    }
    const notice = noticeBox();
    bodyEl.append(notice);
    const save = el("button", "pj-btn accent", "Save");
    footer.append(save);
    save.addEventListener("click", async () => {
      const values = {};
      for (const [key, select] of selects) values[key] = select.value;
      const yaml = applyKnobs(project.knobYaml ?? "", values);
      save.disabled = true;
      setNotice(notice, "Saving\u2026");
      try {
        const result = await hookPost(detail.computer, "/v1/store/file", {
          path: `${detail.name}/phren.project.yaml`,
          content: encodeBase64(yaml),
          sha: project.knobSha ?? null,
        });
        project.knobYaml = yaml;
        project.knobSha = result.content?.sha ?? project.knobSha;
        project.knobs = parseKnobs(yaml);
        setNotice(notice, "Saved.");
        setTimeout(() => { closeSheet(); renderDetail(); }, 500);
      } catch (err) {
        setNotice(notice, err?.status === 409 ? "The file changed on the computer. Close and reopen knobs." : (err?.message ?? String(err)), true);
        save.disabled = false;
      }
    });
  }

  return { openHostConnect, openAddProject, openKnobs };
}

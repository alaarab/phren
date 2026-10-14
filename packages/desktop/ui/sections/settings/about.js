// Settings › About: versions and a small report copied from the shared overview.
import { store } from "../../shell/store.js";
import { button, el, heading } from "./ui.js";

function desktopLine(version) {
  return `Phren desktop ${version ?? "(browser)"}`;
}

function computerLine(c) {
  return `${c.computer} · ${c.state} · Hook ${c.overview?.phren?.version ?? "—"}`;
}

/**
 * The copied report. A bug report may be posted publicly, so computers are
 * numbered instead of named (a name can be an SSH host); state and Hook
 * version are what the report needs.
 */
export function aboutText({ version, platform, userAgent, computers = [] }) {
  return [desktopLine(version), `Platform: ${platform}`, `User agent: ${userAgent}`,
    ...computers.map((c, i) => computerLine({ ...c, computer: `Computer ${i + 1}` }))].join("\n");
}

export function buildAbout(page) {
  const [head] = heading("About");
  const intro = el("div", "settings-note", "Desktop and computer versions for a bug report.");
  const list = el("div", "settings-list");
  const toolbar = el("div", "settings-toolbar");
  const copy = button("Copy for a bug report");
  const note = el("div", "settings-inline-note");
  note.setAttribute("role", "status");
  toolbar.append(copy, note);
  page.append(head, intro, list, toolbar);

  const version = window.phrenDesktop?.version;
  let copiedTimer = null;
  function render() {
    const lines = [desktopLine(version), ...(store.merged?.computers ?? []).map(computerLine)];
    list.replaceChildren(...lines.map((line) => {
      const row = el("div", "settings-row");
      row.append(el("div", "settings-row-main", line));
      return row;
    }));
  }

  copy.addEventListener("click", async () => {
    copy.disabled = true;
    clearTimeout(copiedTimer);
    note.textContent = "";
    try {
      await navigator.clipboard.writeText(aboutText({
        version,
        platform: window.phrenDesktop?.platform ?? navigator.platform,
        userAgent: navigator.userAgent,
        computers: store.merged?.computers ?? [],
      }));
      note.textContent = "Copied";
      copiedTimer = setTimeout(() => { note.textContent = ""; }, 2000);
    } catch {
      note.textContent = "Could not copy. Try again.";
    } finally {
      copy.disabled = false;
    }
  });

  render();
  // Settings hides an ancestor, not this page, when another section opens.
  store.subscribe(() => { if (page.isConnected && !page.closest("[hidden]")) render(); });
  return render;
}

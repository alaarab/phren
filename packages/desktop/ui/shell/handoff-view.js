import { store } from "./store.js";
import { sectionHandle, showSection } from "./sections.js";
import { handoffNotices, handoffRow, sameChatTarget } from "./handoff.js";

export function openHandoffChat(computer, target) {
  const row = store.sessions({ includeOffline: true }).find((row) => row.computer === computer && sameChatTarget(row.child.target, target));
  if (!row) return false;
  showSection("agents");
  sectionHandle("agents")?.openSession(computer, row.child);
  return true;
}

export function renderHandoffLinks(container, computer, child) {
  const rows = store.sessions({ includeOffline: true }).filter((row) => row.computer === computer);
  container.replaceChildren();
  for (const notice of handoffNotices(child, rows)) {
    const link = document.createElement(notice.target ? "button" : "span");
    link.className = "handoff-link";
    link.textContent = notice.text;
    if (notice.target) {
      link.type = "button";
      link.addEventListener("click", (event) => { event.stopPropagation(); openHandoffChat(computer, notice.target); });
    }
    container.append(link);
  }
}

export function renderHandoffRow(container, computer, decoration) {
  container.replaceChildren();
  for (const tag of decoration.tags) {
    const link = document.createElement(tag.target ? "button" : "span");
    link.className = "handoff-link handoff-tag";
    link.textContent = tag.text;
    if (tag.target) {
      link.type = "button";
      link.addEventListener("click", (event) => { event.stopPropagation(); openHandoffChat(computer, tag.target); });
    }
    container.append(link);
  }
}

// Home keeps the chat button and hand-off buttons as siblings.
export function decorateHomeHandoff(button, computer, child, rows) {
  const decoration = handoffRow(child, rows.filter((row) => row.computer === computer));
  if (!decoration.tags.length) return button;
  const wrap = document.createElement("div");
  wrap.className = "home-handoff-row" + (decoration.dimmed ? " handed-off" : "");
  if (decoration.subtitle) {
    const main = button.querySelector(".home-row-main");
    for (const sub of main.querySelectorAll(".home-row-sub")) sub.remove();
    const sub = document.createElement("span");
    sub.className = "home-row-sub";
    sub.textContent = decoration.subtitle;
    main.append(sub);
  }
  const tags = document.createElement("span");
  tags.className = "sb-handoffs";
  renderHandoffRow(tags, computer, decoration);
  wrap.append(button, tags);
  return wrap;
}

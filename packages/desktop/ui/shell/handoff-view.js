import { store } from "./store.js";
import { sectionHandle, showSection } from "./sections.js";
import { handoffNotices, sameChatTarget } from "./handoff.js";

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

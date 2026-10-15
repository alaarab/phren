import { el } from "../dom.js";

export function renderComputerCount(container, computers) {
  const online = computers.filter((c) => c.state === "online").length;
  const visibleLabel = el("span", "status-long", " computers");
  visibleLabel.setAttribute("aria-hidden", "true");
  container.replaceChildren(
    el("span", "", `${online}/${computers.length}`),
    visibleLabel,
    el("span", "sr-only", " computers online"),
  );
  container.title = computers.map((c) => `${c.computer}: ${c.state}`).join("\n");
}

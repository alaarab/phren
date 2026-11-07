import { waitTimeLabel } from "./send-behavior.js";
// One clock for Home and sidebar labels. It changes text only, preserving focus
// and reply drafts; removed rows are never retained by the clock.
let clock;
export function waitBadge(element, statusSince) {
  const label = waitTimeLabel(statusSince, true);
  if (!label) return null;
  element.dataset.waitSince = statusSince;
  element.textContent = label;
  if (!clock) clock = setInterval(() => {
    for (const badge of document.querySelectorAll("[data-wait-since]")) {
      badge.textContent = waitTimeLabel(badge.dataset.waitSince, true) || "";
    }
  }, 60_000);
  return element;
}

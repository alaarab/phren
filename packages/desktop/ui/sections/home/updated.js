import { age } from "../../time.js";

/** "Updated 12s ago" for a time of last load; "Updated just now" under ten seconds; "" before there is one. */
export function updatedLabel(at, now = Date.now()) {
  const when = age(at, " ago", now);
  if (!when) return "";
  return `Updated ${when === "now" ? "just now" : when}`;
}

/** How often the label is redrawn: under the ten seconds `age` counts in. */
export const UPDATED_TICK_MS = 5000;

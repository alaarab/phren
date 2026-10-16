import { el } from "./dom.js";
import { shortDate } from "./time.js";

/** The parsed citation meta, from citationData or the whole raw comment payload. */
export function citationData(item) {
  if (item?.citationData && typeof item.citationData === "object") return item.citationData;
  const match = String(item?.citation ?? item?.text ?? "").match(/<!--\s*phren:cite\s+([\s\S]*?)-->/);
  if (!match) return null;
  try { return JSON.parse(match[1].trim()); } catch { return null; }
}

/** Only a confirmed change needs a freshness warning. Dates stay in UTC. */
export function freshnessNote(item) {
  if (item?.citationFreshness?.state !== "changed") return null;
  const citation = citationData(item);
  const file = typeof citation?.file === "string" && citation.file.trim() ? citation.file : "Cited file";
  const commit = item.citationFreshness.lastCommit;
  const when = typeof commit?.authoredAt === "string" ? shortDate(commit.authoredAt) : "";
  const detail = typeof commit?.sha === "string" && /^[0-9a-f]{7,64}$/i.test(commit.sha)
    && typeof commit.summary === "string" && commit.summary && when
    ? `${file} changed in ${commit.sha.slice(0, 7)} “${commit.summary}” (${when})`
    : `${file} changed since this was written`;
  return { label: "May be out of date", detail };
}

/** Reuse each surface's chip classes and keep tooltip text out of HTML. */
export function freshnessChip(item, className) {
  const note = freshnessNote(item);
  if (!note) return null;
  const chip = el("span", className, note.label);
  chip.title = note.detail;
  return chip;
}

/** True when the Hook reported the finding's cited file changed since it was written. */
export const isStale = (item) => freshnessNote(item) !== null;

/** How many of `items` may be out of date; 0 means the filter has nothing to show. */
export const staleCount = (items) => (items ?? []).filter(isStale).length;

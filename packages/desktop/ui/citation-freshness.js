import { el } from "./dom.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Only a confirmed change needs a freshness warning. Dates stay in UTC. */
export function freshnessNote(item) {
  if (item?.citationFreshness?.state !== "changed") return null;
  let citation = item.citationData;
  if (!citation) {
    const match = String(item.citation ?? item.text ?? "").match(/phren:cite\s+(\{[\s\S]*?\})/);
    try { citation = match ? JSON.parse(match[1]) : null; } catch { citation = null; }
  }
  const file = citation?.file || "Cited file";
  const commit = item.citationFreshness.lastCommit;
  const date = String(commit?.authoredAt ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  const when = date ? `${MONTHS[Number(date[2]) - 1]} ${Number(date[3])}` : "";
  const detail = commit?.sha && commit.summary && when
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

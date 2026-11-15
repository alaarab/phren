import { hostname } from "node:os";
import { hookRequest } from "../client.js";
import type { Json } from "../protocol.js";
import type { SectionView } from "./inventory-view.js";
import type { HousekeepingView } from "./report.js";

/**
 * `phren housekeeping`: the newest housekeeping view from this computer's
 * Hook and every linked computer. `--dry-run` runs a pass here, in this
 * process, without the Hook: it stores nothing and acts on nothing.
 */

const GB = 1024 ** 3;
const size = (bytes: number) => bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;

export function formatView(name: string, view: HousekeepingView | undefined): string {
  if (!view) return `${name}\n  No housekeeping report.`;
  const h = view.health;
  const lines = [`${name}  ${view.generatedAt}  load ${h.load1.toFixed(1)}/${h.cores} cores, ${size(h.diskFreeBytes)} free, memory ${h.memoryPressure}`];
  for (const w of view.warnings) lines.push(`  ${w.severity.padEnd(4)} ${w.title}  (${w.area}, ${w.id})${w.notify ? "  notify" : ""}`, `       ${w.detail}`);
  for (const s of view.suggestions) lines.push(`  suggest ${s.actionLabel}: ${s.title}${s.sizeBytes !== undefined ? ` (${size(s.sizeBytes)})` : ""}  ${s.id}`, `       ${s.reason}`);
  for (const k of view.kept) lines.push(`  kept ${k.title}: ${k.reason}`);
  const freed = view.cleaned.reduce((sum, c) => sum + c.freedBytes, 0);
  if (view.cleaned.length) lines.push(`  cleaned ${view.cleaned.length} item(s) in 14 days, ${size(freed)} freed`);
  if (lines.length === 1) lines.push("  Nothing to do.");
  for (const error of view.errors ?? []) lines.push(`  check ${error.check} failed: ${error.message}`);
  return lines.join("\n");
}

/** The inventory sections, one line per row with its approve id. */
export function formatSections(sections: SectionView[]): string {
  const lines: string[] = [];
  const mark = (row: { action?: { label: string }; kept?: string }) => row.action ? `  [${row.action.label}]` : `  [kept: ${row.kept}]`;
  for (const view of sections) {
    lines.push(`  ${view.section} (${view.rows.length}, measured ${view.measuredAt}${view.partial ? ", measuring" : ""})`);
    for (const row of view.rows.slice(0, view.section === "space" ? 20 : 200)) {
      const sized = row.sizeBytes !== undefined ? ` ${size(row.sizeBytes)}` : "";
      const extra = "idleSeconds" in row ? ` ${row.state}, idle ${Math.round(row.idleSeconds / 60)}m` : "branch" in row && row.branch ? ` [${row.branch}]` : "";
      lines.push(`    ${row.title}${extra}${sized}${mark(row)}  ${row.id}`);
    }
  }
  return lines.join("\n");
}

const flag = (args: string[], name: string) => args.includes(name);

export async function runHousekeeping(args: string[]): Promise<number> {
  const json = flag(args, "--json");
  if (flag(args, "--dry-run")) {
    const { Housekeeper } = await import("./housekeeper.js");
    const { ResourceMonitor } = await import("../resources.js");
    const { liveProcessCwds } = await import("./safety.js");
    const resources = new ResourceMonitor();
    // Panes are the Hook's to list; a dry run without it sees processes only.
    const report = await new Housekeeper({ computer: hostname(), resources: () => resources.read(), processes: () => liveProcessCwds(), panes: async () => [] })
      .run("manual", false);
    const { viewOf } = await import("./report.js");
    const view = viewOf(report, { cleaned: [], dismissed: new Map() });
    console.log(json ? JSON.stringify(view, null, 2) : formatView(hostname(), view));
    return 0;
  }
  const apply = args.includes("--apply") ? args[args.indexOf("--apply") + 1] : undefined;
  if (args.includes("--apply") || flag(args, "--scan")) {
    if (args.includes("--apply") && (!apply || apply.startsWith("-"))) { console.error("--apply takes comma-separated action ids."); return 1; }
    try {
      const result = flag(args, "--scan") ? await hookRequest("/v1/housekeeping/scan", {}, undefined, 30_000)
        : await hookRequest("/v1/housekeeping/approve", { ids: apply!.split(",").filter(Boolean), by: "cli" }, undefined, 90_000);
      if (json || flag(args, "--scan")) { console.log(flag(args, "--scan") ? "Scan started; `phren housekeeping` shows it when it lands." : JSON.stringify(result, null, 2)); return 0; }
      for (const row of Array.isArray(result.results) ? result.results as Json[] : [])
        console.log(`${row.id}  ${row.status}${row.reason ? `: ${row.reason}` : ""}${typeof row.freedBytes === "number" && row.freedBytes ? ` (${size(row.freedBytes)} freed)` : ""}`);
      return 0;
    } catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 1; }
  }
  let answer: Json;
  try { answer = await hookRequest(`/v1/housekeeping${flag(args, "--local") ? "" : "?peers=1"}`, undefined, undefined, 30_000); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    const message = code === "ENOENT" || code === "ECONNREFUSED" ? "Phren Hook is not running on this computer (phren bridge status). `phren housekeeping --dry-run` runs a pass without it."
      : (error as { status?: unknown })?.status === 404 ? "This computer's Phren Hook predates housekeeping; update it with phren bridge update."
      : error instanceof Error ? error.message : "Phren Hook did not answer.";
    console.error(message);
    return 1;
  }
  if (json) { console.log(JSON.stringify(answer, null, 2)); return 0; }
  const name = (value: unknown, fallback: string) => typeof (value as { name?: unknown })?.name === "string" ? String((value as { name: string }).name) : fallback;
  const sections: SectionView[] = [];
  for (const section of ["worktrees", "space", "sessions"]) {
    const view = await hookRequest(`/v1/housekeeping/inventory?section=${section}`, undefined, undefined, 30_000).catch(() => undefined);
    if (view) sections.push(view as unknown as SectionView);
  }
  const blocks = [formatView(name(answer.computer, hostname()), answer as unknown as HousekeepingView)
    + (sections.length ? `\n${formatSections(sections)}` : "\n  Inventory: the first scan is still running.")];
  for (const peer of Array.isArray(answer.peers) ? answer.peers as Json[] : []) {
    const peerName = name(peer.computer, String(peer.name ?? "peer"));
    blocks.push(typeof peer.error === "string" ? `${peerName}\n  unavailable: ${peer.error}` : formatView(peerName, peer as unknown as HousekeepingView));
  }
  console.log(blocks.join("\n\n"));
  return 0;
}

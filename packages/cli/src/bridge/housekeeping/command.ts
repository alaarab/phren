import { hostname } from "node:os";
import { hookRequest, ownerHookRequest } from "../client.js";
import type { Json } from "../protocol.js";
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

/** The inventory, one line per row with its approve id. */
export function formatInventory(inv: NonNullable<HousekeepingView["inventory"]>): string {
  const mark = (a?: { label: string; allowed: boolean; reason?: string }) => !a ? "" : a.allowed ? `  [${a.label}]` : `  [kept: ${a.reason}]`;
  const lines = [`  inventory ${inv.collectedAt}${inv.scanning ? " (measuring)" : ""}${inv.stale ? " (stale)" : ""}`];
  for (const w of inv.worktrees) lines.push(`    ${w.path}${w.branch ? ` [${w.branch}]` : ""}${w.sizeBytes !== undefined ? ` ${size(w.sizeBytes)}` : ""}${mark(w.action)}  ${w.action.id}`);
  for (const r of inv.space.slice(0, 20)) lines.push(`    ${size(r.sizeBytes).padStart(9)} ${r.title}${mark(r.action)}${r.action ? `  ${r.action.id}` : r.note ? `  (${r.note})` : ""}`);
  for (const p of inv.processes ?? []) lines.push(`    ${size(p.memoryBytes + (p.swapBytes ?? 0)).padStart(9)} ${p.name} pid ${p.pid}${p.processes > 1 ? ` (${p.processes} processes)` : ""} cpu ${p.cpuPercent}%${mark(p.action)}  ${p.action.id}`);
  for (const p of inv.sessions) lines.push(`    pane ${p.pane.label ?? p.pane.target.pane} ${p.agent ?? ""} ${p.status ?? ""}${p.idleSeconds !== undefined ? ` idle ${Math.round(p.idleSeconds / 60)}m` : ""}${mark(p.action)}  ${p.action.id}`);
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
      const result = flag(args, "--scan") ? await ownerHookRequest("/v1/housekeeping/scan", {})
        : await ownerHookRequest("/v1/housekeeping/approve", { ids: apply!.split(",").filter(Boolean), by: "cli" });
      if (json || flag(args, "--scan")) { console.log(flag(args, "--scan") ? "Scan started; `phren housekeeping` shows it when it lands." : JSON.stringify(result, null, 2)); return 0; }
      for (const row of Array.isArray(result.results) ? result.results as Json[] : [])
        console.log(`${row.id}  ${row.status}${row.reason ? `: ${row.reason}` : ""}${typeof row.freedBytes === "number" && row.freedBytes ? ` (${size(row.freedBytes)} freed)` : ""}`);
      return 0;
    } catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 1; }
  }
  let answer: Json;
  try { answer = await hookRequest(`/v1/housekeeping?inventory=1${flag(args, "--local") ? "" : "&peers=1"}`, undefined, undefined, 30_000); }
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
  const local = answer as unknown as HousekeepingView;
  const blocks = [formatView(name(answer.computer, hostname()), local)
    + (local.inventory ? `\n${formatInventory(local.inventory)}` : "\n  Inventory: the first scan is still running.")];
  for (const peer of Array.isArray(answer.peers) ? answer.peers as Json[] : []) {
    const peerName = name(peer.computer, String(peer.name ?? "peer"));
    blocks.push(typeof peer.error === "string" ? `${peerName}\n  unavailable: ${peer.error}` : formatView(peerName, peer as unknown as HousekeepingView));
  }
  console.log(blocks.join("\n\n"));
  return 0;
}

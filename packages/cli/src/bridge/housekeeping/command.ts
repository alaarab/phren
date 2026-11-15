import { hostname } from "node:os";
import { hookRequest } from "../client.js";
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
  const blocks = [formatView(name(answer.computer, hostname()), answer as unknown as HousekeepingView)];
  for (const peer of Array.isArray(answer.peers) ? answer.peers as Json[] : []) {
    const peerName = name(peer.computer, String(peer.name ?? "peer"));
    blocks.push(typeof peer.error === "string" ? `${peerName}\n  unavailable: ${peer.error}` : formatView(peerName, peer as unknown as HousekeepingView));
  }
  console.log(blocks.join("\n\n"));
  return 0;
}

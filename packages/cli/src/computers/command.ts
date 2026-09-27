import { combineUsage, describe, findComputer, type HarnessUsage, pickComputer, type PlatformChoice, readComputers, readUsage } from "./read.js";
import type { ComputerResources } from "../bridge/resources.js";

/**
 * `phren computers` and `phren usage`: read-only, answered by the Phren Hook
 * alone. They run without a Phren store (the registry marks them
 * standalone), so someone with no memory, findings or tasks can use them.
 */

const GB = 1024 ** 3;
const flag = (args: string[], name: string) => args.includes(name);
function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at >= 0) return args[at + 1];
  const inline = args.find(arg => arg.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
}

function gauge(value: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, value)) * 5);
  return "▰".repeat(filled) + "▱".repeat(5 - filled);
}

function durationText(seconds: number): string {
  const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600);
  return days ? `${days}d ${hours}h` : `${hours}h ${Math.floor(seconds % 3600 / 60)}m`;
}

export function formatResources(name: string, r: ComputerResources, detail: boolean): string[] {
  const lines = [`${name}  ${gauge(r.pressure.overall)} ${r.level}${r.warnings.length ? ` (${r.warnings.join(", ")})` : ""}`];
  lines.push(`  cpu     load ${r.cpu.load1} / ${r.cpu.load5} / ${r.cpu.load15} on ${r.cpu.cores} cores (${r.cpu.loadPerCore}× per core)`);
  const memory = [r.memory.availablePercent !== undefined ? `${r.memory.availablePercent}% free` : "", r.memory.pressure ? `pressure ${r.memory.pressure}` : "",
    `${(r.memory.totalBytes / GB).toFixed(0)} GB`, r.memory.swapUsedBytes ? `swap ${(r.memory.swapUsedBytes / GB).toFixed(1)} GB` : ""].filter(Boolean);
  lines.push(`  memory  ${memory.join(", ")}`);
  if (r.disk) lines.push(`  disk    ${(r.disk.freeBytes / GB).toFixed(1)} GB free of ${(r.disk.totalBytes / GB).toFixed(0)} GB (home volume)`);
  if (r.battery) lines.push(`  battery ${r.battery.percent}%${r.battery.charging ? ", charging" : ""}${r.battery.onAC ? ", on AC" : ", on battery"}`);
  lines.push(`  uptime  ${durationText(r.uptimeSeconds)}`);
  if (detail || r.heavy.length) {
    const heavy = detail ? r.heavy : r.heavy.slice(0, 4);
    if (heavy.length) lines.push("  heavy");
    for (const job of heavy) {
      const pane = job.pane ? `  ${[job.pane.workspace, job.pane.pane, job.pane.agent].filter(Boolean).join(" · ")}` : "";
      lines.push(`    ${job.name.padEnd(22)} ${String(job.cpuPercent).padStart(6)}% cpu ${(job.memoryBytes / GB).toFixed(1).padStart(5)} GB${job.processes > 1 ? ` ×${job.processes}` : ""}${pane}`);
    }
    if (!detail && r.heavy.length > heavy.length) lines.push(`    … ${r.heavy.length - heavy.length} more (phren computers --resources <name>)`);
  }
  return lines;
}

export function formatHarness(h: HarnessUsage): string[] {
  const lines = [`  ${h.harness}`];
  for (const w of h.windows) {
    const used = w.usedPercent !== undefined ? `${w.usedPercent}% used` : w.usedUSD !== undefined ? `$${w.usedUSD.toFixed(2)}${w.limitUSD !== undefined ? ` of $${w.limitUSD.toFixed(2)}` : ""}` : "";
    lines.push(`    ${w.name.padEnd(30)} ${used.padEnd(18)}${w.resetsIn ? `resets in ${w.resetsIn}` : ""}`);
  }
  if (h.spend) lines.push(`    spend ${h.spend.period.replace(/_/g, " ").padEnd(24)} $${h.spend.amountUSD.toFixed(2)}`);
  if (h.message) lines.push(`    ${h.message}`);
  return lines;
}

export async function runComputers(args: string[]): Promise<number> {
  if (args[0] === "mcp") { await (await import("./mcp.js")).serveComputersMcp(); return 0; }
  const json = flag(args, "--json");
  const pick = flag(args, "--pick") ? (option(args, "--pick") && !option(args, "--pick")!.startsWith("-") ? option(args, "--pick") : "mac") as PlatformChoice : undefined;
  const named = args.find((arg, index) => !arg.startsWith("-") && !["--pick", "--exclude"].includes(args[index - 1] ?? ""));
  const report = await readComputers({ peers: !flag(args, "--local") });
  if (pick) {
    if (!["mac", "linux", "any"].includes(pick)) { console.error("--pick takes mac, linux or any."); return 1; }
    const result = pickComputer(report.computers, pick, (option(args, "--exclude") ?? "").split(",").filter(Boolean));
    if (json) console.log(JSON.stringify({ pick: result.pick?.name ?? null, reason: result.reason, ranked: result.ranked }, null, 2));
    else { console.log(result.reason); for (const item of result.ranked.slice(1)) console.log(`  then ${item.name}: ${item.why}`); }
    return result.pick ? 0 : 1;
  }
  const chosen = named ? findComputer(report.computers, named) : undefined;
  if (named && !chosen) { console.error(`No computer named ${named}. Known: ${report.computers.map(c => c.name).join(", ")}`); return 1; }
  const list = chosen ? [chosen] : report.computers;
  if (json) { console.log(JSON.stringify({ computers: list, ...(report.hookError ? { hookError: report.hookError } : {}), ...(report.peerError ? { peerError: report.peerError } : {}) }, null, 2)); return 0; }
  const detail = Boolean(chosen) || flag(args, "--resources") && list.length === 1;
  if (report.hookError) console.log(`${report.hookError} Showing this computer only.\n`);
  for (const computer of list) {
    if (!computer.resources) { console.log(`${computer.name}  offline: ${computer.error ?? "unavailable"}\n`); continue; }
    if (!flag(args, "--resources") && !chosen) console.log(`${computer.name.padEnd(28)} ${gauge(computer.resources.pressure.overall)} ${computer.resources.level.padEnd(9)} ${describe(computer.resources)}`);
    else console.log(formatResources(computer.name, computer.resources, detail).join("\n") + "\n");
  }
  if (report.peerError) console.log(`\nLinked computers unavailable: ${report.peerError}`);
  return 0;
}

export async function runUsage(args: string[]): Promise<number> {
  if (args[0] === "mcp") { await (await import("./mcp.js")).serveComputersMcp(); return 0; }
  const json = flag(args, "--json");
  const report = await readUsage({ peers: !flag(args, "--local") });
  const named = option(args, "--computer");
  const computers = named ? report.computers.filter(c => c.name.toLowerCase().startsWith(named.toLowerCase())) : report.computers;
  if (named && !computers.length) { console.error(`No computer named ${named}. Known: ${report.computers.map(c => c.name).join(", ")}`); return 1; }
  const combined = named ? combineUsage(computers.flatMap(c => c.harnesses ? [c.harnesses] : [])) : report.combined;
  if (json) { console.log(JSON.stringify({ computers, combined, ...(report.hookError ? { hookError: report.hookError } : {}) }, null, 2)); return report.hookError ? 1 : 0; }
  if (report.hookError) { console.error(report.hookError); return 1; }
  if (!flag(args, "--per-computer")) {
    console.log(`Usage across ${computers.filter(c => c.harnesses).length} computer(s)`);
    for (const h of combined) console.log(formatHarness(h).join("\n"));
    const offline = computers.filter(c => c.error);
    if (offline.length) console.log(`\nNot reporting: ${offline.map(c => `${c.name} (${c.error})`).join("; ")}`);
    return 0;
  }
  for (const computer of computers) {
    console.log(computer.name);
    if (computer.error) { console.log(`  ${computer.error}`); continue; }
    for (const h of computer.harnesses ?? []) console.log(formatHarness(h).join("\n"));
  }
  return 0;
}

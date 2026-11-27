import { readFile } from "node:fs/promises";
import path from "node:path";
import { execProbe as exec } from "../probe-processes.js";
import { redactSecretsForLog } from "../../content/secrets.js";
import type { PaneRef, ProcessRow } from "../resources.js";
import { actionId } from "./inventory.js";
import type { InventoryAction } from "./inventory.js";

/**
 * The programs holding this computer's memory, swap and CPU, so the owner can
 * see the hogs and end one from the phone. Read live on each request (a `ps`
 * and, on Linux, /proc), never from the hourly scan. A program's helpers are
 * one row: Chromium's renderers count toward the browser that started them,
 * and ending the row ends that browser. Ending is the owner's signed approve;
 * the Hook re-reads the process first and refuses the ones the computer or
 * the owner's session needs, other users' processes, Phren Hook itself and the
 * conductor.
 */


export interface InventoryProcess {
  id: string;
  /** The program's name. */
  name: string;
  /** The row's root process: the one ending it signals. */
  pid: number;
  /** Processes counted in the row (the root and its same-program helpers). */
  processes: number;
  cpuPercent: number;
  memoryBytes: number;
  /** Linux only; macOS does not report swap per process. */
  swapBytes?: number;
  startedAt?: string;
  /** The root's command line, shortened. */
  command: string;
  /** The agent pane it runs in, when one started it. */
  pane?: { server: string; pane: string; label?: string; agent?: string };
  action: InventoryAction;
}

export interface ProcessSources {
  rows: () => Promise<ProcessRow[]>;
  owners?: () => Promise<Map<number, PaneRef>>;
  /** Pane keys (`server/pane`) of conductors, which are never ended here. */
  conductors?: () => Promise<Set<string>>;
  platform?: NodeJS.Platform;
  /** This user's uid; the Hook's by default. */
  uid?: number;
  /** pid -> owner uid for the given pids. */
  uids?: (pids: number[]) => Promise<Map<number, number>>;
  /** pid -> exact start (a stable identity); `ps lstart` or /proc starttime. */
  starts?: (pids: number[]) => Promise<Map<number, string>>;
  /** pid -> swapped bytes (Linux). */
  swap?: (pids: number[]) => Promise<Map<number, number>>;
  /** pid -> CPU percent over a short window (Linux; ps pcpu there is a lifetime average). */
  cpu?: (pids: number[]) => Promise<Map<number, number>>;
  selfPid?: number;
  limit?: number;
}

/** Programs the computer or the owner's session needs: ending one logs the owner out, drops the network or Phren itself. */
const PROTECTED = new Set([
  "launchd", "kernel_task", "WindowServer", "loginwindow", "Dock", "Finder", "SystemUIServer", "coreaudiod", "mds", "mds_stores", "opendirectoryd",
  "systemd", "init", "sshd", "sshd-session", "dbus-daemon", "dbus-broker", "Xorg", "Xwayland", "Hyprland", "hyprland", "sway", "gnome-shell", "kwin_wayland",
  "kwin_x11", "plasmashell", "gdm", "sddm", "pipewire", "pipewire-pulse", "wireplumber", "pulseaudio", "NetworkManager", "wpa_supplicant", "tailscaled",
  "tailscale", "herdr", "tmux", "tmux: server", "zellij", "uwsm", "quickshell", "waybar", "mako", "hypridle", "hyprlock",
  // Credential agents: ending one breaks git pushes, signing and SSH until the next login.
  "ssh-agent", "gpg-agent", "gnome-keyring-daemon", "kwalletd5", "kwalletd6", "secretd",
]);

const base = (row: ProcessRow) => path.basename(row.command) || row.command;

/** Same-program helpers grouped under the topmost ancestor running the same program. */
export function processGroups(rows: readonly ProcessRow[]): Map<number, ProcessRow[]> {
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const rootOf = (row: ProcessRow): number => {
    let at = row;
    for (let hops = 0; hops < 64; hops++) {
      const parent = byPid.get(at.ppid);
      if (!parent || parent.pid === at.pid || base(parent) !== base(row)) break;
      at = parent;
    }
    return at.pid;
  };
  const groups = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const root = rootOf(row);
    groups.set(root, [...(groups.get(root) ?? []), row]);
  }
  return groups;
}

/** Why a row may not be ended, in a plain sentence; undefined when it may. */
export function endBlock(root: ProcessRow, context: { uid?: number; ownerUid?: number; selfChain: ReadonlySet<number>; pane?: PaneRef; conductor: boolean; paneProcess: boolean }): string | undefined {
  const name = base(root);
  if (root.pid <= 1) return "The system needs it.";
  if (context.ownerUid === undefined) return "Phren couldn't check who owns it, so it stays.";
  if (context.uid !== undefined && context.ownerUid !== context.uid) return "It belongs to another user.";
  if (context.selfChain.has(root.pid)) return "It runs Phren Hook.";
  if (PROTECTED.has(name)) return `Your computer or session needs ${name}.`;
  if (context.conductor) return "It is the conductor.";
  if (context.paneProcess) return "It is an agent pane's own process; close the pane under Sessions.";
  return undefined;
}

const short = (text: string, max = 200) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** The largest programs by memory and swap, plus anything busy on the CPU, each with its end action. */
export async function listProcesses(sources: ProcessSources): Promise<InventoryProcess[]> {
  const rows = await sources.rows();
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const groups = processGroups(rows);
  const all = [...groups.keys()];
  const platform = sources.platform ?? process.platform;
  const [swap, cpu] = await Promise.all([
    (sources.swap ?? (platform === "linux" ? linuxSwap : async () => new Map<number, number>()))(rows.map(row => row.pid)).catch(() => new Map<number, number>()),
    (sources.cpu ?? (platform === "linux" ? linuxCpu : async () => new Map<number, number>()))(rows.map(row => row.pid)).catch(() => new Map<number, number>()),
  ]);
  const totals = all.map(root => {
    const members = groups.get(root)!;
    const memoryBytes = members.reduce((sum, row) => sum + row.rssKB * 1024, 0);
    const swapBytes = members.reduce((sum, row) => sum + (swap.get(row.pid) ?? 0), 0);
    const cpuPercent = members.reduce((sum, row) => sum + (cpu.get(row.pid) ?? row.cpu), 0);
    return { root, members, memoryBytes, swapBytes, cpuPercent };
  });
  const limit = sources.limit ?? 20;
  const byMemory = [...totals].sort((a, b) => (b.memoryBytes + b.swapBytes) - (a.memoryBytes + a.swapBytes)).slice(0, limit);
  const busy = totals.filter(t => t.cpuPercent >= 50 && !byMemory.includes(t)).sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, 5);
  const picked = [...byMemory, ...busy].filter(t => t.memoryBytes + t.swapBytes >= 50 * 1024 ** 2 || t.cpuPercent >= 50);
  const pids = picked.map(t => t.root);
  const selfChain = new Set<number>();
  for (let at = byPid.get(sources.selfPid ?? process.pid), hops = 0; at && hops < 64; at = byPid.get(at.ppid), hops++) selfChain.add(at.pid);
  // A failed lookup leaves ownership unknown: a partial answer must never look complete.
  let ownersKnown = true, conductorsKnown = true;
  const [uids, starts, owners, conductors] = await Promise.all([
    (sources.uids ?? ownerUids)(pids).catch(() => new Map<number, number>()),
    (sources.starts ?? exactStarts(platform))(pids).catch(() => new Map<number, string>()),
    sources.owners ? sources.owners().catch(() => { ownersKnown = false; return new Map<number, PaneRef>(); }) : Promise.resolve(new Map<number, PaneRef>()),
    sources.conductors ? sources.conductors().catch(() => { conductorsKnown = false; return new Set<string>(); }) : Promise.resolve(new Set<string>()),
  ]);
  const ownershipKnown = ownersKnown && conductorsKnown;
  const uid = sources.uid ?? process.getuid?.();
  const paneOf = (pid: number): PaneRef | undefined => {
    for (let at = byPid.get(pid), hops = 0; at && hops < 64; at = byPid.get(at.ppid), hops++) { const ref = owners.get(at.pid); if (ref) return ref; }
    return undefined;
  };
  return picked.map(({ root, members, memoryBytes, swapBytes, cpuPercent }) => {
    const row = byPid.get(root)!;
    const pane = paneOf(root);
    const conductor = pane ? conductors.has(`${pane.server}/${pane.pane}`) : false;
    const block = ownershipKnown ? endBlock(row, { uid, ownerUid: uids.get(root), selfChain, pane, conductor, paneProcess: owners.has(root) })
      : "couldn't verify which panes own this process; try again";
    const start = starts.get(root) ?? "";
    const name = base(row);
    const id = actionId("end-process", `${root}`, [name, start]);
    return {
      id, name, pid: root, processes: members.length, cpuPercent: Math.round(cpuPercent), memoryBytes,
      ...(swapBytes ? { swapBytes } : {}), ...(row.startedAt ? { startedAt: new Date(row.startedAt).toISOString() } : {}),
      // Command lines can carry tokens and passwords (--token=, URLs with credentials); the list goes to phones and linked computers.
      command: short(redactSecretsForLog(row.args || row.command)),
      ...(pane ? { pane: { server: pane.server, pane: pane.pane, ...(pane.label ? { label: pane.label } : {}), ...(pane.agent ? { agent: pane.agent } : {}) } } : {}),
      action: { id, kind: "end-process", label: members.length > 1 ? `End ${name} (${members.length} processes)` : `End ${name}`, allowed: !block,
        ...(block ? { reason: block } : { confirm: `Asks ${name} to quit, then forces it after 5 seconds. Unsaved work in it is lost.` }) },
    };
  });
}

/** Ends the row the owner approved: re-reads it, re-checks the rules, sends TERM, then KILL to whatever of it is left after 5 seconds. */
export async function endProcess(id: string, sources: ProcessSources, wait = (ms: number) => new Promise(done => setTimeout(done, ms))): Promise<{ status: "done"; freedBytes: number } | { status: "refused" | "gone"; reason: string }> {
  const rows = await listProcesses({ ...sources, limit: 200 });
  const row = rows.find(item => item.id === id);
  if (!row) return { status: "gone", reason: "It has already ended or changed." };
  if (!row.action.allowed) return { status: "refused", reason: row.action.reason ?? "Phren won't end it." };
  const members = processGroups(await sources.rows()).get(row.pid)?.map(member => member.pid) ?? [row.pid];
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try { process.kill(row.pid, "SIGTERM"); } catch { return { status: "gone", reason: "It has already ended." }; }
  for (let waited = 0; waited < 5_000 && alive(row.pid); waited += 250) await wait(250);
  for (const pid of members) if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* ended meanwhile */ } }
  return { status: "done", freedBytes: row.memoryBytes };
}

async function ownerUids(pids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!pids.length) return out;
  const { stdout } = await exec("/bin/ps", ["-o", "pid=,uid=", "-p", pids.join(",")], { timeout: 4_000 });
  for (const line of stdout.split("\n")) { const m = /^\s*(\d+)\s+(\d+)/.exec(line); if (m) out.set(Number(m[1]), Number(m[2])); }
  return out;
}

function exactStarts(platform: NodeJS.Platform) {
  return async (pids: number[]): Promise<Map<number, string>> => {
    const out = new Map<number, string>();
    if (platform === "linux") {
      await Promise.all(pids.map(async pid => {
        const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
        // Fields after the command, which may contain spaces: state is field 3, starttime field 22.
        const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (rest[19]) out.set(pid, rest[19]);
      }));
      return out;
    }
    if (!pids.length) return out;
    const { stdout } = await exec("/bin/ps", ["-o", "pid=,lstart=", "-p", pids.join(",")], { timeout: 4_000, env: { ...process.env, LC_ALL: "C" } });
    for (const line of stdout.split("\n")) { const m = /^\s*(\d+)\s+(.+)$/.exec(line); if (m) out.set(Number(m[1]), m[2].trim()); }
    return out;
  };
}

async function linuxSwap(pids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  await Promise.all(pids.map(async pid => {
    const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
    const kb = Number(/^VmSwap:\s+(\d+)\s+kB/m.exec(status)?.[1]);
    if (kb > 0) out.set(pid, kb * 1024);
  }));
  return out;
}

/** CPU over half a second from /proc/<pid>/stat utime+stime (clock ticks; 100 per second on Linux). */
async function linuxCpu(pids: number[]): Promise<Map<number, number>> {
  const ticks = async () => {
    const out = new Map<number, number>();
    await Promise.all(pids.map(async pid => {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const used = Number(rest[11]) + Number(rest[12]);
      if (Number.isFinite(used)) out.set(pid, used);
    }));
    return out;
  };
  const before = await ticks(), started = Date.now();
  await new Promise(done => setTimeout(done, 500));
  const after = await ticks(), seconds = (Date.now() - started) / 1000;
  const out = new Map<number, number>();
  for (const [pid, used] of after) { const prior = before.get(pid); if (prior !== undefined && seconds > 0) out.set(pid, Math.max(0, (used - prior) / 100 / seconds * 100)); }
  return out;
}

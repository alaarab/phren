import { execFile } from "node:child_process";
import { open, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { objects, type Json, type Provider } from "./protocol.js";
import { snapshot } from "./herdr.js";
import { terminalProvider, type PaneProcesses } from "./terminal.js";
import { webServers, type LocalServer } from "./projects.js";
import { transcriptPath } from "./transcripts.js";

/**
 * The web servers one agent session owns, for the chat's ••• menu. Never a
 * machine-wide list: a server belongs to a session only when
 *
 * - "started": its listening process descends from the session's pane (the
 *   pane's shell or foreground processes), from a process running this
 *   conversation by id, or from one holding its transcript open (a Claude
 *   Code background job runs its tools under its own process, not under the
 *   pane's shell); or
 * - "mentioned": its port appears as a loopback address in the session's
 *   transcript and no other pane's process tree owns it. This is how a server
 *   an agent detached (`nohup … &`, reparented to PID 1) is still found.
 *
 * Everything else is left out, including a port another pane owns.
 */

const exec = promisify(execFile);

export interface SessionServer extends LocalServer { source: "started" | "mentioned" }

/** How far a process tree is followed upward before giving up. */
const MAX_DEPTH = 64;
/** The transcript tail scanned for loopback addresses. */
const TRANSCRIPT_TAIL_BYTES = 1_048_576;
/** Other panes checked for ownership of a mentioned port. */
const MAX_OTHER_PANES = 48;

/** `localhost:3000`, `127.0.0.1:5173`, `0.0.0.0:8080`, `[::1]:4000`, with or without a scheme. */
const LOOPBACK_PORT = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})\b/gi;

export function mentionedPorts(text: string): Set<number> {
  const ports = new Set<number>();
  for (const match of text.matchAll(LOOPBACK_PORT)) {
    const port = Number(match[1]);
    if (port > 0 && port <= 65_535) ports.add(port);
  }
  return ports;
}

/** Whether `pid` is one of `roots` or descends from one. */
export function descendsFrom(pid: number | undefined, roots: ReadonlySet<number>, parents: ReadonlyMap<number, number>): boolean {
  let current = pid;
  for (let depth = 0; current !== undefined && current > 1 && depth < MAX_DEPTH; depth++) {
    if (roots.has(current)) return true;
    current = parents.get(current);
  }
  return false;
}

/** The ownership rule itself, free of I/O so it is tested directly. */
export function attributeServers(input: {
  servers: readonly LocalServer[];
  parents: ReadonlyMap<number, number>;
  ownRoots: ReadonlySet<number>;
  otherRoots: ReadonlySet<number>;
  mentioned: ReadonlySet<number>;
}): SessionServer[] {
  const result: SessionServer[] = [];
  for (const server of input.servers) {
    if (descendsFrom(server.pid, input.ownRoots, input.parents)) result.push({ ...server, source: "started" });
    else if (input.mentioned.has(server.port) && !descendsFrom(server.pid, input.otherRoots, input.parents)) {
      result.push({ ...server, source: "mentioned" });
    }
  }
  return result.sort((a, b) => Number(a.source === "mentioned") - Number(b.source === "mentioned") || a.port - b.port);
}

/** The process tree, plus the processes running this conversation by id: a
 * Claude Code background job runs as `<claude> --session-id <id>` under its
 * own host, while the pane only shows `claude attach <prefix>`. */
async function processTable(session: string): Promise<{ parents: Map<number, number>; runners: number[] }> {
  const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,args="], { timeout: 4000, maxBuffer: 16_777_216 });
  const parents = new Map<number, number>();
  const runners: number[] = [];
  const flag = `--session-id ${session}`;
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s?(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]), ppid = Number(match[2]);
    parents.set(pid, ppid);
    const args = match[3];
    const at = args.indexOf(flag);
    // The id must end there: a longer id sharing this prefix is another session.
    if (at >= 0 && !/[\w-]/.test(args[at + flag.length] ?? "") && pid !== process.pid) runners.push(pid);
  }
  return { parents, runners };
}

async function paneRoots(server: string, paneId: unknown): Promise<number[]> {
  const { shellPid, foregroundPids } = await terminalProvider().processes(server, String(paneId)).catch((): PaneProcesses => ({ foregroundPids: [] }));
  return [shellPid, ...foregroundPids].filter((pid): pid is number => pid !== undefined && pid > 1);
}

/** Processes holding the transcript open: a background-job agent's own process. */
async function transcriptHolders(file: string): Promise<number[]> {
  const lsof = process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof";
  const { stdout } = await exec(lsof, ["-t", "--", file], { timeout: 3000 }).catch(() => ({ stdout: "" }));
  // The Hook itself reads the transcript to stream the chat; it is never the owner.
  return stdout.split("\n").map(Number).filter(pid => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid);
}

async function transcriptTail(file: string): Promise<string> {
  const size = (await stat(file)).size;
  const handle = await open(file, "r");
  try {
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally { await handle.close(); }
}

export async function sessionWebServers(target: { server: string; pane: string; source: Provider; session: string }, pane: Json): Promise<{ servers: SessionServer[] }> {
  const [servers, table, own, file] = await Promise.all([
    webServers(), processTable(target.session), paneRoots(target.server, pane.pane_id),
    transcriptPath(target.source, target.session).catch(() => undefined),
  ]);
  const parents = table.parents;
  const ownRoots = new Set([...own, ...table.runners]);
  let mentioned = new Set<number>();
  if (file) {
    for (const pid of await transcriptHolders(file)) ownRoots.add(pid);
    mentioned = mentionedPorts(await transcriptTail(file).catch(() => ""));
  }
  // Other panes are only consulted for a mentioned port nobody here started.
  const otherRoots = new Set<number>();
  const unclaimed = servers.some(server => mentioned.has(server.port) && !descendsFrom(server.pid, ownRoots, parents));
  if (unclaimed) {
    const others = objects((await snapshot(target.server)).panes).filter(other => other.pane_id !== pane.pane_id).slice(0, MAX_OTHER_PANES);
    for (const roots of await Promise.all(others.map(other => paneRoots(target.server, other.pane_id)))) {
      for (const pid of roots) if (!ownRoots.has(pid)) otherRoots.add(pid);
    }
  }
  return { servers: attributeServers({ servers, parents, ownRoots, otherRoots, mentioned }) };
}

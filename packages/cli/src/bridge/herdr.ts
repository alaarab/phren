import { execFile } from "node:child_process";
import { connect } from "node:net";
import { homedir } from "node:os";
import { readdir, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { BridgeError, id, object, objects, requestID, serverName, type Json, type Target } from "./protocol.js";
import { recordedSession } from "./agent-hooks.js";

const exec = promisify(execFile);
export function herdrRoot(): string { return process.env.PHREN_HERDR_HOME || path.join(homedir(), ".config/herdr"); }
export function herdrSocket(server: string): string {
  serverName.parse(server);
  return path.join(herdrRoot(), ...(server === "default" ? [] : ["sessions", server]), "herdr.sock");
}

/** Herdr's documented newline JSON socket API. No shell, UI focus, or inherited caller context. */
export async function rpc(server: string, method: string, params: Json = {}, signal?: AbortSignal): Promise<Json> {
  const socket = herdrSocket(server);
  const metadata = await stat(socket);
  if (!metadata.isSocket() || (process.getuid && metadata.uid !== process.getuid())) throw new BridgeError(503, "The Herdr socket is unavailable.");
  return new Promise((resolve, reject) => {
    const client = connect(socket);
    const key = requestID();
    let pending = Buffer.alloc(0);
    const finish = (error?: Error, result?: Json) => {
      signal?.removeEventListener("abort", abort);
      client.destroy();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(new BridgeError(499, "Request cancelled."));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    client.setTimeout(10_000, () => finish(new BridgeError(504, "Herdr did not answer. Refresh before trying again.")));
    client.on("error", () => finish(new BridgeError(503, "Herdr is not reachable on this computer.")));
    client.on("end", () => finish(new BridgeError(503, "Herdr closed the request before confirming it.")));
    client.on("connect", () => client.write(JSON.stringify({ id: key, method, params }) + "\n"));
    client.on("data", bytes => {
      pending = Buffer.concat([pending, typeof bytes === "string" ? Buffer.from(bytes) : bytes]);
      if (pending.length > 4_194_304) { finish(new BridgeError(413, "Herdr response is too large.")); return; }
      const end = pending.indexOf(10);
      if (end < 0) return;
      try {
        const value = object(JSON.parse(pending.subarray(0, end).toString()));
        if (value.id !== key) throw new Error("Mismatched response");
        if (value.error) throw new BridgeError(409, "Herdr could not perform this action. Refresh the session before trying again.");
        finish(undefined, object(value.result));
      } catch (error) { finish(error instanceof Error ? error : new Error("Invalid Herdr response")); }
    });
  });
}

export async function servers(): Promise<Json[]> {
  const names = ["default", ...(await readdir(path.join(herdrRoot(), "sessions")).catch(() => [])).filter(n => serverName.safeParse(n).success)].slice(0, 64);
  const results = await Promise.all(names.map(async name => {
    try { await rpc(name, "ping"); return { id: `herdr:${name}`, kind: "herdr", session: name, running: true }; }
    catch { return null; }
  }));
  return results.filter((v): v is NonNullable<typeof v> => v !== null);
}

export async function snapshot(server: string): Promise<Json> { return object((await rpc(server, "session.snapshot")).snapshot); }
export function workspaceSnapshot(s: Json): Json {
  return { kind: "herdr", groups: objects(s.workspaces).map(w => ({ id: w.workspace_id, label: w.label,
    children: objects(s.tabs).filter(t => t.workspace_id === w.workspace_id).map(t => {
      const panes = objects(s.panes).filter(p => p.tab_id === t.tab_id);
      const agent = panes.find(p => p.agent);
      return { id: t.tab_id, label: t.label, title: agent?.title || agent?.terminal_title_stripped,
        agent: agent?.agent, agentStatus: t.agent_status, cwd: agent?.foreground_cwd || agent?.cwd,
        agentPaneCount: panes.filter(p => p.agent).length, paneCount: panes.length };
    }) })) };
}

/** Only file descriptors held by this pane's foreground processes establish identity.
 * A directory match, latest log, or focused tab must never select a conversation. */
async function processLogs(server: string, pane: Json): Promise<{ files: string[]; pids: number[] }> {
  const info = object((await rpc(server, "pane.process_info", { pane_id: pane.pane_id })).process_info);
  const pids = objects(info.foreground_processes).map(p => p.pid).filter((p): p is number => Number.isSafeInteger(p) && Number(p) > 0).slice(0, 16);
  const paths = await Promise.all(pids.map(async pid => {
    if (process.platform === "linux") {
      const base = `/proc/${pid}/fd`;
      return Promise.all((await readdir(base).catch(() => [])).slice(0, 4096).map(fd => readlink(path.join(base, fd)).catch(() => "")));
    }
    const result = await exec("/usr/sbin/lsof", ["-a", "-p", String(pid), "-Fn"], { timeout: 3000, maxBuffer: 1_048_576 }).catch(() => ({ stdout: "" }));
    return result.stdout.split("\n").filter(n => n.startsWith("n/")).map(n => n.slice(1));
  }));
  return { files: [...new Set(paths.flat())].filter(p => p.endsWith(".jsonl")), pids };
}

export async function paneIdentity(server: string, pane: Json): Promise<string | undefined> {
  const reported = object(pane.agent_session);
  if (reported.kind === "id" && reported.agent === pane.agent && typeof reported.value === "string" && /^[a-f0-9-]{36}$/i.test(reported.value)) return reported.value;
  const { files, pids } = await processLogs(server, pane);
  const candidates = files.flatMap(file => {
    const match = pane.agent === "codex" ? /rollout-.*-([a-f0-9-]{36})\.jsonl$/i.exec(file)
      : pane.agent === "claude" ? /\/([a-f0-9-]{36})\.jsonl$/i.exec(file)
      : /\/session-state\/([a-f0-9-]{36})\/events\.jsonl$/i.exec(file);
    return match ? [match[1]] : [];
  });
  if (new Set(candidates).size === 1) return candidates[0];
  // A lifecycle callback is bound to the process and terminal, never just cwd.
  return candidates.length === 0 ? recordedSession(server, pane, pids) : undefined;
}

export async function panes(server: string, workspace: string, tab: string): Promise<Json> {
  id.parse(workspace); id.parse(tab);
  const s = await snapshot(server);
  if (!objects(s.tabs).some(t => t.tab_id === tab && t.workspace_id === workspace)) throw new BridgeError(409, "This Herdr tab has changed. Refresh the computer.");
  return { kind: "herdr", groupId: workspace, childId: tab, panes: await Promise.all(objects(s.panes)
    .filter(p => p.workspace_id === workspace && p.tab_id === tab).map(async p => ({ id: p.pane_id,
      label: p.label || p.pane_id, agent: p.agent, agentStatus: p.agent_status,
      title: p.title || p.terminal_title_stripped, cwd: p.foreground_cwd || p.cwd,
      sessionId: p.agent ? await paneIdentity(server, p) : undefined }))) };
}

export async function validateTarget(target: Target, sending = false): Promise<Json> {
  const s = await snapshot(target.server);
  const pane = objects(s.panes).find(p => p.pane_id === target.pane && p.tab_id === target.tab && p.workspace_id === target.workspace && p.agent === target.source);
  if (!pane || await paneIdentity(target.server, pane) !== target.session) throw new BridgeError(409, "This pane's conversation changed. Reopen the chat.");
  if (sending && ["blocked", "waiting", "unknown"].includes(String(pane.agent_status))) throw new BridgeError(409, "This agent needs input in the terminal first.");
  return pane;
}

export async function trustedDirectory(pane: Json): Promise<string> {
  const cwd = pane.foreground_cwd || pane.cwd;
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new BridgeError(409, "This pane has no project folder.");
  return realpath(cwd);
}

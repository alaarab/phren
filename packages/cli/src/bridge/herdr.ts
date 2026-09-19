import { createHmac, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { connect } from "node:net";
import { homedir } from "node:os";
import { readdir, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { BridgeError, id, object, objects, requestID, serverName, provider, sessionId, type Json, type Target, type StartingTarget } from "./protocol.js";
import { recordedSession } from "./agent-hooks.js";
import { tabActivityKey } from "./tab-activity.js";

const exec = promisify(execFile);
export function herdrRoot(): string { return process.env.PHREN_HERDR_HOME || path.join(homedir(), ".config/herdr"); }
export function herdrSocket(server: string): string {
  serverName.parse(server);
  return path.join(herdrRoot(), ...(server === "default" ? [] : ["sessions", server]), "herdr.sock");
}

/** Herdr's documented newline JSON socket API. No shell, UI focus, or inherited caller context. */
export async function rpc(server: string, method: string, params: Json = {}, signal?: AbortSignal, timeoutMs = 10_000): Promise<Json> {
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
    client.setTimeout(timeoutMs, () => finish(new BridgeError(504, "Herdr did not answer. Refresh before trying again.")));
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
export function workspaceSnapshot(s: Json, contextUsedPercent?: ReadonlyMap<Json, number>, approvalPanes?: ReadonlySet<string>, lastChanged?: ReadonlyMap<string, string>): Json {
  const focusedPane = objects(s.panes).find(p => p.pane_id === s.focused_pane_id
    && p.tab_id === s.focused_tab_id && p.workspace_id === s.focused_workspace_id);
  const focus = focusedPane && id.safeParse(s.focused_workspace_id).success
    && id.safeParse(s.focused_tab_id).success && id.safeParse(s.focused_pane_id).success
    && objects(s.tabs).some(t => t.tab_id === s.focused_tab_id && t.workspace_id === s.focused_workspace_id)
    && objects(s.workspaces).some(w => w.workspace_id === s.focused_workspace_id)
    ? { workspaceID: s.focused_workspace_id, tabID: s.focused_tab_id, paneID: s.focused_pane_id } : undefined;
  // Focus identifies a pane to inspect. Its conversation is still resolved and
  // validated independently through panes(), never inferred from a directory.
  return { kind: "herdr", focus, groups: objects(s.workspaces).map(w => ({ id: w.workspace_id, label: w.label,
    children: objects(s.tabs).filter(t => t.workspace_id === w.workspace_id).map(t => {
      const panes = objects(s.panes).filter(p => p.tab_id === t.tab_id && p.workspace_id === t.workspace_id);
      const agent = panes.find(p => p.agent);
      // Herdr's per-pane state_change_seq climbs with every agent status
      // change; the phone orders "just finished" ahead of "finished an hour ago" by it.
      const changed = Math.max(0, ...panes.map(p => Number.isSafeInteger(p.state_change_seq) ? Number(p.state_change_seq) : 0));
      return { id: t.tab_id, label: t.label, title: agent?.title || agent?.terminal_title_stripped,
        agent: agent?.agent, agentStatus: t.agent_status, cwd: agent?.foreground_cwd || agent?.cwd,
        changedSeq: changed || undefined,
        lastChangedAt: lastChanged?.get(tabActivityKey(t.workspace_id, t.tab_id)),
        approvalPending: panes.some(p => approvalPanes?.has(String(p.pane_id))) || undefined,
        contextUsedPercent: agent && panes.filter(p => p.agent).length === 1 ? contextUsedPercent?.get(agent) : undefined,
        agentPaneCount: panes.filter(p => p.agent).length, paneCount: panes.length };
    }) })) };
}

/** Only file descriptors held by this pane's foreground processes establish identity.
 * A directory match, latest log, or focused tab must never select a conversation. */
async function foregroundPids(server: string, pane: Json): Promise<number[]> {
  const info = object((await rpc(server, "pane.process_info", { pane_id: pane.pane_id })).process_info);
  const pids = objects(info.foreground_processes).map(p => p.pid).filter((p): p is number => Number.isSafeInteger(p) && Number(p) > 0).slice(0, 16);
  return pids.sort((a, b) => a - b);
}
async function processLogs(pids: number[]): Promise<string[]> {
  const paths = await Promise.all(pids.map(async pid => {
    if (process.platform === "linux") {
      const base = `/proc/${pid}/fd`;
      return Promise.all((await readdir(base).catch(() => [])).slice(0, 4096).map(fd => readlink(path.join(base, fd)).catch(() => "")));
    }
    const result = await exec("/usr/sbin/lsof", ["-a", "-p", String(pid), "-Fn"], { timeout: 3000, maxBuffer: 1_048_576 }).catch(() => ({ stdout: "" }));
    return result.stdout.split("\n").filter(n => n.startsWith("n/")).map(n => n.slice(1));
  }));
  return [...new Set(paths.flat())].filter(p => p.endsWith(".jsonl"));
}

interface PaneIdentity { sessionId?: string; noTranscriptLogs: boolean }
const identities = new Map<string, { at: number; result: Promise<PaneIdentity> }>();
const identityKey = (server: string, pane: Json, pids: number[]) => JSON.stringify([server, pane.pane_id, pane.terminal_id, pids, pane.agent]);
export async function paneIdentity(server: string, pane: Json, fresh = false): Promise<string | undefined> {
  const reported = object(pane.agent_session);
  if (reported.kind === "id" && reported.agent === pane.agent && typeof reported.value === "string" && sessionId.safeParse(reported.value).success) return reported.value;
  const pids = await foregroundPids(server, pane);
  const key = identityKey(server, pane, pids);
  const cached = identities.get(key);
  if (!fresh && cached && Date.now() - cached.at < 2_000) return (await cached.result).sessionId;
  const result = identityFromProcesses(server, pane, pids);
  if (identities.size >= 128) identities.delete(identities.keys().next().value!);
  identities.set(key, { at: Date.now(), result });
  return (await result).sessionId;
}
async function identityFromProcesses(server: string, pane: Json, pids: number[]): Promise<PaneIdentity> {
  const files = await processLogs(pids);
  const candidates = files.flatMap(file => {
    const match = pane.agent === "codex" ? /rollout-.*-([a-f0-9-]{36})\.jsonl$/i.exec(file)
      : pane.agent === "claude" ? /\/([a-f0-9-]{36})\.jsonl$/i.exec(file)
      // phren-agent appends and closes per event, so its log is rarely open;
      // the lifecycle binding below is the usual path for it.
      : pane.agent === "phren" ? /\/session-([a-f0-9-]{36})\.events\.jsonl$/i.exec(file)
      : /\/session-state\/([a-f0-9-]{36})\/events\.jsonl$/i.exec(file);
    return match ? [match[1]] : [];
  });
  if (new Set(candidates).size === 1) return { sessionId: candidates[0], noTranscriptLogs: false };
  // A lifecycle callback is bound to the process and terminal, never just cwd.
  // Codex can hold its parent and subagent transcripts in the same process.
  // Use the verified binding to disambiguate only if its log is still open;
  // a stale binding must not override evidence of other conversations.
  const recorded = await recordedSession(server, pane, pids);
  return { sessionId: candidates.length === 0 || (recorded && candidates.includes(recorded)) ? recorded : undefined, noTranscriptLogs: candidates.length === 0 };
}

const startingKey = randomBytes(32);
/** Bind first-send permission to the actual terminal/process, never a cwd or
 * a guessed conversation. Tokens expire naturally when the Hook/process restarts. */
export async function paneChatState(server: string, pane: Json): Promise<Json> {
  if (!provider.safeParse(pane.agent).success) return {};
  const sessionId = await paneIdentity(server, pane);
  const pids = await foregroundPids(server, pane);
  const startingToken = typeof pane.terminal_id === "string" && pids.length
    ? createHmac("sha256", startingKey).update(JSON.stringify([server, pane.workspace_id, pane.tab_id, pane.pane_id, pane.terminal_id, pane.agent, pids])).digest("hex") : undefined;
  // An ambiguous set of open logs is not a brand-new conversation.
  // Reuse the same two-second identity probe as context/overview polling;
  // discovering a new chat must not run lsof again for every list refresh.
  const evidence = identities.get(identityKey(server, pane, pids));
  const starting = !sessionId && !!startingToken && !!evidence && Date.now() - evidence.at < 2_000 && (await evidence.result).noTranscriptLogs;
  return { sessionId, ...(startingToken ? { startingToken } : {}), ...(starting ? { starting: true } : {}) };
}

export async function panes(server: string, workspace: string, tab: string): Promise<Json> {
  id.parse(workspace); id.parse(tab);
  const s = await snapshot(server);
  if (!objects(s.tabs).some(t => t.tab_id === tab && t.workspace_id === workspace)) throw new BridgeError(409, "This Herdr tab has changed. Refresh the computer.");
  return { kind: "herdr", groupId: workspace, childId: tab, panes: await Promise.all(objects(s.panes)
    .filter(p => p.workspace_id === workspace && p.tab_id === tab).map(async p => ({ id: p.pane_id,
      label: p.label || p.pane_id, agent: p.agent, agentStatus: p.agent_status,
      title: p.title || p.terminal_title_stripped, cwd: p.foreground_cwd || p.cwd,
      ...await paneChatState(server, p) }))) };
}

export async function validateStartingTarget(target: StartingTarget): Promise<Json> {
  const s = await snapshot(target.server);
  const pane = objects(s.panes).find(p => p.pane_id === target.pane && p.tab_id === target.tab && p.workspace_id === target.workspace && p.agent === target.source);
  if (!pane) throw new BridgeError(409, "This agent pane changed. Reopen the chat.");
  // Force fresh process/log evidence before a mutation.
  if (await paneIdentity(target.server, pane, true)) throw new BridgeError(409, "The conversation is ready. Wait for chat to attach before sending.");
  const state = await paneChatState(target.server, pane);
  if (!state.starting || state.startingToken !== target.startingToken) throw new BridgeError(409, "This starting agent changed. Reopen the chat.");
  if (["blocked", "waiting", "unknown"].includes(String(pane.agent_status))) throw new BridgeError(409, "This agent needs input in the terminal first.");
  return pane;
}

export async function validateTarget(target: Target, sending = false): Promise<Json> {
  const s = await snapshot(target.server);
  const pane = objects(s.panes).find(p => p.pane_id === target.pane && p.tab_id === target.tab && p.workspace_id === target.workspace && p.agent === target.source);
  if (!pane || await paneIdentity(target.server, pane, sending) !== target.session) throw new BridgeError(409, "This pane's conversation changed. Reopen the chat.");
  if (sending && ["blocked", "waiting", "unknown"].includes(String(pane.agent_status))) throw new BridgeError(409, "This agent needs input in the terminal first.");
  return pane;
}

export async function trustedDirectory(pane: Json): Promise<string> {
  const cwd = pane.foreground_cwd || pane.cwd;
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new BridgeError(409, "This pane has no project folder.");
  return realpath(cwd);
}

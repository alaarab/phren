import { createHmac, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { connect } from "node:net";
import { homedir } from "node:os";
import { open, readdir, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { BridgeError, id, object, objects, requestID, serverName, provider, sessionId, type Json, type Target, type StartingTarget } from "./protocol.js";
import { logger } from "../logger.js";
import { recordedSession } from "./agent-hook-stores.js";
import { tabActivityKey } from "./tab-activity.js";
import { intervalFromEnv } from "./limits.js";
import { countHerdr, countIdentity } from "./metrics.js";

const exec = promisify(execFile);
export function herdrRoot(): string { return process.env.PHREN_HERDR_HOME || path.join(homedir(), ".config/herdr"); }
function herdrSocket(server: string): string {
  serverName.parse(server);
  return path.join(herdrRoot(), ...(server === "default" ? [] : ["sessions", server]), "herdr.sock");
}

/** The Herdr pane this process runs in, from the variables Herdr sets for
 * every pane: the server its socket belongs to plus the pane's ids. */
export function herdrPaneFromEnv(env: NodeJS.ProcessEnv = process.env): { server: string; workspace: string; tab: string; pane: string } | undefined {
  if (env.HERDR_ENV !== "1" || !env.HERDR_SOCKET_PATH) return undefined;
  const socket = path.resolve(env.HERDR_SOCKET_PATH), root = path.resolve(herdrRoot());
  const server = socket === path.join(root, "herdr.sock") ? "default"
    : socket.startsWith(path.join(root, "sessions") + path.sep) ? path.basename(path.dirname(socket)) : undefined;
  const { HERDR_WORKSPACE_ID: workspace, HERDR_TAB_ID: tab, HERDR_PANE_ID: pane } = env;
  if (!server || !workspace || !tab || !pane) return undefined;
  return { server, workspace, tab, pane };
}

/** A socket failure keeps its errno so "not running", "stale socket" and "permissions" stay distinct. */
export function herdrSocketError(error: Error): BridgeError {
  const code = (error as NodeJS.ErrnoException).code;
  const reason = code === "ENOENT" ? "Herdr is not running"
    : code === "ECONNREFUSED" ? "stale socket, Herdr is not listening"
    : code === "EACCES" || code === "EPERM" ? "this user may not open Herdr's socket"
    : undefined;
  const tag = code && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "unknown error";
  return new BridgeError(503, `Herdr is not reachable on this computer (${tag}${reason ? `: ${reason}` : ""}).`);
}

const optionalReadFailures = new Map<string, string>();
/**
 * For pane reads whose callers treat text as optional: the caller still gets
 * nothing, but the reason is logged once per target (again only if it changes).
 */
export function noteOptionalReadFailure(what: string, key: string, error: unknown): void {
  const reason = (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 200);
  if (optionalReadFailures.get(key) === reason) return;
  if (optionalReadFailures.size >= 256) optionalReadFailures.clear();
  optionalReadFailures.set(key, reason);
  logger.warn("herdr", `${what} for ${key} failed: ${reason}`);
}

/** Herdr's documented newline JSON socket API. No shell, UI focus, or inherited caller context. */
export async function rpc(server: string, method: string, params: Json = {}, signal?: AbortSignal, timeoutMs = 10_000): Promise<Json> {
  const socket = herdrSocket(server);
  countHerdr(method);
  const metadata = await stat(socket).catch(error => { throw herdrSocketError(error); });
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
    client.on("error", error => finish(herdrSocketError(error)));
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
        if (value.error) {
          const code = typeof object(value.error).code === "string" ? String(object(value.error).code).slice(0, 64) : undefined;
          // Herdr's own words say what went wrong; keep them, bounded and plain.
          const said = String(object(value.error).message ?? "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 200);
          throw new BridgeError(409, said ? `Herdr: ${said}` : "Herdr could not perform this action. Refresh the session before trying again.", code ? { herdrCode: code } : undefined);
        }
        finish(undefined, object(value.result));
      } catch (error) { finish(error instanceof Error ? error : new Error("Invalid Herdr response")); }
    });
  });
}

/** How long the activity timer reuses the list of running Herdr servers
 * before pinging every server directory again. */
export const SERVER_LIST_REUSE_MS = intervalFromEnv("PHREN_SERVER_LIST_REUSE_MS", 30_000, 0, 600_000);
let serverList: { at: number; value: Promise<Json[]> } | undefined;
/** The names the last `servers()` found running. */
let knownServers: string[] | undefined;
/** The running servers, reusing a list at most `maxAgeMs` old. For
 * background work only: a route that answers the phone calls `servers()`. */
export async function recentServers(maxAgeMs = SERVER_LIST_REUSE_MS): Promise<Json[]> {
  if (serverList && Date.now() - serverList.at < maxAgeMs) return serverList.value;
  const value = servers();
  serverList = { at: Date.now(), value };
  value.catch(() => { if (serverList?.value === value) serverList = undefined; });
  return value;
}

export async function servers(): Promise<Json[]> {
  const names = ["default", ...(await readdir(path.join(herdrRoot(), "sessions")).catch(() => [])).filter(n => serverName.safeParse(n).success)].slice(0, 64);
  const results = await Promise.all(names.map(async name => {
    try { await rpc(name, "ping"); return { id: `herdr:${name}`, kind: "herdr", session: name, running: true }; }
    catch { return null; }
  }));
  const running = results.filter((v): v is NonNullable<typeof v> => v !== null);
  knownServers = running.map(server => server.session);
  return running;
}

/** How old a shared `session.snapshot` may be for readers that poll: open
 * chat and status streams and the activity timer. The overview and every
 * action take a fresh one, which the pollers then reuse. */
export const SNAPSHOT_SHARE_MS = intervalFromEnv("PHREN_SNAPSHOT_SHARE_MS", 2_500, 0, 10_000);
const sharedSnapshots = new Map<string, { at: number; value: Json }>();
const inFlightSnapshots = new Map<string, Promise<Json>>();

/** A fresh snapshot. Its answer also becomes the shared one, so pollers reuse it. */
export async function snapshot(server: string): Promise<Json> {
  const started = Date.now();
  const value = object((await rpc(server, "session.snapshot")).snapshot);
  const current = sharedSnapshots.get(server);
  // A slower request that started before the current answer never replaces it.
  if (!current || current.at <= started) {
    if (!current && sharedSnapshots.size >= 64) sharedSnapshots.delete(sharedSnapshots.keys().next().value!);
    sharedSnapshots.set(server, { at: Date.now(), value });
  }
  return value;
}

/**
 * One `session.snapshot` per server shared by every poller: an answer less
 * than `maxAgeMs` old is reused and concurrent callers join the request in
 * flight, so N open chats cost one snapshot per window, not one each, and
 * reuse the overview's when it is recent enough. A pane that disappears or changes identity shows in the next
 * snapshot, at most `maxAgeMs` after the change. Failures are never kept.
 * Anything about to act on a pane (a send, a key, a launch) calls `snapshot`.
 */
export async function sharedSnapshot(server: string, maxAgeMs = SNAPSHOT_SHARE_MS): Promise<Json> {
  const cached = sharedSnapshots.get(server);
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.value;
  const pending = inFlightSnapshots.get(server);
  if (pending) return pending;
  const value = snapshot(server).finally(() => { if (inFlightSnapshots.get(server) === value) inFlightSnapshots.delete(server); });
  inFlightSnapshots.set(server, value);
  return value;
}

/**
 * Every pane on the running servers, from snapshots already held and no older
 * than `maxAgeMs`, without asking Herdr; undefined unless the server list is
 * known and every listed server has such a snapshot.
 */
export function knownPanes(maxAgeMs: number): Json[] | undefined {
  if (!knownServers) return undefined;
  const panes: Json[] = [];
  for (const name of knownServers) {
    const held = sharedSnapshots.get(name);
    if (!held || Date.now() - held.at >= maxAgeMs) return undefined;
    panes.push(...objects(held.value.panes));
  }
  return panes;
}

/** For tests: forget every shared snapshot and the server list. */
export function resetSharedHerdrState(): void { sharedSnapshots.clear(); inFlightSnapshots.clear(); serverList = undefined; knownServers = undefined; }
/** The agent's Herdr name. Newer Herdr keeps it in `agents[].name` rather
 * than on the pane (`agent_name`); read either. */
export function paneAgentName(s: Json, pane: Json | undefined): string | undefined {
  if (!pane) return undefined;
  if (typeof pane.agent_name === "string") return pane.agent_name;
  const named = objects(s.agents).find(agent => agent.pane_id === pane.pane_id);
  return typeof named?.name === "string" ? named.name : undefined;
}

/** Every agent name in use on a server, in either Herdr shape. */
export function agentNames(s: Json): Set<string> {
  return new Set([...objects(s.panes), ...objects(s.agents)].map(item => String(item.agent_name ?? item.name ?? "")));
}

/** A pane's place in a snapshot, and optionally the agent that must be running in it. */
export interface PaneAddress { workspace: string; tab: string; pane: string; source?: string }

/** The snapshot's pane at `address`; with a `source`, only while that agent runs there. */
export function findPane(s: Json, address: PaneAddress): Json | undefined {
  return objects(s.panes).find(p => p.pane_id === address.pane && p.tab_id === address.tab && p.workspace_id === address.workspace
    && (address.source === undefined || p.agent === address.source));
}

/** A conductor's Herdr name: "conductor", or "conductor-" plus its label. */
export function isConductorName(name: string | undefined): boolean {
  return name === "conductor" || !!name?.startsWith("conductor-");
}

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
        role: isConductorName(paneAgentName(s, agent)) ? "conductor" : undefined,
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
      countIdentity("proc");
      const base = `/proc/${pid}/fd`;
      return Promise.all((await readdir(base).catch(() => [])).slice(0, 4096).map(fd => readlink(path.join(base, fd)).catch(() => "")));
    }
    countIdentity("lsof");
    const result = await exec("/usr/sbin/lsof", ["-a", "-p", String(pid), "-Fn"], { timeout: 3000, maxBuffer: 1_048_576 }).catch(() => ({ stdout: "" }));
    return result.stdout.split("\n").filter(n => n.startsWith("n/")).map(n => n.slice(1));
  }));
  return [...new Set(paths.flat())].filter(p => p.endsWith(".jsonl") || p.endsWith(".lock"));
}

interface PaneIdentity { sessionId?: string; noTranscriptLogs: boolean }
/** How long a pane's process-based identity probe is reused. */
const IDENTITY_CACHE_MS = intervalFromEnv("PHREN_IDENTITY_CACHE_MS", 2_000);
const identities = new Map<string, { at: number; result: Promise<PaneIdentity> }>();
const identityKey = (server: string, pane: Json, pids: number[]) => JSON.stringify([server, pane.pane_id, pane.terminal_id, pids, pane.agent]);
/** The pane's identity and, when it had to look, the foreground PIDs it read,
 * so a caller that also needs them does not ask Herdr a second time. */
async function resolveIdentity(server: string, pane: Json, fresh: boolean): Promise<{ sessionId?: string; pids?: number[] }> {
  const reported = object(pane.agent_session);
  // Copilot's report lags a conversation switch (see copilotForegroundSession);
  // its own process log is read first and the report is the fallback.
  if (pane.agent !== "copilot" && reported.kind === "id" && reported.agent === pane.agent && typeof reported.value === "string" && sessionId.safeParse(reported.value).success) { countIdentity("reported"); return { sessionId: reported.value }; }
  const pids = await foregroundPids(server, pane);
  const key = identityKey(server, pane, pids);
  const cached = identities.get(key);
  if (!fresh && cached && Date.now() - cached.at < IDENTITY_CACHE_MS) { countIdentity("cached"); return { sessionId: (await cached.result).sessionId, pids }; }
  countIdentity(fresh ? "probe-fresh" : "probe");
  const result = identityFromProcesses(server, pane, pids);
  if (identities.size >= 128) identities.delete(identities.keys().next().value!);
  identities.set(key, { at: Date.now(), result });
  return { sessionId: (await result).sessionId, pids };
}
export async function paneIdentity(server: string, pane: Json, fresh = false): Promise<string | undefined> {
  return (await resolveIdentity(server, pane, fresh)).sessionId;
}
const copilotHome = () => process.env.COPILOT_HOME || path.join(homedir(), ".copilot");
/** Copilot CLI changes conversation inside one process (/new, /clear,
 * /resume) and runs its sessionStart hook only once that conversation's first
 * prompt is submitted. Until then Herdr's reported session and the recorded
 * binding still name the previous conversation, so a phone send aimed there
 * lands in the new one and its UserPromptSubmit check refuses it, every time.
 * The process log Copilot names by PID records each switch as it happens. */
export async function copilotForegroundSession(pids: number[], home = copilotHome()): Promise<string | undefined> {
  if (!pids.length) return undefined;
  const folder = path.join(home, "logs");
  const names = await readdir(folder).catch(() => [] as string[]);
  const logs = names.filter(name => pids.some(pid => name.startsWith("process-") && name.endsWith(`-${pid}.log`)));
  let current: string | undefined, latest = -1;
  for (const name of logs) {
    const file = await open(path.join(folder, name), "r").catch(() => undefined);
    if (!file) continue;
    try {
      // The switch lines are short and rare; the log's tail holds the last one.
      const { size } = await file.stat(), length = Math.min(size, 262_144);
      const { buffer, bytesRead } = await file.read(Buffer.alloc(length), 0, length, size - length);
      const lines = [...buffer.subarray(0, bytesRead).toString("utf8").matchAll(/^(\S+) \[INFO\] (Registering|Unregistering) foreground session: ([0-9a-f-]{36})\s*$/gim)];
      const last = lines.at(-1);
      if (!last) continue;
      const at = Date.parse(last[1]);
      if (at <= latest) continue;
      latest = at;
      current = last[2] === "Registering" && sessionId.safeParse(last[3]).success ? last[3] : undefined;
    } finally { await file.close(); }
  }
  return current;
}
async function identityFromProcesses(server: string, pane: Json, pids: number[]): Promise<PaneIdentity> {
  if (pane.agent === "copilot") {
    const current = await copilotForegroundSession(pids).catch(() => undefined);
    // A conversation nothing was sent to yet has no transcript: the pane is
    // starting, and its first prompt goes through the starting binding.
    if (current) return await stat(path.join(copilotHome(), "session-state", current, "events.jsonl"))
      .then(() => ({ sessionId: current, noTranscriptLogs: false }), () => ({ noTranscriptLogs: true }));
    const reported = object(pane.agent_session);
    if (reported.kind === "id" && reported.agent === "copilot" && typeof reported.value === "string" && sessionId.safeParse(reported.value).success) return { sessionId: reported.value, noTranscriptLogs: false };
  }
  const files = await processLogs(pids);
  const candidates = files.flatMap(file => {
    const match = pane.agent === "codex" ? (/rollout-.*-([a-f0-9-]{36})\.jsonl$/i.exec(file) ?? /thread-writer-locks\/([a-f0-9-]{36})\.lock$/i.exec(file))
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
export async function paneChatState(server: string, pane: Json, options: { tokenWhenIdentified?: boolean } = {}): Promise<Json> {
  if (!provider.safeParse(pane.agent).success) return {};
  const identity = await resolveIdentity(server, pane, false);
  const sessionId = identity.sessionId;
  // A pane whose conversation is known is not starting, so a caller that
  // reads only `sessionId` and `starting` (the overview) needs no PIDs.
  if (sessionId && options.tokenWhenIdentified === false) return { sessionId };
  const pids = identity.pids ?? await foregroundPids(server, pane);
  // The token binds to the agent's own process, the oldest in the pane's
  // foreground group. Helpers it spawns while starting up (Codex forks
  // several in its first seconds) must not turn the phone's first send away.
  const startingToken = typeof pane.terminal_id === "string" && pids.length
    ? createHmac("sha256", startingKey).update(JSON.stringify([server, pane.workspace_id, pane.tab_id, pane.pane_id, pane.terminal_id, pane.agent, pids[0]])).digest("hex") : undefined;
  // An ambiguous set of open logs is not a brand-new conversation.
  // Reuse the same two-second identity probe as context/overview polling;
  // discovering a new chat must not run lsof again for every list refresh.
  const evidence = identities.get(identityKey(server, pane, pids));
  const starting = !sessionId && !!startingToken && !!evidence && Date.now() - evidence.at < IDENTITY_CACHE_MS && (await evidence.result).noTranscriptLogs;
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

/** The pane a starting target names, if its terminal/process binding still
 * holds. Status is not checked here: a starting agent's first prompt (folder
 * trust, a login) is exactly what the phone answers with a key. */
export async function startingPane(target: StartingTarget): Promise<Json> {
  const s = await snapshot(target.server);
  const pane = findPane(s, target);
  if (!pane) throw new BridgeError(409, "This agent pane changed. Reopen the chat.");
  const state = await paneChatState(target.server, pane);
  if (state.sessionId || state.startingToken !== target.startingToken) throw new BridgeError(409, "This starting agent changed. Reopen the chat.");
  return pane;
}

export async function validateStartingTarget(target: StartingTarget): Promise<Json> {
  const s = await snapshot(target.server);
  const pane = findPane(s, target);
  if (!pane) throw new BridgeError(409, "This agent pane changed. Reopen the chat.");
  // Force fresh process/log evidence before a mutation.
  if (await paneIdentity(target.server, pane, true)) throw new BridgeError(409, "The conversation is ready. Wait for chat to attach before sending.");
  const state = await paneChatState(target.server, pane);
  if (!state.starting || state.startingToken !== target.startingToken) throw new BridgeError(409, "This starting agent changed. Reopen the chat.");
  if (["blocked", "waiting", "unknown"].includes(String(pane.agent_status))) throw new BridgeError(409, "This agent needs input in the terminal first.");
  return pane;
}

/** Identities already resolved for a shared snapshot's pane objects, so every
 * stream reading the same snapshot resolves a pane once. */
const sharedIdentities = new WeakMap<Json, Promise<string | undefined>>();
/**
 * The target's pane, only while it still runs the target's conversation.
 * `sharedWithinMs` lets a poller (a stream tick) accept a shared snapshot up
 * to that old; sends, keys and every other mutation keep a fresh one.
 */
export async function validateTarget(target: Target, sending = false, refreshIdentity = sending, sharedWithinMs = 0): Promise<Json> {
  const shared = sharedWithinMs > 0 && !sending && !refreshIdentity;
  const s = shared ? await sharedSnapshot(target.server, sharedWithinMs) : await snapshot(target.server);
  const pane = findPane(s, target);
  let identity: Promise<string | undefined> | undefined;
  if (pane && shared) {
    identity = sharedIdentities.get(pane);
    if (!identity) {
      identity = paneIdentity(target.server, pane);
      sharedIdentities.set(pane, identity);
      identity.catch(() => sharedIdentities.delete(pane));
    }
  } else if (pane) identity = paneIdentity(target.server, pane, refreshIdentity);
  if (!pane || await identity !== target.session) throw new BridgeError(409, "This pane's conversation changed. Reopen the chat.");
  if (sending && ["blocked", "waiting", "unknown"].includes(String(pane.agent_status))) throw new BridgeError(409, "This agent needs input in the terminal first.");
  return pane;
}

export async function trustedDirectory(pane: Json): Promise<string> {
  const cwd = pane.foreground_cwd || pane.cwd;
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new BridgeError(409, "This pane has no project folder.");
  return realpath(cwd);
}

import { boundSession } from "./agent-hook-stores.js";
import { isLocalComputer } from "./dispatch-hosts.js";
import { recentServers, servers, sharedSnapshot } from "./herdr.js";
import { hookPeers, peerRequest, type HookPeer } from "./peers.js";
import { BridgeError, object, objects, sessionId, type Json } from "./protocol.js";
import { paneRecord, recordTitle } from "./session-activity.js";

/** A terminal reference from chat text: a Herdr pane (`w2E:p1`) or tab
 * (`w2E:t1`) id, optionally prefixed by the computer it belongs to. */
export interface TerminalReference { computer?: string; id: string }

const REFERENCE = /^(?:([A-Za-z0-9_][A-Za-z0-9_.-]{0,252})\/)?([A-Za-z0-9_-]{1,64}:[pt]\d{1,18})$/;

/** The reference itself, never a URL, path or a longer code-like token. */
export function parseTerminalReference(value: string | null | undefined): TerminalReference {
  if (typeof value !== "string" || value.length > 512) throw new BridgeError(400, "Invalid terminal reference.");
  const match = REFERENCE.exec(value);
  // `$` also matches before a trailing newline; the whole token must match.
  if (!match || match[0] !== value) throw new BridgeError(400, "Invalid terminal reference.");
  return { ...(match[1] ? { computer: match[1] } : {}), id: match[2] };
}

const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;

/** The conversation Herdr reports for the pane, without probing its processes. */
function reportedSession(pane: Json): string | undefined {
  const reported = object(pane.agent_session);
  return reported.kind === "id" && reported.agent === pane.agent && typeof reported.value === "string"
    && sessionId.safeParse(reported.value).success ? reported.value : undefined;
}

/** The session's displayed name, by the same rules as the pane rows: a rename
 * wins, then a dispatch label, then the tab or workspace label, then the
 * harness title, with brief-derived launch titles filtered out. */
async function titleFor(server: string, snapshot: Json, pane: Json): Promise<string> {
  const tab = objects(snapshot.tabs).find(candidate => candidate.tab_id === pane.tab_id && candidate.workspace_id === pane.workspace_id);
  const workspace = objects(snapshot.workspaces).find(candidate => candidate.workspace_id === pane.workspace_id);
  // The Hook's own binding is terminal/source checked; Herdr's report is the fallback.
  const record = await paneRecord(server, pane, await boundSession(server, pane) ?? reportedSession(pane));
  const title = await recordTitle(record, { paneLabel: pane.label, harnessTitle: pane.title || pane.terminal_title_stripped,
    tabLabel: tab?.label, workspaceLabel: workspace?.label, fallbackLabel: pane.label || pane.pane_id });
  return title ?? String(pane.pane_id);
}

async function paneTerminal(computer: string, server: string, snapshot: Json, pane: Json): Promise<Json> {
  return { computer, server, pane: String(pane.pane_id), tab: String(pane.tab_id ?? ""), workspace: String(pane.workspace_id ?? ""),
    title: await titleFor(server, snapshot, pane), agent: text(pane.agent) ?? null, status: text(pane.agent_status) ?? null };
}

async function tabTerminal(computer: string, server: string, snapshot: Json, tab: Json): Promise<Json> {
  const inside = objects(snapshot.panes).filter(pane => pane.tab_id === tab.tab_id && pane.workspace_id === tab.workspace_id);
  // A tab is the session a phone opens; name its agent's pane when it has one.
  const pane = inside.find(candidate => text(candidate.agent)) ?? inside[0];
  return { computer, server, pane: pane ? String(pane.pane_id) : "", tab: String(tab.tab_id), workspace: String(tab.workspace_id ?? ""),
    title: pane ? await titleFor(server, snapshot, pane) : text(tab.label) ?? String(tab.tab_id),
    agent: text(pane?.agent) ?? null, status: text(tab.agent_status) ?? text(pane?.agent_status) ?? null };
}

/** The pane or tab `reference` names in one Hook snapshot. */
async function fromSnapshot(computer: string, server: string, snapshot: Json, reference: string): Promise<Json> {
  const pane = objects(snapshot.panes).find(candidate => candidate.pane_id === reference);
  if (pane) return paneTerminal(computer, server, snapshot, pane);
  const tab = objects(snapshot.tabs).find(candidate => candidate.tab_id === reference);
  if (tab) return tabTerminal(computer, server, snapshot, tab);
  throw new BridgeError(404, "No terminal matches that reference.", { code: "terminal-not-found" });
}

interface HeldSnapshot { server: string; snapshot?: Json; error?: unknown }

/** Shared snapshots, so a resolve adds no Herdr call of its own when the
 * activity timer or an open overview already holds one. A failed server is
 * kept: it must not read as an absent terminal. */
async function snapshotsFor(names: readonly string[]): Promise<HeldSnapshot[]> {
  return Promise.all(names.map(async server => {
    try { return { server, snapshot: await sharedSnapshot(server) }; }
    catch (error) { return { server, error }; }
  }));
}

/** The first match, preferring the server the text came from; undefined when
 * no inspected server holds the reference. */
async function search(held: readonly HeldSnapshot[], computer: string, reference: TerminalReference, from: string | null | undefined): Promise<Json | undefined> {
  // The pane the text came from is the cheapest hint at its server; workspace
  // ids are only unique within one Herdr server.
  const preferred = from ? held.find(entry => entry.snapshot && objects(entry.snapshot.panes).some(pane => pane.pane_id === from))?.server : undefined;
  const ordered = preferred ? [...held.filter(entry => entry.server === preferred), ...held.filter(entry => entry.server !== preferred)] : held;
  for (const entry of ordered) {
    if (!entry.snapshot) continue;
    try { return await fromSnapshot(computer, entry.server, entry.snapshot, reference.id); }
    catch (error) { if (!(error instanceof BridgeError && error.status === 404)) throw error; }
  }
  return undefined;
}

async function resolveLocal(computer: string, reference: TerminalReference, from: string | null | undefined): Promise<Json> {
  const held = await snapshotsFor((await recentServers()).map(server => String(server.session)).slice(0, 64));
  const originKnown = !from || held.some(entry => entry.snapshot && objects(entry.snapshot.panes).some(pane => pane.pane_id === from));
  const found = await search(held, computer, reference, from);
  if (found && originKnown) return found;
  // Discovery is shared with background work and can lag a newly started
  // server. A miss, or an origin pane the cached servers do not hold, refreshes
  // it once so a duplicate id is not matched on the wrong server; snapshots
  // stay shared.
  const known = new Set(held.map(entry => entry.server));
  const added = (await servers()).map(server => String(server.session)).filter(server => !known.has(server)).slice(0, 64);
  if (added.length) {
    const extra = [...held, ...await snapshotsFor(added)];
    const foundAfterRefresh = await search(extra, computer, reference, from);
    if (foundAfterRefresh) return foundAfterRefresh;
    const failed = extra.find(entry => entry.error);
    if (failed) throw failed.error;
  } else if (found) {
    return found;
  } else {
    const failed = held.find(entry => entry.error);
    if (failed) throw failed.error;
  }
  throw new BridgeError(404, "No terminal matches that reference.", { code: "terminal-not-found" });
}

const sameName = (left: string, right: string) => left.trim().toLowerCase() === right.trim().toLowerCase();

function peerNamed(peers: readonly HookPeer[], name: string): HookPeer | undefined {
  return peers.find(peer => sameName(peer.name, name));
}

export interface TerminalResolveOptions {
  /** This Hook's computer, as /v1/health reports it. */
  computer: { name: string; aliases?: readonly string[] };
  /** The pane the text came from, when the client knows it. */
  from?: string | null;
}

/** The terminal a chat reference names, on this computer or a verified peer. */
export async function resolveTerminalReference(value: string | null | undefined, options: TerminalResolveOptions): Promise<Json> {
  const reference = parseTerminalReference(value);
  const own = [options.computer.name, ...(options.computer.aliases ?? [])];
  if (!reference.computer || isLocalComputer(reference.computer, own)) return resolveLocal(options.computer.name, reference, options.from);
  const peers = await hookPeers().catch(error => {
    // No hooks.yaml means no peers; any other failure is the owner's to fix.
    if (error instanceof BridgeError && error.details?.hooksYaml === "missing") return [] as HookPeer[];
    throw error;
  });
  const peer = peerNamed(peers, reference.computer);
  if (!peer) throw new BridgeError(404, "No linked computer answers to that name.", { code: "terminal-not-found" });
  // The remote Hook resolves its own bare ref; this machine's `from` pane is
  // meaningless there.
  return object(await peerRequest(peer, `/v1/terminals/resolve?${new URLSearchParams({ ref: reference.id })}`));
}

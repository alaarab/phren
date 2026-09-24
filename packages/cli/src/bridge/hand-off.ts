import { z } from "zod";
import { computerName } from "./computers.js";
import { hookRequest } from "./client.js";
import { projectName } from "./dispatch.js";
import { grantLabel, listGrants, matchGrant } from "./grants.js";
import { hookPeers, optionalHookPeers, peerRequest, type HookPeer } from "./peers.js";
import { BridgeError, object, objects, sessionId, targetSchema, type Json, type Target } from "./protocol.js";
import { findPhrenPath } from "../phren-paths.js";
import { listMachines } from "../profile-store.js";
import { localNames } from "./computer-names.js";

const promptText = z.string().min(1).max(32768).refine(value => !/[\x00-\x08\x0b-\x1f\x7f]/.test(value));

export const handOffSchema = z.object({
  computer: computerName.optional().describe("Enrolled computer name. Omit for this computer."),
  target: targetSchema.optional().describe("Complete live target for the existing session."),
  session: sessionId.optional().describe("Session id to resolve through the Hook workspace overview."),
  project: projectName.optional().describe("Project slug this hand-off belongs to, for conductor grant matching."),
  text: promptText.describe("Prompt to deliver to the existing session, at most 32768 characters."),
}).strict().superRefine((value, context) => {
  if ((value.target === undefined) === (value.session === undefined)) context.addIssue({ code: "custom", message: "Provide exactly one of target or session." });
});
export type HandOffInput = z.infer<typeof handOffSchema>;

type Request = (route: string, data?: Json) => Promise<Json>;

/** The pane's project (its folder) or workspace label, for the conductor's
 * card; never a reason to fail a delivery. */
function labelOf(group: Json, tab: Json): string | undefined {
  const folder = typeof tab.cwd === "string" && tab.role !== "conductor" ? tab.cwd.split("/").filter(Boolean).at(-1) : undefined;
  return folder || (typeof group.label === "string" && group.label ? group.label : undefined);
}

async function findInOverview(request: Request, match: (target: Target) => boolean, server?: string): Promise<{ target: Target; label?: string } | undefined> {
  const route = server ? `/v1/workspaces?server=${encodeURIComponent(server)}` : "/v1/workspaces";
  const overview = await request(route);
  for (const group of objects(overview.groups)) for (const tab of objects(group.children)) {
    const parsed = targetSchema.safeParse(tab.target);
    if (parsed.success && match(parsed.data)) return { target: parsed.data, label: labelOf(group, tab) };
  }
  return undefined;
}

async function targetFromOverview(request: Request, session: string, server?: string): Promise<{ target: Target; label?: string }> {
  const found = await findInOverview(request, target => target.session === session, server);
  if (!found) throw new BridgeError(404, "No live session with that id appears in the workspace overview.");
  return found;
}

export async function handOff(input: unknown): Promise<{ ok: boolean; delivered: boolean; target: Target; label?: string; granted?: string }> {
  const data = handOffSchema.parse(input);
  let request: Request;
  let peer: HookPeer | undefined;
  if (data.computer === undefined) request = (route, body) => hookRequest(route, body);
  else {
    peer = (await hookPeers()).find(candidate => candidate.name === data.computer);
    if (!peer) throw new BridgeError(404, "Unknown computer. Add its verified connection to hooks.yaml.");
    request = (route, body) => peerRequest(peer!, route, body);
  }
  const resolved = data.target ? undefined : await targetFromOverview(request, data.session!, peer?.server);
  const target = data.target ?? resolved!.target;
  if (peer && target.server !== peer.server) throw new BridgeError(400, "The target belongs to a different Herdr server on that computer.");
  const grant = matchGrant(await listGrants(), { action: "hand_off", project: data.project, computer: data.computer });
  const result = await request("/v1/prompt", { target, text: data.text });
  const delivered = result.ok === true && result.deliveryUncertain !== true;
  // A session id was resolved from the overview already; an explicit target
  // is looked up once more, best effort, for its label.
  const label = resolved ? resolved.label
    : await findInOverview(request, found => found.pane === target.pane && found.session === target.session, peer?.server)
      .then(found => found?.label, () => undefined);
  return { ok: delivered, delivered, target, ...(label ? { label } : {}), ...(grant ? { granted: grantLabel(grant) } : {}) };
}

/** One live agent pane, on this computer or an enrolled one. */
export interface LiveSession {
  computer: string; local: boolean; project?: string; label?: string; title?: string; agent?: string;
  status?: string; role?: string; branch?: string; model?: string; target?: Target;
  /** Seconds since the tab last changed, when the Hook has seen it change. */
  idleFor?: number;
}

function sessionsFrom(overview: Json, computer: string, local: boolean, now = Date.now()): LiveSession[] {
  const sessions: LiveSession[] = [];
  for (const group of objects(overview.groups)) for (const tab of objects(group.children)) {
    if (typeof tab.agent !== "string") continue;
    const target = targetSchema.safeParse(tab.target);
    const cwd = typeof tab.cwd === "string" ? tab.cwd : "";
    const text = (value: unknown) => typeof value === "string" && value ? value : undefined;
    const changedAt = typeof tab.lastChangedAt === "string" ? Date.parse(tab.lastChangedAt) : NaN;
    // A conductor sits in the store, not a project.
    sessions.push({ computer, local, project: tab.role === "conductor" ? undefined : text(cwd.split("/").filter(Boolean).at(-1)), label: text(group.label),
      title: text(tab.title), agent: tab.agent, status: text(tab.agentStatus), role: text(tab.role),
      branch: text(tab.branch), model: text(tab.model), ...(target.success ? { target: target.data } : {}),
      ...(Number.isFinite(changedAt) ? { idleFor: Math.max(0, Math.floor((now - changedAt) / 1000)) } : {}) });
  }
  return sessions;
}

/** A computer name's first DNS label, lowercased: `Desk`, `desk.local` and
 * `Desk.example.net` are one computer. DHCP and Bonjour add domains to the
 * same machine's name, so full names do not identify a computer. */
export function computerLabel(name: string): string {
  const value = name.trim().toLowerCase();
  // An IPv4 address is one name, not a label and a domain.
  return /^\d+(\.\d+){3}$/.test(value) ? value : value.split(".")[0] ?? "";
}

/** A registered computer this Hook cannot see, with the other names the store
 * registers it under. */
export interface NotLinkedComputer { name: string; aliases?: string[] }

/** Computers the store registers (machines.yaml) that this Hook has no
 * verified connection to, so their sessions cannot be listed from here.
 * Names are compared by first label against this computer's names and each
 * peer's name, address and aliases; names sharing a label collapse into one
 * entry. */
export function notLinkedComputers(store: string | null, here: string, linked: readonly string[]): NotLinkedComputer[] {
  if (!store) return [];
  const machines = listMachines(store);
  if (!machines.ok) return [];
  const known = new Set([here, ...localNames(), ...linked].map(computerLabel).filter(Boolean));
  const groups = new Map<string, string[]>();
  for (const name of Object.keys(machines.data)) {
    const label = computerLabel(name);
    if (!label || known.has(label)) continue;
    groups.set(label, [...(groups.get(label) ?? []), name]);
  }
  return [...groups.values()].map(names => {
    // The shortest name leads (usually the bare label); the rest are aliases.
    const [name, ...aliases] = [...names].sort((a, b) => a.length - b.length || a.localeCompare(b));
    return aliases.length ? { name, aliases } : { name };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export interface LiveSessions {
  sessions: LiveSession[];
  unreachable: { computer: string; error: string }[];
  /** Registered in the store but not linked in hooks.yaml: unknown, not idle. */
  notLinked: NotLinkedComputer[];
  enrolled: number;
  peerError?: string;
}

/** Every live agent the conductor could hand work to: this computer's Herdr
 * overview plus each enrolled computer's, read through its verified Hook.
 * An unreachable computer is reported, never silently dropped. */
export async function listLiveSessions(options: { store?: string | null } = {}): Promise<LiveSessions> {
  const health = await hookRequest("/v1/health");
  const here = typeof object(health.computer).name === "string" ? String(object(health.computer).name) : "this computer";
  const sessions = sessionsFrom(await hookRequest("/v1/workspaces"), here, true);
  const { peers, peerError } = await optionalHookPeers();
  const unreachable: { computer: string; error: string }[] = [];
  // Names each peer answers to (its hostname, Bonjour name), so a computer
  // registered under another of its names is not reported as unlinked.
  const peerNames: string[] = [];
  await Promise.all(peers.map(async peer => {
    try {
      const route = peer.server && peer.server !== "default" ? `/v1/workspaces?server=${encodeURIComponent(peer.server)}` : "/v1/workspaces";
      const [overview, health] = await Promise.all([peerRequest(peer, route), peerRequest(peer, "/v1/health").catch(() => ({}))]);
      sessions.push(...sessionsFrom(overview, peer.name, false));
      const computer = object(object(health).computer);
      for (const name of [computer.name, ...(Array.isArray(computer.aliases) ? computer.aliases : [])]) if (typeof name === "string") peerNames.push(name);
    } catch (error) {
      unreachable.push({ computer: peer.name, error: error instanceof Error ? error.message : "Unreachable." });
    }
  }));
  const store = options.store !== undefined ? options.store : findPhrenPath();
  const notLinked = notLinkedComputers(store, here, [...peers.flatMap(peer => [peer.name, peer.address]), ...peerNames]);
  return { sessions, unreachable, notLinked, enrolled: peers.length, ...(peerError ? { peerError } : {}) };
}

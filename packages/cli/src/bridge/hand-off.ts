import { z } from "zod";
import { computerName } from "./computers.js";
import { hookRequest } from "./client.js";
import { projectName } from "./dispatch.js";
import { isAccountSlug } from "./claude-accounts.js";
import { grantLabel, findGrant } from "./grants.js";
import { hookPeers, optionalHookPeers, peerRequest, type HookPeer } from "./peers.js";
import { BridgeError, errorCode, object, objects, sessionId, targetSchema, type Json, type Target } from "./protocol.js";
import { findPhrenPath } from "../phren-paths.js";
import { listMachines } from "../profile-store.js";
import { localNames } from "./computer-names.js";
import { computerLabel, foldComputers, type PeerFacts } from "./computer-identity.js";

export { computerLabel };

const promptText = z.string().min(1).max(32768).refine(value => !/[\x00-\x08\x0b-\x1f\x7f]/.test(value));

export const handOffSchema = z.object({
  computer: computerName.optional().describe("Enrolled computer name. Omit for this computer."),
  target: targetSchema.optional().describe("Complete live target for the existing session."),
  session: sessionId.optional().describe("Session id to resolve through the Hook workspace overview."),
  project: projectName.optional().describe("Project slug this hand-off belongs to, for conductor grant matching."),
  account: z.string().refine(isAccountSlug, "Account must be default or a lowercase slug.").optional()
    .describe("Claude account id the session must run under (default, or a slug). A session of another account is refused; a row without an account counts as default."),
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

/** The account id an overview row runs under; a row without one is the default account. */
const accountOf = (tab: Json): string => typeof object(tab.account).id === "string" ? String(object(tab.account).id) : "default";

async function findInOverview(request: Request, match: (target: Target) => boolean, server?: string): Promise<{ target: Target; label?: string; account: string } | undefined> {
  const route = server ? `/v1/workspaces?server=${encodeURIComponent(server)}` : "/v1/workspaces";
  const overview = await request(route);
  for (const group of objects(overview.groups)) for (const tab of objects(group.children)) {
    const parsed = targetSchema.safeParse(tab.target);
    if (parsed.success && match(parsed.data)) return { target: parsed.data, label: labelOf(group, tab), account: accountOf(tab) };
  }
  return undefined;
}

async function targetFromOverview(request: Request, session: string, server?: string, account?: string): Promise<{ target: Target; label?: string }> {
  const found = await findInOverview(request, target => target.session === session, server);
  if (!found) throw new BridgeError(404, "No live session with that id appears in the workspace overview.");
  if (account && found.account !== account) throw new BridgeError(409, `That session runs under account ${found.account}, not ${account}.`, { code: "account_mismatch" });
  return found;
}

/** `deliveryId` names this one message on the receiving Hook, which then types
 * it at most once however often it is sent (the Hook's own callers retry;
 * the MCP tool does not take one). */
export async function handOff(input: unknown, options: { deliveryId?: string } = {}): Promise<{ ok: boolean; delivered: boolean; target: Target; label?: string; granted?: string }> {
  const data = handOffSchema.parse(input);
  let request: Request;
  let peer: HookPeer | undefined;
  if (data.computer === undefined) request = (route, body) => hookRequest(route, body);
  else {
    peer = (await hookPeers()).find(candidate => candidate.name === data.computer);
    if (!peer) throw new BridgeError(404, "Unknown computer. Add its verified connection to hooks.yaml.");
    request = (route, body) => peerRequest(peer!, route, body);
  }
  const resolved = data.target ? undefined : await targetFromOverview(request, data.session!, peer?.server, data.account);
  const target = data.target ?? resolved!.target;
  if (peer && target.server !== peer.server) throw new BridgeError(400, "The target belongs to a different Herdr server on that computer.");
  const grant = await findGrant({ action: "hand_off", project: data.project, computer: data.computer });
  const result = await request("/v1/prompt", { target, text: data.text, ...(options.deliveryId ? { deliveryId: options.deliveryId } : {}) });
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
  /** Claude account id, when the Hook knows it; absent means the default account or an unknown one. */
  account?: string;
  /** Seconds since the tab last changed, when the Hook has seen it change. */
  idleFor?: number;
  /** Set when the main turn ended and this many background tasks keep the session `working`. */
  backgroundTasks?: number;
}

function sessionsFrom(overview: Json, computer: string, local: boolean, now = Date.now()): LiveSession[] {
  const sessions: LiveSession[] = [];
  for (const group of objects(overview.groups)) for (const tab of objects(group.children)) {
    if (typeof tab.agent !== "string") continue;
    // A worker opened as a tab in the conductor's workspace is named by its
    // tab (Herdr's bare tab numbers do not count), never as the conductor.
    const inConductorWorkspace = tab.role !== "conductor" && objects(group.children).some(other => other.role === "conductor");
    const label = inConductorWorkspace ? (typeof tab.label === "string" && !/^\d+$/.test(tab.label) ? tab.label : undefined) : group.label;
    const target = targetSchema.safeParse(tab.target);
    const cwd = typeof tab.cwd === "string" ? tab.cwd : "";
    const text = (value: unknown) => typeof value === "string" && value ? value : undefined;
    const changedAt = typeof tab.lastChangedAt === "string" ? Date.parse(tab.lastChangedAt) : NaN;
    // A conductor sits in the store, not a project.
    sessions.push({ computer, local, project: tab.role === "conductor" ? undefined : text(cwd.split("/").filter(Boolean).at(-1)), label: text(label),
      title: text(tab.title), agent: tab.agent, status: text(tab.agentStatus), role: text(tab.role),
      branch: text(tab.branch), model: text(tab.model), ...(typeof object(tab.account).id === "string" ? { account: String(object(tab.account).id) } : {}), ...(target.success ? { target: target.data } : {}),
      ...(typeof tab.backgroundTasks === "number" && tab.backgroundTasks > 0 ? { backgroundTasks: tab.backgroundTasks } : {}),
      ...(Number.isFinite(changedAt) ? { idleFor: Math.max(0, Math.floor((now - changedAt) / 1000)) } : {}) });
  }
  return sessions;
}

/** A registered computer this Hook cannot see, with the other names the store
 * registers it under. */
export interface NotLinkedComputer { name: string; aliases?: string[] }

/** Computers the store registers (machines.yaml) that this Hook has no
 * verified connection to, so their sessions cannot be listed from here: the
 * unlinked rows of `foldComputers`, which folds names by first label and by
 * shared profile into the computers it can see. */
export function notLinkedFrom(store: string | null, here: string, peers: readonly PeerFacts[]): NotLinkedComputer[] {
  if (!store) return [];
  const machines = listMachines(store);
  if (!machines.ok) return [];
  return foldComputers({ local: { names: [here, ...localNames()] }, peers, machines: machines.data })
    .filter(row => !row.linked).map(row => row.aliases.length ? { name: row.name, aliases: row.aliases } : { name: row.name });
}

/** As `notLinkedFrom` for a flat list of names the linked computers answer
 * to, each standing for its own computer. */
export function notLinkedComputers(store: string | null, here: string, linked: readonly string[]): NotLinkedComputer[] {
  return notLinkedFrom(store, here, linked.map(name => ({ name, address: name })));
}

export interface LiveSessions {
  sessions: LiveSession[];
  unreachable: { computer: string; error: string; code?: string }[];
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
  const unreachable: LiveSessions["unreachable"] = [];
  // Names each peer answers to (its hostname, Bonjour name), so a computer
  // registered under another of its names is not reported as unlinked.
  const peerNames = new Map<string, string[]>();
  await Promise.all(peers.map(async peer => {
    try {
      const route = peer.server && peer.server !== "default" ? `/v1/workspaces?server=${encodeURIComponent(peer.server)}` : "/v1/workspaces";
      const [overview, health] = await Promise.all([peerRequest(peer, route), peerRequest(peer, "/v1/health").catch(() => ({}))]);
      sessions.push(...sessionsFrom(overview, peer.name, false));
      const computer = object(object(health).computer);
      peerNames.set(peer.name, [computer.name, ...(Array.isArray(computer.aliases) ? computer.aliases : [])].filter((name): name is string => typeof name === "string"));
    } catch (error) {
      const code = errorCode(error);
      unreachable.push({ computer: peer.name, error: error instanceof Error ? error.message : "Unreachable.", ...(code ? { code } : {}) });
    }
  }));
  const store = options.store !== undefined ? options.store : findPhrenPath();
  const notLinked = notLinkedFrom(store, here, peers.map(peer => ({ name: peer.name, address: peer.address, names: peerNames.get(peer.name) })));
  return { sessions, unreachable, notLinked, enrolled: peers.length, ...(peerError ? { peerError } : {}) };
}

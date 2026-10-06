import { z } from "zod";
import { computerName } from "./computers.js";
import { hookRequest } from "./client.js";
import { projectName } from "./dispatch.js";
import { isAccountSlug } from "./claude-accounts.js";
import { grantLabel, findGrant } from "./grants.js";
import { hookPeers, optionalHookPeers, peerRequest } from "./peers.js";
import { BridgeError, errorCode, object, objects, sessionId, targetSchema } from "./protocol.js";
import { findPhrenPath } from "../phren-paths.js";
import { listMachines } from "../profile-store.js";
import { localNames } from "./computer-names.js";
import { computerLabel, foldComputers, linkedComputer } from "./computer-identity.js";
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
    if ((value.target === undefined) === (value.session === undefined))
        context.addIssue({ code: "custom", message: "Provide exactly one of target or session." });
});
/** The pane's project (its folder) or workspace label, for the conductor's
 * card; never a reason to fail a delivery. */
function labelOf(group, tab) {
    const folder = typeof tab.cwd === "string" && tab.role !== "conductor" ? tab.cwd.split("/").filter(Boolean).at(-1) : undefined;
    return folder || (typeof group.label === "string" && group.label ? group.label : undefined);
}
/** The account id an overview row runs under; a row without one is the default account. */
const accountOf = (tab) => typeof object(tab.account).id === "string" ? String(object(tab.account).id) : "default";
async function findInOverview(request, match, server) {
    const route = server ? `/v1/workspaces?server=${encodeURIComponent(server)}` : "/v1/workspaces";
    const overview = await request(route);
    for (const group of objects(overview.groups))
        for (const tab of objects(group.children)) {
            const parsed = targetSchema.safeParse(tab.target);
            if (parsed.success && match(parsed.data))
                return { target: parsed.data, label: labelOf(group, tab), account: accountOf(tab) };
        }
    return undefined;
}
async function targetFromOverview(request, session, server, account) {
    const found = await findInOverview(request, target => target.session === session, server);
    if (!found)
        throw new BridgeError(404, "No live session with that id appears in the workspace overview.");
    if (account && found.account !== account)
        throw new BridgeError(409, `That session runs under account ${found.account}, not ${account}.`, { code: "account_mismatch" });
    return found;
}
/** `deliveryId` names this one message on the receiving Hook, which then types
 * it at most once however often it is sent (the Hook's own callers retry;
 * the MCP tool does not take one). */
export async function handOff(input, options = {}) {
    const data = handOffSchema.parse(input);
    let request;
    let peer;
    if (data.computer === undefined)
        request = (route, body) => hookRequest(route, body);
    else {
        // No hooks.yaml only matters when the name turns out to be another computer.
        let peersError;
        const peers = await hookPeers().catch(error => { peersError = error; return []; });
        // An alias or hostname (`Mac`, `Desk.local`) names the same computer as its hooks.yaml name.
        const named = peers.some(candidate => candidate.name === data.computer) ? undefined : await linkedComputer(data.computer).catch(() => undefined);
        if (named && "local" in named)
            request = (route, body) => hookRequest(route, body);
        else {
            if (peersError)
                throw peersError;
            const found = peers.find(candidate => candidate.name === (named && "peer" in named ? named.peer : data.computer));
            if (!found)
                throw new BridgeError(404, "Unknown computer. Add its verified connection to hooks.yaml.");
            peer = found;
            request = (route, body) => peerRequest(found, route, body);
        }
    }
    const resolved = data.target ? undefined : await targetFromOverview(request, data.session, peer?.server, data.account);
    const target = data.target ?? resolved.target;
    if (peer && target.server !== peer.server)
        throw new BridgeError(400, "The target belongs to a different Herdr server on that computer.");
    const grant = await findGrant({ action: "hand_off", project: data.project, computer: data.computer });
    const result = await request("/v1/prompt", { target, text: data.text, ...(options.deliveryId ? { deliveryId: options.deliveryId } : {}) });
    // A bare ok only acknowledges typing. Even an unchanged, busy Codex pane
    // may have kept the text in its composer instead of submitting a turn.
    const delivered = result.ok === true && result.delivered === true && result.deliveryUncertain !== true && result.unsubmitted !== true;
    // A session id was resolved from the overview already; an explicit target
    // is looked up once more, best effort, for its label.
    const label = resolved ? resolved.label
        : await findInOverview(request, found => found.pane === target.pane && found.session === target.session, peer?.server)
            .then(found => found?.label, () => undefined);
    return { ok: delivered, delivered, target,
        ...(!delivered && (result.ok === true || result.deliveryUncertain === true) ? { deliveryUncertain: true } : {}),
        ...(result.unsubmitted === true ? { unsubmitted: true } : {}),
        ...(label ? { label } : {}), ...(grant ? { granted: grantLabel(grant) } : {}) };
}
function sessionsFrom(overview, computer, local, now = Date.now()) {
    const sessions = [];
    for (const group of objects(overview.groups))
        for (const tab of objects(group.children)) {
            if (typeof tab.agent !== "string")
                continue;
            // A worker opened as a tab in the conductor's workspace is named by its
            // tab (Herdr's bare tab numbers do not count), never as the conductor.
            const inConductorWorkspace = tab.role !== "conductor" && objects(group.children).some(other => other.role === "conductor");
            const label = inConductorWorkspace ? (typeof tab.label === "string" && !/^\d+$/.test(tab.label) ? tab.label : undefined) : group.label;
            const target = targetSchema.safeParse(tab.target);
            const cwd = typeof tab.cwd === "string" ? tab.cwd : "";
            const text = (value) => typeof value === "string" && value ? value : undefined;
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
/** Computers the store registers (machines.yaml) that this Hook has no
 * verified connection to, so their sessions cannot be listed from here: the
 * unlinked rows of `foldComputers`, which folds names by first label and by
 * shared profile into the computers it can see. */
export function notLinkedFrom(store, here, peers) {
    if (!store)
        return [];
    const machines = listMachines(store);
    if (!machines.ok)
        return [];
    return foldComputers({ local: { names: [here, ...localNames()] }, peers, machines: machines.data })
        .filter(row => !row.linked).map(row => row.aliases.length ? { name: row.name, aliases: row.aliases } : { name: row.name });
}
/** As `notLinkedFrom` for a flat list of names the linked computers answer
 * to, each standing for its own computer. */
export function notLinkedComputers(store, here, linked) {
    return notLinkedFrom(store, here, linked.map(name => ({ name, address: name })));
}
/** Every live agent the conductor could hand work to: this computer's Herdr
 * overview plus each enrolled computer's, read through its verified Hook.
 * An unreachable computer is reported, never silently dropped. */
export async function listLiveSessions(options = {}) {
    const health = await hookRequest("/v1/health");
    const here = typeof object(health.computer).name === "string" ? String(object(health.computer).name) : "this computer";
    const sessions = sessionsFrom(await hookRequest("/v1/workspaces"), here, true);
    const { peers, peerError } = await optionalHookPeers();
    const unreachable = [];
    // Names each peer answers to (its hostname, Bonjour name), so a computer
    // registered under another of its names is not reported as unlinked.
    const peerNames = new Map();
    await Promise.all(peers.map(async (peer) => {
        try {
            const route = peer.server && peer.server !== "default" ? `/v1/workspaces?server=${encodeURIComponent(peer.server)}` : "/v1/workspaces";
            const [overview, health] = await Promise.all([peerRequest(peer, route), peerRequest(peer, "/v1/health").catch(() => ({}))]);
            sessions.push(...sessionsFrom(overview, peer.name, false));
            const computer = object(object(health).computer);
            peerNames.set(peer.name, [computer.name, ...(Array.isArray(computer.aliases) ? computer.aliases : [])].filter((name) => typeof name === "string"));
        }
        catch (error) {
            const code = errorCode(error);
            unreachable.push({ computer: peer.name, error: error instanceof Error ? error.message : "Unreachable.", ...(code ? { code } : {}) });
        }
    }));
    const store = options.store !== undefined ? options.store : findPhrenPath();
    const notLinked = notLinkedFrom(store, here, peers.map(peer => ({ name: peer.name, address: peer.address, names: peerNames.get(peer.name) })));
    return { sessions, unreachable, notLinked, enrolled: peers.length, ...(peerError ? { peerError } : {}) };
}

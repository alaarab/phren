import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { logger } from "../logger.js";
import { homeDir } from "../home-paths.js";
import { getMachineName } from "../machine-identity.js";
import { getProjectSourcePath } from "../project-config.js";
import { computerName } from "./computers.js";
import { dispatchParentSchema, validateDispatchParent } from "./dispatch-tree.js";
import { findGrant, grantLabel } from "./grants.js";
import { hookPeers } from "./peers.js";
import { linkedComputer } from "./computer-identity.js";
import { isLocalComputer, localHost, peerHost } from "./dispatch-hosts.js";
import { atomic, BridgeError, bridgeRoot, id, launchEfforts, PROTOCOL, provider, serverName, startingTargetSchema, targetSchema } from "./protocol.js";
import { phrenStoreRoot } from "./transcripts.js";
import { isAccountSlug } from "./claude-accounts.js";
import { hasUsable } from "./harnesses.js";
import { arrivalSchema } from "./launch-brief.js";
const text = (max) => z.string().min(1).max(max).refine(value => !!value.trim() && !/[\x00-\x1f\x7f]/.test(value));
export const projectName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
export const dispatchSchema = z.object({
    computer: z.union([z.literal("anywhere"), computerName]).describe("Enrolled computer name, or anywhere for the least busy connected computer."),
    project: projectName.describe("Project slug registered on the receiving computer."),
    harness: z.enum(["codex", "claude", "opencode"]).describe("Agent harness on the receiving computer."),
    model: text(200).optional().describe("Explicit model, otherwise the remote harness default."),
    effort: z.enum(launchEfforts).optional().describe("Reasoning effort for the worker (minimal, low, medium, high, xhigh, max), otherwise the harness default."),
    account: z.string().refine(isAccountSlug, "Account must be default or a lowercase slug.").optional()
        .describe("Claude account id to run the worker under (default, or a slug from `phren bridge accounts`). anywhere only picks computers where that account is signed in; a named computer without it fails."),
    prompt: z.string().min(1).max(32768).refine(value => !/[\x00-\x08\x0b-\x1f\x7f]/.test(value)).describe("Worker brief, at most 32768 characters."),
    label: text(200).describe("Short task label."),
    parent: dispatchParentSchema.optional().describe("Explicit local conversation parent for work-tree attachment."),
    parentTarget: targetSchema.optional().describe("Complete live target for the explicit parent."),
}).strict();
const remoteTarget = z.union([targetSchema, startingTargetSchema]);
/** The local pane that asked for the dispatch, where return notices go. */
export const originPaneSchema = z.object({ server: serverName, workspace: id, tab: id, pane: id }).strict();
export const workerStates = ["working", "done", "needs-you", "failed", "blocked", "gone"];
const timestamp = z.string().datetime();
const receiptSchema = dispatchSchema.omit({ prompt: true }).extend({
    id: z.string().uuid(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
    computerId: z.string().uuid().optional(),
    state: z.enum(["launching", "sending", "accepted", "uncertain", "failed"]),
    target: remoteTarget.optional(), error: z.string().max(500).optional(),
    brief: z.enum(["launch", "typed"]).optional()
        .describe("How the brief reached the worker: as its first prompt at launch (confirmed by the worker's hook), or typed into its pane."),
    granted: z.string().max(200).optional().describe("Scope of the conductor grant that allowed this call."),
    skipped: z.array(z.object({ computer: computerName, reason: z.string().max(200) }).strict()).max(32).optional()
        .describe("Computers left out of anywhere placement, with the reason each could not report capacity."),
    origin: originPaneSchema.extend({ agent: provider, terminal: z.string().min(1).max(200) }).strict().optional()
        .describe("The local agent pane that placed this dispatch; return notices go there."),
    worker: z.object({ state: z.enum(workerStates), since: timestamp, checkedAt: timestamp, sawWorking: z.boolean(),
        background: z.number().int().min(0).max(999).optional().describe("The most background tasks seen running while the worker was working."),
        waitingSince: timestamp.optional().describe("When the dispatching Hook first saw the worker's finished turn waiting on background tasks; bounds that wait.") }).strict().optional()
        .describe("The worker pane's last observed state."),
    returned: z.object({
        state: z.enum(["done", "needs-you", "failed", "blocked", "gone"]), at: timestamp,
        reply: z.string().max(4000).optional(), error: z.string().max(500).optional(), truncated: z.boolean().optional(), question: z.string().max(200).optional(),
        turn: z.string().regex(/^[a-f0-9]{16}$/).optional(), read: z.boolean(), notifiedAt: timestamp.optional(),
        background: z.number().int().min(1).max(999).optional().describe("Background tasks the worker left running when it was counted done."),
        waited: z.number().int().min(1).max(999).optional().describe("The most background tasks the worker waited on before it finished."),
    }).strict().optional().describe("The latest return: the worker finished, needs the owner, failed, is blocked or is gone."),
});
/** Where a checkout usually sits when the store names none for this computer. */
const CHECKOUT_ROOTS = ["Projects", "projects", "Sites", "Code", "code", "dev", "src", "repos"];
async function directoryAt(source) {
    if (typeof source !== "string" || !path.isAbsolute(source) || /[\x00-\x1f\x7f]/.test(source))
        return undefined;
    const directory = await realpath(source).catch(() => undefined);
    return directory && (await stat(directory)).isDirectory() ? directory : undefined;
}
/**
 * The project's folder on this computer. The store syncs between computers,
 * so its shared `sourcePath` is often another machine's folder: this
 * machine's `sourcePaths` entry wins, as everywhere else in phren. With
 * neither here, a git checkout named after the project in a usual project
 * root is taken (the owner's layout is `~/Projects/<name>` on every computer).
 */
export async function dispatchProjectDirectory(project, home = homeDir()) {
    const name = projectName.parse(project);
    const configured = await directoryAt(getProjectSourcePath(phrenStoreRoot(), name));
    if (configured)
        return configured;
    for (const root of [...(process.env.PROJECTS_DIR ? [process.env.PROJECTS_DIR] : []), ...CHECKOUT_ROOTS.map(folder => path.join(home, folder))]) {
        const checkout = await directoryAt(path.join(root, name));
        if (checkout && await stat(path.join(checkout, ".git")).catch(() => undefined))
            return checkout;
    }
    throw new BridgeError(404, `Project ${name} is not on this computer: the store names no folder for ${getMachineName()} that exists here, and there is no ~/Projects/${name} checkout.`);
}
async function save(receipt) {
    const root = path.join(bridgeRoot(), "dispatches");
    await mkdir(root, { recursive: true, mode: 0o700 });
    await atomic(path.join(root, `${receipt.id}.json`), receipt);
}
const MAX_RECEIPT_BYTES = 65_536;
let receiptUpdates = Promise.resolve();
/**
 * Change one settled receipt: read it, let `change` edit it, and write it back
 * when `change` returns true. Updates run one at a time in this process, and a
 * receipt still being placed (launching or sending) is never touched.
 */
export function updateReceipt(receiptID, change) {
    const run = receiptUpdates.then(async () => {
        const file = path.join(bridgeRoot(), "dispatches", `${z.string().uuid().parse(receiptID)}.json`);
        const info = await lstat(file).catch(() => undefined);
        if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_RECEIPT_BYTES)
            return undefined;
        const receipt = receiptSchema.parse(JSON.parse(await readFile(file, "utf8")));
        if (["launching", "sending"].includes(receipt.state))
            return undefined;
        if (!change(receipt))
            return receipt;
        receipt.updatedAt = new Date().toISOString();
        await atomic(file, receiptSchema.parse(receipt));
        return receipt;
    });
    receiptUpdates = run.catch(() => undefined);
    return run;
}
/** No ledger yet is normal; any other read failure is logged before it reads as empty. */
async function receiptNames(root) {
    try {
        return await readdir(root);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            logger.warn("dispatch", `Could not list dispatch receipts: ${failureReason(error)}`);
        return [];
    }
}
/** One bounded line for a log or a receipt: a Bridge message, an errno code, or the error's first line. */
export function failureReason(error) {
    if (error instanceof z.ZodError)
        return "The remote Hook sent an unexpected reply (protocol mismatch).";
    const code = error?.code;
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return `${typeof code === "string" && !(error instanceof BridgeError) ? `${code}: ` : ""}${message}`.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
}
export async function dispatchStatus() {
    const root = path.join(bridgeRoot(), "dispatches");
    const names = (await receiptNames(root)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).slice(0, 1024);
    const receipts = [];
    for (const name of names) {
        try {
            const file = path.join(root, name);
            const info = await lstat(file);
            if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RECEIPT_BYTES)
                continue;
            const receipt = receiptSchema.parse(JSON.parse(await readFile(file, "utf8")));
            // A service restart cannot prove whether an in-flight mutation arrived.
            if (["launching", "sending"].includes(receipt.state))
                receipt.state = "uncertain";
            receipts.push(receipt);
        }
        catch { /* Interrupted or old receipts do not become live dispatches. */ }
    }
    return receipts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
async function capacity(host) {
    const value = await host.request("/v1/dispatch/capacity");
    const result = z.object({ product: z.literal("phren-hook"), protocol: z.literal(PROTOCOL), working: z.number().int().nonnegative(),
        servers: z.array(z.string()), computer: z.object({ id: z.string().uuid() }).passthrough(),
        // Missing from an older Hook, or when its inventory was not ready in time: unknown, not unavailable.
        harnesses: z.array(z.object({ source: z.string(), installed: z.boolean(), usable: z.boolean(), reason: z.string().optional(),
            accounts: z.array(z.object({ id: z.string(), usable: z.boolean(), reason: z.string().optional() }).passthrough()).optional() }).passthrough()).optional() }).parse(value);
    // This computer places on whichever Herdr server its own Hook runs.
    if (host.local && !result.servers.includes(host.server) && result.servers[0])
        host.server = result.servers[0];
    if (!result.servers.includes(host.server))
        throw new BridgeError(503, "Herdr is not running on the selected computer. Headless dispatch is not installed yet.");
    return { working: result.working, computerId: result.computer.id, ...(result.harnesses ? { harnesses: result.harnesses } : {}) };
}
/** Why a computer cannot run this dispatch's harness and account, or undefined when it can or cannot yet be told.
 * `unknown` (no `harnesses`) only counts against a computer when a non-default account was asked for. */
function unusable(data, harnesses, strictUnknown) {
    if (!harnesses)
        return strictUnknown && data.account && data.account !== "default" ? "Its Hook does not report harnesses or accounts (update it)." : undefined;
    const availability = hasUsable({ harnesses }, data.harness, data.account);
    return availability.ok ? undefined : availability.reason;
}
/**
 * A freshly started agent may not have written its session yet when the launch
 * returns, so the launch carries no target. Ask the remote pane for a few
 * seconds; the pane ids from the launch are enough to find it. Until its first
 * prompt a new Codex or Claude has no conversation at all, only a starting
 * binding, and that is the target its brief goes to (as the phone's first
 * message does). `status` is the pane's last status when neither appeared.
 */
async function settledTarget(peer, launched, harness, intervalMs = 1_000) {
    const workspace = launched.workspaceId, tab = launched.tabId, pane = launched.paneId;
    if (typeof workspace !== "string" || typeof tab !== "string" || typeof pane !== "string")
        return {};
    let status;
    for (let attempt = 0; attempt < 15; attempt++) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
        try {
            const result = await peer.request(`/v1/workspaces/panes?server=${encodeURIComponent(peer.server)}&groupId=${encodeURIComponent(workspace)}&childId=${encodeURIComponent(tab)}`);
            const found = (Array.isArray(result.panes) ? result.panes : []).find((p) => p && typeof p === "object" && p.id === pane);
            if (typeof found?.agentStatus === "string")
                status = found.agentStatus;
            const binding = { server: peer.server, workspace, tab, pane, source: harness };
            const session = found?.sessionId;
            if (typeof session === "string" && session)
                return { target: { ...binding, session } };
            if (found?.starting === true && typeof found.startingToken === "string")
                return { target: { ...binding, starting: true, startingToken: found.startingToken } };
        }
        catch { /* The pane list can lag the launch; try again. */ }
    }
    return { status };
}
/** The new agent is holding a screen of its own before it takes any prompt:
 * Claude's folder trust or a sign-in. Only the owner answers those. */
class StartupScreen extends Error {
    status;
    constructor(status) {
        super(`The agent is ${status} on a startup screen.`);
        this.status = status;
    }
}
/**
 * Sends the brief. A fresh agent can read `unknown` to Herdr for a while (long
 * on a loaded machine), and the Hook refuses a prompt to such a pane before
 * typing anything. So that refusal is retried while the pane is still
 * unclassified; a pane that is blocked or waiting really needs its terminal,
 * and that refusal stands.
 */
async function sendBrief(peer, target, text, deliveryId) {
    for (let attempt = 0;; attempt++) {
        // One delivery id for every attempt: the receiving Hook types it once.
        try {
            return await peer.request("/v1/prompt", { target, text, deliveryId });
        }
        catch (error) {
            const unsettled = error instanceof BridgeError && error.status === 409 && /needs input in the terminal first/.test(error.message);
            if (!unsettled || attempt >= 20)
                throw error;
            const panes = await peer.request(`/v1/workspaces/panes?server=${encodeURIComponent(peer.server)}&groupId=${encodeURIComponent(String(target.workspace))}&childId=${encodeURIComponent(String(target.tab))}`).catch(() => undefined);
            const pane = (Array.isArray(panes?.panes) ? panes.panes : []).find((p) => p && typeof p === "object" && p.id === target.pane);
            const status = pane?.agentStatus;
            // Nothing was typed: the refusal came before any text reached the pane.
            if (typeof status === "string" && ["blocked", "waiting"].includes(status))
                throw new StartupScreen(status);
            await new Promise(resolve => setTimeout(resolve, 1_000));
        }
    }
}
/** What the worker's own hooks reported for a brief that went with its
 * launch, or undefined when the receiving Hook has no such brief. */
export async function arrivalOf(peer, id) {
    const answer = await peer.request(`/v1/dispatch/arrival?id=${encodeURIComponent(id)}`);
    const arrival = answer.arrival === null ? undefined : arrivalSchema.parse(answer.arrival);
    return arrival;
}
/**
 * A brief that went with the launch is the new agent's first prompt; its
 * UserPromptSubmit hook echoes the dispatch id when the harness submits it.
 * Waits for that echo, and returns the conversation it named.
 */
async function awaitArrival(peer, id, intervalMs) {
    let last = {};
    for (let attempt = 0; attempt < ARRIVAL_ATTEMPTS; attempt++) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
        last = await arrivalOf(peer, id).catch(() => undefined) ?? last;
        if (last.accepted)
            break;
    }
    return last;
}
/** Claude and Codex take a few seconds to start, load their MCP servers and submit the prompt. */
const ARRIVAL_ATTEMPTS = 30;
/** The pane's status as the remote Hook lists it now. */
async function paneStatus(peer, launched) {
    const panes = await peer.request(`/v1/workspaces/panes?server=${encodeURIComponent(peer.server)}&groupId=${encodeURIComponent(String(launched.workspaceId))}&childId=${encodeURIComponent(String(launched.tabId))}`).catch(() => undefined);
    const pane = (Array.isArray(panes?.panes) ? panes.panes : []).find((p) => p && typeof p === "object" && p.id === launched.paneId);
    return typeof pane?.agentStatus === "string" ? pane.agentStatus : undefined;
}
export class DispatchService {
    identity;
    local;
    settleIntervalMs;
    active = false;
    /** `local` is this computer as a dispatch destination (its own Hook's
     * socket); tests replace it so they never reach a real Hook. */
    constructor(identity, local = () => localHost(), settleIntervalMs = 1_000) {
        this.identity = identity;
        this.local = local;
        this.settleIntervalMs = settleIntervalMs;
    }
    /** `originValue` is the local pane the request came from, as its agent's
     * Herdr variables name it; a pane without a running agent is left out. */
    async dispatch(input, originValue) {
        const data = dispatchSchema.parse(input);
        if (this.active)
            throw new BridgeError(429, "A dispatch is already being placed. Try again after its receipt arrives.");
        this.active = true;
        try {
            if (data.parent !== undefined || data.parentTarget !== undefined) {
                if (!this.identity)
                    throw new BridgeError(503, "This Hook cannot validate a dispatch parent.");
                await validateDispatchParent(data, this.identity.computerID, this.identity.validateParentTarget);
            }
            if ((await receiptNames(path.join(bridgeRoot(), "dispatches"))).length >= 1024)
                throw new BridgeError(429, "Dispatch history is full. Archive old receipts before dispatching again.");
            // This computer needs no hooks.yaml entry, so a missing file only
            // matters when the dispatch names another computer.
            const here = this.local();
            // An alias or hostname (`Mac`, `Squids-Mac-mini.local`) names the same computer as its hooks.yaml name.
            const named = data.computer === "anywhere" || isLocalComputer(data.computer, here.names) ? undefined : await linkedComputer(data.computer).catch(() => undefined);
            const toLocal = data.computer !== "anywhere" && (isLocalComputer(data.computer, here.names) || (named !== undefined && "local" in named));
            const peerName = named && "peer" in named ? named.peer : data.computer;
            const enrolled = await hookPeers().catch(error => { if (toLocal || data.computer === "anywhere")
                return []; throw error; });
            const peers = [...enrolled.map(candidate => peerHost(candidate)), here];
            let peer;
            let remoteComputerID;
            const skipped = [];
            let incapable = false;
            if (data.computer === "anywhere") {
                const available = await Promise.all(peers.map(async (candidate) => {
                    try {
                        return { peer: candidate, ...await capacity(candidate) };
                    }
                    catch (error) {
                        // A peer that cannot report capacity sits out this placement, and the receipt says why.
                        skipped.push({ computer: candidate.name, reason: failureReason(error) });
                        return undefined;
                    }
                }));
                skipped.sort((a, b) => a.computer.localeCompare(b.computer));
                const capable = available.filter((item) => !!item).filter(item => {
                    const reason = unusable(data, item.harnesses, true);
                    if (reason)
                        incapable = true;
                    if (reason)
                        skipped.push({ computer: item.peer.name, reason: reason.slice(0, 200) });
                    return !reason;
                });
                skipped.sort((a, b) => a.computer.localeCompare(b.computer));
                const selected = capable
                    .sort((a, b) => a.working - b.working || a.peer.name.localeCompare(b.peer.name))[0];
                peer = selected?.peer;
                remoteComputerID = selected?.computerId;
                if (!peer)
                    throw new BridgeError(503, incapable ? `No enrolled computer with a running Herdr can run ${data.harness}${data.account ? ` account ${data.account}` : ""}.` : "No enrolled computer with a running Herdr is connected.", skipped.length ? { skipped } : undefined);
            }
            else {
                peer = toLocal ? peers.find(candidate => candidate.local) : peers.find(candidate => !candidate.local && candidate.name === peerName);
                if (!peer)
                    throw new BridgeError(404, "Unknown computer. Add its verified connection to hooks.yaml.");
                const reported = await capacity(peer);
                remoteComputerID = reported.computerId;
                // A Hook that reports what it can run is believed. An older one that does not is left to answer the launch
                // itself, except for a non-default account: it would ignore `account` and launch under its default login.
                const reason = unusable(data, reported.harnesses, true);
                if (reason)
                    throw new BridgeError(409, `${peer.name} cannot run ${data.harness}${data.account ? ` account ${data.account}` : ""}: ${reason}`);
            }
            const grant = await findGrant({ action: "dispatch", project: data.project, computer: peer.name });
            const origin = await this.origin(originValue);
            // Prompts are sent over the pipe, never stored in the dispatch ledger.
            const { prompt, ...metadata } = data;
            const receipt = { ...metadata, computer: peer.name, computerId: remoteComputerID, id: randomUUID(),
                createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: "launching",
                ...(grant ? { granted: grantLabel(grant) } : {}), ...(skipped.length ? { skipped } : {}), ...(origin ? { origin } : {}) };
            await save(receipt);
            try {
                // The brief goes with the launch: a Hook that can start the harness
                // with it says so, and any other types it below.
                const launched = await peer.request(`/v1/workspaces/launch?server=${encodeURIComponent(peer.server)}`, { project: data.project, kind: data.harness, model: data.model, ...(data.effort ? { effort: data.effort } : {}), ...(data.account ? { account: data.account } : {}), label: data.label, brief: { id: receipt.id, text: prompt } });
                if (launched.briefLaunched === true) {
                    receipt.brief = "launch";
                    await this.confirmLaunched(peer, receipt, launched);
                    receipt.updatedAt = new Date().toISOString();
                    await save(receipt);
                    return { ok: receipt.state === "accepted", ...receipt };
                }
                receipt.brief = "typed";
                const settled = launched.target ? { target: launched.target } : await settledTarget(peer, launched, data.harness, this.settleIntervalMs);
                if (!settled.target) {
                    if (["blocked", "waiting"].includes(String(settled.status ?? launched.agentStatus)))
                        throw new StartupScreen(String(settled.status ?? launched.agentStatus));
                    throw new BridgeError(504, `${data.harness} started in the new "${data.label}" pane on ${peer.name} but never showed a conversation or a starting pane (last status ${settled.status ?? "unknown"}), so the brief was not sent. The pane is still open.`);
                }
                const target = remoteTarget.parse(settled.target);
                if (target.source !== data.harness || target.server !== peer.server)
                    throw new BridgeError(502, "The remote Hook returned a different launch target.");
                receipt.target = target;
                receipt.state = "sending";
                receipt.updatedAt = new Date().toISOString();
                await save(receipt);
                const result = await sendBrief(peer, receipt.target, prompt, `dispatch-${receipt.id}`);
                receipt.state = result.ok === true && result.deliveryUncertain !== true ? "accepted" : "uncertain";
            }
            catch (error) {
                if (error instanceof StartupScreen) {
                    // Known, not uncertain: the brief never reached the pane. Say where
                    // the owner answers, and let the returns loop tell the conductor once.
                    const question = `${data.harness} in "${data.label}" on ${peer.name} is waiting on a startup screen (folder trust or sign-in).`.slice(0, 200);
                    receipt.state = "failed";
                    receipt.error = `${question} The brief was not sent. Answer that screen in the pane (the phone can), then hand the brief off to the new session.`.slice(0, 500);
                    receipt.returned = { state: "needs-you", at: new Date().toISOString(), question, read: false };
                }
                else {
                    receipt.state = receipt.state === "launching" && error instanceof BridgeError && [400, 404, 429, 504].includes(error.status) ? "failed" : "uncertain";
                    receipt.error = error instanceof BridgeError ? error.message.slice(0, 500) : "Remote delivery was not confirmed. Inspect this dispatch before retrying.";
                }
            }
            receipt.updatedAt = new Date().toISOString();
            await save(receipt);
            return { ok: receipt.state === "accepted", ...receipt };
        }
        finally {
            this.active = false;
        }
    }
    /**
     * A brief that went with the launch: wait for the worker's hook to confirm
     * it by dispatch id. A startup screen (folder trust, sign-in) holds the
     * prompt until the owner answers it, and the harness then submits it by
     * itself, so that is not a failure. Neither confirmed nor held reads
     * uncertain, and the returns loop keeps asking.
     */
    async confirmLaunched(peer, receipt, launched) {
        const known = remoteTarget.safeParse(launched.target);
        if (known.success && known.data.source === receipt.harness && known.data.server === peer.server)
            receipt.target = known.data;
        receipt.state = "sending";
        receipt.updatedAt = new Date().toISOString();
        await save(receipt);
        const held = (status) => ["blocked", "waiting"].includes(String(status));
        const arrival = held(launched.agentStatus) ? await arrivalOf(peer, receipt.id).catch(() => undefined) ?? {}
            : await awaitArrival(peer, receipt.id, this.settleIntervalMs);
        const named = arrival.accepted?.target ?? arrival.started?.target;
        if (named && named.source === receipt.harness && named.server === peer.server)
            receipt.target = named;
        if (arrival.accepted) {
            receipt.state = "accepted";
            return;
        }
        const status = held(launched.agentStatus) ? String(launched.agentStatus) : await paneStatus(peer, launched);
        receipt.state = "uncertain";
        if (held(status)) {
            const question = `${receipt.harness} in "${receipt.label}" on ${receipt.computer} is waiting on a startup screen (folder trust or sign-in).`.slice(0, 200);
            receipt.error = `${question} The brief is queued as its first prompt and starts once that screen is answered in the pane (the phone can).`.slice(0, 500);
            receipt.returned = { state: "needs-you", at: new Date().toISOString(), question, read: false };
            return;
        }
        receipt.error = `${receipt.harness} started with the brief on ${receipt.computer} but has not confirmed it yet (last status ${status ?? "unknown"}). The Hook keeps checking.`.slice(0, 500);
    }
    async origin(value) {
        const pane = originPaneSchema.safeParse(value);
        if (!pane.success || !this.identity?.originAgent)
            return undefined;
        const running = await this.identity.originAgent(pane.data).catch(() => undefined);
        return running ? { ...pane.data, ...running } : undefined;
    }
}

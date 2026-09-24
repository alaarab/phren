import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { logger } from "../logger.js";
import { readProjectConfig } from "../project-config.js";
import { computerName } from "./computers.js";
import { dispatchParentSchema, validateDispatchParent } from "./dispatch-tree.js";
import { grantLabel, listGrants, matchGrant } from "./grants.js";
import { hookPeers } from "./peers.js";
import { isLocalComputer, localHost, peerHost, type DispatchHost } from "./dispatch-hosts.js";
import { atomic, BridgeError, bridgeRoot, id, PROTOCOL, provider, serverName, startingTargetSchema, targetSchema, type Json, type Provider, type Target } from "./protocol.js";
import { phrenStoreRoot } from "./transcripts.js";

const text = (max: number) => z.string().min(1).max(max).refine(value => !!value.trim() && !/[\x00-\x1f\x7f]/.test(value));
export const projectName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
export const dispatchSchema = z.object({
  computer: z.union([z.literal("anywhere"), computerName]).describe("Enrolled computer name, or anywhere for the least busy connected computer."),
  project: projectName.describe("Project slug registered on the receiving computer."),
  harness: z.enum(["codex", "claude", "opencode"]).describe("Agent harness on the receiving computer."),
  model: text(200).optional().describe("Explicit model, otherwise the remote harness default."),
  prompt: z.string().min(1).max(32768).refine(value => !/[\x00-\x08\x0b-\x1f\x7f]/.test(value)).describe("Worker brief, at most 32768 characters."),
  label: text(200).describe("Short task label."),
  parent: dispatchParentSchema.optional().describe("Explicit local conversation parent for work-tree attachment."),
  parentTarget: targetSchema.optional().describe("Complete live target for the explicit parent."),
}).strict();
export type DispatchInput = z.infer<typeof dispatchSchema>;
const remoteTarget = z.union([targetSchema, startingTargetSchema]);
/** The local pane that asked for the dispatch, where return notices go. */
export const originPaneSchema = z.object({ server: serverName, workspace: id, tab: id, pane: id }).strict();
export type OriginPane = z.infer<typeof originPaneSchema>;
export const workerStates = ["working", "done", "needs-you", "failed", "blocked", "gone"] as const;
export type WorkerState = typeof workerStates[number];
const timestamp = z.string().datetime();
const receiptSchema = dispatchSchema.omit({ prompt: true }).extend({
  id: z.string().uuid(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  computerId: z.string().uuid().optional(),
  state: z.enum(["launching", "sending", "accepted", "uncertain", "failed"]),
  target: remoteTarget.optional(), error: z.string().max(500).optional(),
  granted: z.string().max(200).optional().describe("Scope of the conductor grant that allowed this call."),
  skipped: z.array(z.object({ computer: computerName, reason: z.string().max(200) }).strict()).max(32).optional()
    .describe("Computers left out of anywhere placement, with the reason each could not report capacity."),
  origin: originPaneSchema.extend({ agent: provider, terminal: z.string().min(1).max(200) }).strict().optional()
    .describe("The local agent pane that placed this dispatch; return notices go there."),
  worker: z.object({ state: z.enum(workerStates), since: timestamp, checkedAt: timestamp, sawWorking: z.boolean() }).strict().optional()
    .describe("The worker pane's last observed state."),
  returned: z.object({
    state: z.enum(["done", "needs-you", "failed", "blocked", "gone"]), at: timestamp,
    reply: z.string().max(4000).optional(), error: z.string().max(500).optional(), truncated: z.boolean().optional(), question: z.string().max(200).optional(),
    turn: z.string().regex(/^[a-f0-9]{16}$/).optional(), read: z.boolean(), notifiedAt: timestamp.optional(),
  }).strict().optional().describe("The latest return: the worker finished, needs the owner, failed, is blocked or is gone."),
});
export type Receipt = z.infer<typeof receiptSchema>;
type Skipped = { computer: string; reason: string };

export async function dispatchProjectDirectory(project: unknown): Promise<string> {
  const name = projectName.parse(project);
  const source = readProjectConfig(phrenStoreRoot(), name).sourcePath;
  if (typeof source !== "string" || !path.isAbsolute(source) || /[\x00-\x1f\x7f]/.test(source)) throw new BridgeError(404, "Project has no absolute sourcePath on this computer.");
  const directory = await realpath(source).catch(() => undefined);
  if (!directory || !(await stat(directory)).isDirectory()) throw new BridgeError(404, "Project is not on this computer.");
  return directory;
}

async function save(receipt: Receipt): Promise<void> {
  const root = path.join(bridgeRoot(), "dispatches");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await atomic(path.join(root, `${receipt.id}.json`), receipt);
}

const MAX_RECEIPT_BYTES = 65_536;
let receiptUpdates: Promise<unknown> = Promise.resolve();

/**
 * Change one settled receipt: read it, let `change` edit it, and write it back
 * when `change` returns true. Updates run one at a time in this process, and a
 * receipt still being placed (launching or sending) is never touched.
 */
export function updateReceipt(receiptID: string, change: (receipt: Receipt) => boolean): Promise<Receipt | undefined> {
  const run = receiptUpdates.then(async () => {
    const file = path.join(bridgeRoot(), "dispatches", `${z.string().uuid().parse(receiptID)}.json`);
    const info = await lstat(file).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_RECEIPT_BYTES) return undefined;
    const receipt = receiptSchema.parse(JSON.parse(await readFile(file, "utf8")));
    if (["launching", "sending"].includes(receipt.state)) return undefined;
    if (!change(receipt)) return receipt;
    receipt.updatedAt = new Date().toISOString();
    await atomic(file, receiptSchema.parse(receipt));
    return receipt;
  });
  receiptUpdates = run.catch(() => undefined);
  return run;
}

/** No ledger yet is normal; any other read failure is logged before it reads as empty. */
async function receiptNames(root: string): Promise<string[]> {
  try { return await readdir(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") logger.warn("dispatch", `Could not list dispatch receipts: ${failureReason(error)}`);
    return [];
  }
}

/** One bounded line for a log or a receipt: a Bridge message, an errno code, or the error's first line. */
export function failureReason(error: unknown): string {
  if (error instanceof z.ZodError) return "The remote Hook sent an unexpected reply (protocol mismatch).";
  const code = (error as NodeJS.ErrnoException)?.code;
  const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
  return `${typeof code === "string" && !(error instanceof BridgeError) ? `${code}: ` : ""}${message}`.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
}

export async function dispatchStatus(): Promise<Receipt[]> {
  const root = path.join(bridgeRoot(), "dispatches");
  const names = (await receiptNames(root)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).slice(0, 1024);
  const receipts: Receipt[] = [];
  for (const name of names) {
    try {
      const file = path.join(root, name);
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RECEIPT_BYTES) continue;
      const receipt = receiptSchema.parse(JSON.parse(await readFile(file, "utf8")));
      // A service restart cannot prove whether an in-flight mutation arrived.
      if (["launching", "sending"].includes(receipt.state)) receipt.state = "uncertain";
      receipts.push(receipt);
    } catch { /* Interrupted or old receipts do not become live dispatches. */ }
  }
  return receipts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function capacity(host: DispatchHost): Promise<{ working: number; computerId: string }> {
  const value = await host.request("/v1/dispatch/capacity");
  const result = z.object({ product: z.literal("phren-hook"), protocol: z.literal(PROTOCOL), working: z.number().int().nonnegative(),
    servers: z.array(z.string()), computer: z.object({ id: z.string().uuid() }).passthrough() }).parse(value);
  // This computer places on whichever Herdr server its own Hook runs.
  if (host.local && !result.servers.includes(host.server) && result.servers[0]) host.server = result.servers[0];
  if (!result.servers.includes(host.server)) throw new BridgeError(503, "Herdr is not running on the selected computer. Headless dispatch is not installed yet.");
  return { working: result.working, computerId: result.computer.id };
}

/**
 * A freshly started agent may not have written its session yet when the launch
 * returns, so the launch carries no target. Ask the remote pane for its session
 * for a few seconds before giving up; the pane ids from the launch are enough
 * to find it.
 */
async function settledTarget(peer: DispatchHost, launched: Json, harness: string): Promise<Json | undefined> {
  const workspace = launched.workspaceId, tab = launched.tabId, pane = launched.paneId;
  if (typeof workspace !== "string" || typeof tab !== "string" || typeof pane !== "string") return undefined;
  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1_000));
    try {
      const result = await peer.request(`/v1/workspaces/panes?server=${encodeURIComponent(peer.server)}&groupId=${encodeURIComponent(workspace)}&childId=${encodeURIComponent(tab)}`);
      const found = (Array.isArray(result.panes) ? result.panes : []).find((p: Json) => p && typeof p === "object" && (p as Json).id === pane) as Json | undefined;
      const session = found?.sessionId;
      if (typeof session === "string" && session) return { server: peer.server, workspace, tab, pane, source: harness, session };
    } catch { /* The pane list can lag the launch; try again. */ }
  }
  return undefined;
}

/**
 * Sends the brief. A fresh agent can read `unknown` to Herdr for a while (long
 * on a loaded machine), and the Hook refuses a prompt to such a pane before
 * typing anything. So that refusal is retried while the pane is still
 * unclassified; a pane that is blocked or waiting really needs its terminal,
 * and that refusal stands.
 */
async function sendBrief(peer: DispatchHost, target: Json, text: string): Promise<Json> {
  for (let attempt = 0; ; attempt++) {
    try { return await peer.request("/v1/prompt", { target, text }); } catch (error) {
      const unsettled = error instanceof BridgeError && error.status === 409 && /needs input in the terminal first/.test(error.message);
      if (!unsettled || attempt >= 20) throw error;
      const panes = await peer.request(`/v1/workspaces/panes?server=${encodeURIComponent(peer.server)}&groupId=${encodeURIComponent(String(target.workspace))}&childId=${encodeURIComponent(String(target.tab))}`).catch(() => undefined);
      const pane = (Array.isArray(panes?.panes) ? panes.panes : []).find((p: Json) => p && typeof p === "object" && (p as Json).id === target.pane) as Json | undefined;
      const status = pane?.agentStatus;
      if (typeof status === "string" && ["blocked", "waiting"].includes(status)) throw error;
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
  }
}

export interface DispatchIdentity {
  computerID: string;
  validateParentTarget: (target: Target) => Promise<unknown>;
  /** The agent and terminal running in a local pane, or undefined when the pane has no agent. */
  originAgent?: (pane: OriginPane) => Promise<{ agent: Provider; terminal: string } | undefined>;
}

export class DispatchService {
  private active = false;
  /** `local` is this computer as a dispatch destination (its own Hook's
   * socket); tests replace it so they never reach a real Hook. */
  constructor(private readonly identity?: DispatchIdentity, private readonly local: () => DispatchHost = () => localHost()) {}
  /** `originValue` is the local pane the request came from, as its agent's
   * Herdr variables name it; a pane without a running agent is left out. */
  async dispatch(input: unknown, originValue?: unknown): Promise<Json> {
    const data = dispatchSchema.parse(input);
    if (this.active) throw new BridgeError(429, "A dispatch is already being placed. Try again after its receipt arrives.");
    this.active = true;
    try {
      if (data.parent !== undefined || data.parentTarget !== undefined) {
        if (!this.identity) throw new BridgeError(503, "This Hook cannot validate a dispatch parent.");
        await validateDispatchParent(data, this.identity.computerID, this.identity.validateParentTarget);
      }
      if ((await receiptNames(path.join(bridgeRoot(), "dispatches"))).length >= 1024) throw new BridgeError(429, "Dispatch history is full. Archive old receipts before dispatching again.");
      // This computer needs no hooks.yaml entry, so a missing file only
      // matters when the dispatch names another computer.
      const here = this.local();
      const toLocal = data.computer !== "anywhere" && isLocalComputer(data.computer, here.names);
      const enrolled = await hookPeers().catch(error => { if (toLocal || data.computer === "anywhere") return []; throw error; });
      const peers: DispatchHost[] = [...enrolled.map(candidate => peerHost(candidate)), here];
      let peer: DispatchHost | undefined;
      let remoteComputerID: string | undefined;
      const skipped: Skipped[] = [];
      if (data.computer === "anywhere") {
        const available = await Promise.all(peers.map(async candidate => {
          try { return { peer: candidate, ...await capacity(candidate) }; } catch (error) {
            // A peer that cannot report capacity sits out this placement, and the receipt says why.
            skipped.push({ computer: candidate.name, reason: failureReason(error) });
            return undefined;
          }
        }));
        skipped.sort((a, b) => a.computer.localeCompare(b.computer));
        const selected = available.filter((item): item is NonNullable<typeof item> => !!item)
          .sort((a, b) => a.working - b.working || a.peer.name.localeCompare(b.peer.name))[0];
        peer = selected?.peer;
        remoteComputerID = selected?.computerId;
        if (!peer) throw new BridgeError(503, "No enrolled computer with a running Herdr is connected.", skipped.length ? { skipped } : undefined);
      } else {
        peer = toLocal ? peers.find(candidate => candidate.local) : peers.find(candidate => !candidate.local && candidate.name === data.computer);
        if (!peer) throw new BridgeError(404, "Unknown computer. Add its verified connection to hooks.yaml.");
        remoteComputerID = (await capacity(peer)).computerId;
      }
      const grant = matchGrant(await listGrants(), { action: "dispatch", project: data.project, computer: peer.name });
      const origin = await this.origin(originValue);
      // Prompts are sent over the pipe, never stored in the dispatch ledger.
      const { prompt, ...metadata } = data;
      const receipt: Receipt = { ...metadata, computer: peer.name, computerId: remoteComputerID!, id: randomUUID(),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: "launching",
        ...(grant ? { granted: grantLabel(grant) } : {}), ...(skipped.length ? { skipped } : {}), ...(origin ? { origin } : {}) };
      await save(receipt);
      try {
        const launched = await peer.request(`/v1/workspaces/launch?server=${encodeURIComponent(peer.server)}`,
          { project: data.project, kind: data.harness, model: data.model, label: data.label });
        const target = remoteTarget.parse(launched.target ?? await settledTarget(peer, launched, data.harness));
        if (target.source !== data.harness || target.server !== peer.server) throw new BridgeError(502, "The remote Hook returned a different launch target.");
        receipt.target = target;
        receipt.state = "sending"; receipt.updatedAt = new Date().toISOString(); await save(receipt);
        const result = await sendBrief(peer, receipt.target, prompt);
        receipt.state = result.ok === true && result.deliveryUncertain !== true ? "accepted" : "uncertain";
      } catch (error) {
        receipt.state = receipt.state === "launching" && error instanceof BridgeError && [400, 404, 429].includes(error.status) ? "failed" : "uncertain";
        receipt.error = error instanceof BridgeError ? error.message.slice(0, 500) : "Remote delivery was not confirmed. Inspect this dispatch before retrying.";
      }
      receipt.updatedAt = new Date().toISOString(); await save(receipt);
      return { ok: receipt.state === "accepted", ...receipt };
    } finally { this.active = false; }
  }

  private async origin(value: unknown): Promise<Receipt["origin"]> {
    const pane = originPaneSchema.safeParse(value);
    if (!pane.success || !this.identity?.originAgent) return undefined;
    const running = await this.identity.originAgent(pane.data).catch(() => undefined);
    return running ? { ...pane.data, ...running } : undefined;
  }
}

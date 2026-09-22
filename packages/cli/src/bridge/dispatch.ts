import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { readProjectConfig } from "../project-config.js";
import { computerName } from "./computers.js";
import { dispatchParentSchema, validateDispatchParent } from "./dispatch-tree.js";
import { grantLabel, listGrants, matchGrant } from "./grants.js";
import { hookPeers, peerRequest, type HookPeer } from "./peers.js";
import { BridgeError, bridgeRoot, PROTOCOL, startingTargetSchema, targetSchema, type Json, type Target } from "./protocol.js";
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
const receiptSchema = dispatchSchema.omit({ prompt: true }).extend({
  id: z.string().uuid(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  computerId: z.string().uuid().optional(),
  state: z.enum(["launching", "sending", "accepted", "uncertain", "failed"]),
  target: remoteTarget.optional(), error: z.string().max(500).optional(),
  granted: z.string().max(200).optional().describe("Scope of the conductor grant that allowed this call."),
});
type Receipt = z.infer<typeof receiptSchema>;

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
  const file = path.join(root, `${receipt.id}.json`), temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(receipt), { mode: 0o600 }); await rename(temporary, file);
}

export async function dispatchStatus(): Promise<Receipt[]> {
  const root = path.join(bridgeRoot(), "dispatches");
  const names = (await readdir(root).catch(() => [])).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).slice(0, 1024);
  const receipts: Receipt[] = [];
  for (const name of names) {
    try {
      const file = path.join(root, name);
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) continue;
      const receipt = receiptSchema.parse(JSON.parse(await readFile(file, "utf8")));
      // A service restart cannot prove whether an in-flight mutation arrived.
      if (["launching", "sending"].includes(receipt.state)) receipt.state = "uncertain";
      receipts.push(receipt);
    } catch { /* Interrupted or old receipts do not become live dispatches. */ }
  }
  return receipts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function capacity(peer: HookPeer): Promise<{ working: number; computerId: string }> {
  const value = await peerRequest(peer, "/v1/dispatch/capacity");
  const result = z.object({ product: z.literal("phren-hook"), protocol: z.literal(PROTOCOL), working: z.number().int().nonnegative(),
    servers: z.array(z.string()), computer: z.object({ id: z.string().uuid() }).passthrough() }).parse(value);
  if (!result.servers.includes(peer.server)) throw new BridgeError(503, "Herdr is not running on the selected computer. Headless dispatch is not installed yet.");
  return { working: result.working, computerId: result.computer.id };
}

/**
 * A freshly started agent may not have written its session yet when the launch
 * returns, so the launch carries no target. Ask the remote pane for its session
 * for a few seconds before giving up; the pane ids from the launch are enough
 * to find it.
 */
async function settledTarget(peer: HookPeer, launched: Json, harness: string): Promise<Json | undefined> {
  const workspace = launched.workspaceId, tab = launched.tabId, pane = launched.paneId;
  if (typeof workspace !== "string" || typeof tab !== "string" || typeof pane !== "string") return undefined;
  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1_000));
    try {
      const result = await peerRequest(peer, `/v1/workspaces/panes?server=${encodeURIComponent(peer.server)}&groupId=${encodeURIComponent(workspace)}&childId=${encodeURIComponent(tab)}`);
      const found = (Array.isArray(result.panes) ? result.panes : []).find((p: Json) => p && typeof p === "object" && (p as Json).id === pane) as Json | undefined;
      const session = found?.sessionId;
      if (typeof session === "string" && session) return { server: peer.server, workspace, tab, pane, source: harness, session };
    } catch { /* The pane list can lag the launch; try again. */ }
  }
  return undefined;
}

export class DispatchService {
  private active = false;
  constructor(private readonly identity?: { computerID: string; validateParentTarget: (target: Target) => Promise<unknown> }) {}
  async dispatch(input: unknown): Promise<Json> {
    const data = dispatchSchema.parse(input);
    if (this.active) throw new BridgeError(429, "A dispatch is already being placed. Try again after its receipt arrives.");
    this.active = true;
    try {
      if (data.parent !== undefined || data.parentTarget !== undefined) {
        if (!this.identity) throw new BridgeError(503, "This Hook cannot validate a dispatch parent.");
        await validateDispatchParent(data, this.identity.computerID, this.identity.validateParentTarget);
      }
      if ((await readdir(path.join(bridgeRoot(), "dispatches")).catch(() => [])).length >= 1024) throw new BridgeError(429, "Dispatch history is full. Archive old receipts before dispatching again.");
      const peers = await hookPeers();
      let peer: HookPeer | undefined;
      let remoteComputerID: string | undefined;
      if (data.computer === "anywhere") {
        const available = await Promise.all(peers.map(async candidate => {
          try { return { peer: candidate, ...await capacity(candidate) }; } catch { return undefined; }
        }));
        const selected = available.filter((item): item is NonNullable<typeof item> => !!item)
          .sort((a, b) => a.working - b.working || a.peer.name.localeCompare(b.peer.name))[0];
        peer = selected?.peer;
        remoteComputerID = selected?.computerId;
        if (!peer) throw new BridgeError(503, "No enrolled computer with a running Herdr is connected.");
      } else {
        peer = peers.find(candidate => candidate.name === data.computer);
        if (!peer) throw new BridgeError(404, "Unknown computer. Add its verified connection to hooks.yaml.");
        remoteComputerID = (await capacity(peer)).computerId;
      }
      const grant = matchGrant(await listGrants(), { action: "dispatch", project: data.project, computer: peer.name });
      // Prompts are sent over the pipe, never stored in the dispatch ledger.
      const { prompt, ...metadata } = data;
      const receipt: Receipt = { ...metadata, computer: peer.name, computerId: remoteComputerID!, id: randomUUID(),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: "launching",
        ...(grant ? { granted: grantLabel(grant) } : {}) };
      await save(receipt);
      try {
        const launched = await peerRequest(peer, `/v1/workspaces/launch?server=${encodeURIComponent(peer.server)}`,
          { project: data.project, kind: data.harness, model: data.model, label: data.label });
        const target = remoteTarget.parse(launched.target ?? await settledTarget(peer, launched, data.harness));
        if (target.source !== data.harness || target.server !== peer.server) throw new BridgeError(502, "The remote Hook returned a different launch target.");
        receipt.target = target;
        receipt.state = "sending"; receipt.updatedAt = new Date().toISOString(); await save(receipt);
        const result = await peerRequest(peer, "/v1/prompt", { target: receipt.target, text: prompt });
        receipt.state = result.ok === true && result.deliveryUncertain !== true ? "accepted" : "uncertain";
      } catch (error) {
        receipt.state = receipt.state === "launching" && error instanceof BridgeError && [400, 404, 429].includes(error.status) ? "failed" : "uncertain";
        receipt.error = error instanceof BridgeError ? error.message.slice(0, 500) : "Remote delivery was not confirmed. Inspect this dispatch before retrying.";
      }
      receipt.updatedAt = new Date().toISOString(); await save(receipt);
      return { ok: receipt.state === "accepted", ...receipt };
    } finally { this.active = false; }
  }
}

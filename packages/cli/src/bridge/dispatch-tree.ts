import { createHash } from "node:crypto";
import { z } from "zod";
import { computerName } from "./computers.js";
import { BridgeError, object, provider, sessionId, targetSchema, type Json, type Target } from "./protocol.js";
import type { ChildAgentRelation } from "./transcripts.js";

const computerID = z.string().uuid();
const dispatchID = z.string().uuid();
const childID = z.string().regex(/^[a-f0-9]{32}$/);

export const dispatchParentSchema = z.object({
  provider,
  session: sessionId,
  computer: computerID,
}).strict();
export type DispatchParent = z.infer<typeof dispatchParentSchema>;

export interface DispatchParentInput {
  parent?: unknown;
  parentTarget?: unknown;
}

/** Parent metadata is optional as a pair. When present it must name this Hook
 * and the exact live conversation target the caller supplied. */
export async function validateDispatchParent(
  input: DispatchParentInput,
  localComputer: string,
  validateTarget: (target: Target) => Promise<unknown>,
): Promise<{ parent?: DispatchParent; parentTarget?: Target }> {
  const hasParent = input.parent !== undefined, hasTarget = input.parentTarget !== undefined;
  if (hasParent !== hasTarget) throw new BridgeError(400, "Supply both parent and parentTarget, or omit both.");
  if (!hasParent) return {};
  const parent = dispatchParentSchema.parse(input.parent);
  const parentTarget = targetSchema.parse(input.parentTarget);
  if (parent.computer !== computerID.parse(localComputer)) throw new BridgeError(403, "The dispatch parent belongs to a different computer.");
  if (parent.provider !== parentTarget.source || parent.session !== parentTarget.session) {
    throw new BridgeError(400, "The dispatch parent does not match parentTarget.");
  }
  await validateTarget(parentTarget);
  return { parent, parentTarget };
}

export interface DispatchTreeReceipt {
  readonly id: string;
  readonly computer: string;
  readonly computerId?: string;
  readonly remoteComputer?: unknown;
  readonly label: string;
  readonly model?: string;
  readonly state: string;
  readonly target?: unknown;
  readonly parent?: unknown;
  readonly parentTarget?: unknown;
  readonly status?: string;
  readonly completedAt?: string;
}

export interface RemoteDispatchSnapshot {
  readonly dispatchId?: string;
  readonly available?: boolean;
  readonly state?: "running" | "completed" | "unavailable";
  readonly target?: unknown;
  readonly computer?: unknown;
  readonly agents?: readonly unknown[];
  readonly children?: readonly unknown[];
}

export type RemoteSnapshotReader = (receipt: DispatchTreeReceipt) =>
  RemoteDispatchSnapshot | undefined | Promise<RemoteDispatchSnapshot | undefined>;
export type RemoteSnapshotSource = RemoteSnapshotReader
  | ReadonlyMap<string, RemoteDispatchSnapshot | undefined>
  | Readonly<Record<string, RemoteDispatchSnapshot | undefined>>
  | readonly RemoteDispatchSnapshot[]
  | RemoteDispatchSnapshot
  | undefined;

type PublicComputer = { id: string; name: string };
type PublicRemote = { target: Target; child?: string };
type ProjectionState = { count: number; seen: Set<string> };

const sameTarget = (left: Target, right: Target) =>
  left.server === right.server && left.workspace === right.workspace && left.tab === right.tab
  && left.pane === right.pane && left.source === right.source && left.session === right.session;

function publicID(parent: DispatchParent, computer: string, dispatch: string, descendant: string): string {
  return createHash("sha256").update(`${parent.provider}\0${parent.session}\0${computer}\0${dispatch}\0${descendant}`)
    .digest("hex").slice(0, 32);
}

function publicLabel(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return;
  return /^(?:[/\\]|[A-Za-z]:[/\\]|~[/\\])/.test(value) ? "Agent" : value;
}

function sameParent(value: unknown, parent: DispatchParent): boolean {
  const parsed = dispatchParentSchema.safeParse(value);
  return parsed.success && parsed.data.provider === parent.provider && parsed.data.session === parent.session
    && parsed.data.computer === parent.computer;
}

function parentTargetMatches(value: unknown, parent: DispatchParent): boolean {
  const parsed = targetSchema.safeParse(value);
  return parsed.success && parsed.data.source === parent.provider && parsed.data.session === parent.session;
}

function directSnapshot(source: RemoteSnapshotSource): RemoteDispatchSnapshot | undefined {
  if (!source || typeof source !== "object" || Array.isArray(source) || source instanceof Map) return;
  const value = source as RemoteDispatchSnapshot;
  return value.available !== undefined || value.state !== undefined || value.target !== undefined
    || value.computer !== undefined || value.agents !== undefined || value.children !== undefined ? value : undefined;
}

async function snapshotFor(source: RemoteSnapshotSource, receipt: DispatchTreeReceipt): Promise<RemoteDispatchSnapshot | undefined> {
  try {
    if (source === undefined) return;
    if (typeof source === "function") return await source(receipt);
    if (source instanceof Map) return source.get(receipt.id);
    if (Array.isArray(source)) return source.find(item => item.dispatchId === receipt.id);
    const direct = directSnapshot(source);
    if (direct) return direct;
    return Object.prototype.hasOwnProperty.call(source, receipt.id)
      ? (source as Readonly<Record<string, RemoteDispatchSnapshot | undefined>>)[receipt.id] : undefined;
  } catch { return; }
}

function snapshotMatches(snapshot: RemoteDispatchSnapshot, target: Target, computer: PublicComputer): boolean {
  if (snapshot.target !== undefined) {
    const parsed = targetSchema.safeParse(snapshot.target);
    if (!parsed.success || !sameTarget(parsed.data, target)) return false;
  }
  if (snapshot.computer !== undefined) {
    const parsed = z.object({ id: computerID, name: computerName }).strict().safeParse(snapshot.computer);
    if (!parsed.success || parsed.data.id !== computer.id) return false;
  }
  return true;
}

function destination(raw: Json, fallbackComputer: PublicComputer, fallbackTarget: Target): { computer: PublicComputer; remote: PublicRemote } | undefined {
  const suppliedComputer = raw.computer !== undefined, suppliedRemote = raw.remote !== undefined;
  if (!suppliedComputer && !suppliedRemote) {
    const id = childID.safeParse(raw.id);
    return id.success ? { computer: fallbackComputer, remote: { target: fallbackTarget, child: id.data } } : undefined;
  }
  if (!suppliedComputer || !suppliedRemote) return;
  const computer = z.object({ id: computerID, name: computerName }).strict().safeParse(raw.computer);
  const remoteRaw = object(raw.remote), target = targetSchema.safeParse(remoteRaw.target);
  const child = remoteRaw.child === undefined ? undefined : childID.safeParse(remoteRaw.child);
  if (!computer.success || !target.success || (child !== undefined && !child.success)) return;
  return { computer: computer.data, remote: { target: target.data, ...(child?.success ? { child: child.data } : {}) } };
}

function projectAgents(
  values: readonly unknown[],
  parent: DispatchParent,
  receipt: DispatchTreeReceipt,
  fallbackComputer: PublicComputer,
  fallbackTarget: Target,
  depth: number,
  state: ProjectionState,
  lineage = "",
): ChildAgentRelation[] {
  if (depth > 4 || state.count >= 128) return [];
  const projected: ChildAgentRelation[] = [];
  for (const value of values.slice(0, 128)) {
    if (state.count >= 128) break;
    const raw = object(value), id = childID.safeParse(raw.id), source = provider.safeParse(raw.provider);
    const path = publicLabel(raw.path);
    const callId = typeof raw.callId === "string" && raw.callId.length > 0 && raw.callId.length <= 200 ? raw.callId : undefined;
    const routed = destination(raw, fallbackComputer, fallbackTarget);
    if (!id.success || !source.success || !path || !callId || !routed) continue;
    const descendant = lineage ? `${lineage}/${id.data}` : id.data;
    const nestedSession = sessionId.safeParse(raw.session);
    const cycleIdentity = nestedSession.success ? nestedSession.data
      : routed.remote.child ?? routed.remote.target.session;
    const cycleKey = `${routed.computer.id}\0${source.data}\0${cycleIdentity}`;
    if (state.seen.has(cycleKey)) continue;
    state.seen.add(cycleKey); state.count++;
    const childState = ["running", "completed", "unavailable"].includes(String(raw.state))
      ? raw.state as ChildAgentRelation["state"] : "unavailable";
    const children = Array.isArray(raw.children)
      ? projectAgents(raw.children, parent, receipt, fallbackComputer, fallbackTarget, depth + 1, state, descendant) : [];
    projected.push({
      id: publicID(parent, routed.computer.id, receipt.id, descendant),
      provider: source.data,
      path,
      callId,
      state: childState,
      ...(typeof raw.model === "string" && raw.model.length > 0 && raw.model.length <= 200 ? { model: raw.model } : {}),
      ...(typeof raw.worktreeName === "string" && raw.worktreeName.length > 0 && raw.worktreeName.length <= 200
        && !/[/\\]/.test(raw.worktreeName) ? { worktreeName: raw.worktreeName } : {}),
      ...(typeof raw.branch === "string" && raw.branch.length > 0 && raw.branch.length <= 200 ? { branch: raw.branch } : {}),
      computer: routed.computer,
      remote: routed.remote,
      children,
    });
  }
  return projected;
}

/** Project this conductor's durable outbound receipts into remote work-tree
 * rows. Snapshot readers are GET-only adapters; missing or rejected snapshots
 * keep the lead visible as unavailable. */
export async function remoteChildren(
  parentValue: DispatchParent,
  receipts: readonly DispatchTreeReceipt[],
  remoteSnapshot: RemoteSnapshotSource,
): Promise<ChildAgentRelation[]> {
  const parent = dispatchParentSchema.parse(parentValue);
  const state: ProjectionState = {
    count: 0,
    seen: new Set([`${parent.computer}\0${parent.provider}\0${parent.session}`]),
  };
  const children: ChildAgentRelation[] = [];
  for (const receipt of receipts) {
    if (state.count >= 128 || receipt.state === "failed" || !dispatchID.safeParse(receipt.id).success
        || !sameParent(receipt.parent, parent) || !parentTargetMatches(receipt.parentTarget, parent)) continue;
    const storedComputer = z.object({ id: computerID, name: computerName }).strict().safeParse(receipt.remoteComputer);
    const target = targetSchema.safeParse(receipt.target);
    const id = computerID.safeParse(receipt.computerId ?? (storedComputer.success ? storedComputer.data.id : undefined));
    const name = computerName.safeParse(storedComputer.success ? storedComputer.data.name : receipt.computer);
    if (!target.success || !id.success || !name.success) continue;
    const cycleKey = `${id.data}\0${target.data.source}\0${target.data.session}`;
    if (state.seen.has(cycleKey)) continue;
    state.seen.add(cycleKey); state.count++;
    const computer = { id: id.data, name: name.data };
    const snapshot = await snapshotFor(remoteSnapshot, receipt);
    const available = snapshot !== undefined && snapshot.available !== false && snapshotMatches(snapshot, target.data, computer);
    const completed = receipt.state === "completed" || receipt.status === "completed" || receipt.completedAt !== undefined
      || snapshot?.state === "completed";
    const snapshotAgents = snapshot?.agents ?? snapshot?.children;
    const projected = available && Array.isArray(snapshotAgents)
      ? projectAgents(snapshotAgents, parent, receipt, computer, target.data, 2, state) : [];
    children.push({
      id: publicID(parent, computer.id, receipt.id, "lead"),
      provider: target.data.source,
      path: receipt.label.slice(0, 200),
      callId: `dispatch:${receipt.id}`,
      state: completed ? "completed" : available ? "running" : "unavailable",
      ...(receipt.model !== undefined ? { model: receipt.model.slice(0, 200) } : {}),
      computer,
      remote: { target: target.data },
      children: projected,
    });
  }
  return children;
}

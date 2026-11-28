import { hostname } from "node:os";
import { BridgeError, type Json, object, objects } from "./protocol.js";
import { peerRead } from "./peer-reads.js";
import { hookPeers, peerRequest } from "./peers.js";
import { inboxWire, ownerInboxSchema, pasteCommand, type OwnerInbox } from "./owner-inbox.js";
import { isLocalComputer } from "./dispatch-hosts.js";
import { ownerInboxKey } from "./owner-inbox-key.js";

/** What the phone's list and a notification need. Everything else a Hook
 * computes for its own screen (commands, paste, dispatch links, live
 * bookkeeping, history) stays on the Hook. */
const COMPACT_FIELDS = ["id", "title", "kind", "state", "createdAt", "updatedAt", "inboxComputer", "project", "computer", "target"] as const;
/** Keys peer aggregation filters and dedupes on. Kept in the peer exchange,
 * never in what a phone reads. */
const RECONCILE_FIELDS = ["live", "source", "actionId"] as const;

/** The phone gives one aggregate read ten seconds, so a compact peer read gets
 * six: a slow Hook lands in `unreachable` while the others' rows stay. */
export const COMPACT_PEER_TIMEOUT_MS = 6_000;

/** A compact item: the fields above, and nothing an older or newer peer added.
 * `reconcile` keeps the aggregation keys, for a Hook reading another Hook.
 * `issues` adds the structured issue link for a reader that asked for it; every
 * other reader gets the link appended to the title instead (see `inboxWire`). */
export function compactInboxItem(item: Json, reconcile = false, issues = false): Json {
  const wire = inboxWire(item, issues);
  const compact: Json = {};
  for (const field of COMPACT_FIELDS) if (wire[field] !== undefined) compact[field] = wire[field];
  if (reconcile) for (const field of RECONCILE_FIELDS) if (wire[field] !== undefined) compact[field] = wire[field];
  if (issues && wire.issue !== undefined) compact.issue = wire.issue;
  return compact;
}

/** The paste must send the resolve to the Hook that owns this row. */
function placed(item: Json, inboxComputer: string): Json {
  const { id, command, updatedAt } = item;
  return item.kind === "manual" && typeof id === "string" && typeof command === "string" && typeof updatedAt === "string"
    ? { ...item, inboxComputer, paste: pasteCommand({ id, command, updatedAt }, inboxComputer) }
    : { ...item, inboxComputer };
}

/** Aggregate each Hook's own inbox once, without recursively listing peers.
 * inboxComputer identifies the Hook to send a resolution to; computer on a
 * dispatch row names the worker and can be a different computer.
 *
 * `compact` asks for the phone's wire item. It is sent to peers too, but every
 * read is projected again here: an older peer ignores it and answers in full,
 * and a newer peer may add fields this build does not know.
 *
 * A compact peer read also carries `reconcile=1`, which keeps the keys the
 * aggregation below filters and dedupes on (live, source, actionId); they are
 * stripped again before the phone sees the aggregate. A Hook answering its own
 * `?local=1&compact=1&reconcile=1` read keeps them for the same reason. */
export async function ownerInboxView(inbox: OwnerInbox, input: unknown, localOnly = false, compact = false, reconcile = false): Promise<Json> {
  const data = ownerInboxSchema.parse(input);
  const { computer, ...local } = data;
  const issues = data.issues === true;
  const peers = await hookPeers().catch(() => []);
  // `issues=1` is a query flag: an older Hook ignores it and answers in full.
  const localList = `/v1/owner-inbox?local=1${data.includeResolved ? "&includeResolved=true" : ""}${compact ? "&compact=1" : ""}${issues ? "&issues=1" : ""}`;
  const peerList = compact ? `${localList}&reconcile=1` : localList;
  const options = compact ? { timeout: COMPACT_PEER_TIMEOUT_MS } : undefined;
  const project = (items: Json[], withReconciliation = false) => compact ? items.map(item => compactInboxItem(item, withReconciliation, issues)) : items.map(item => inboxWire(item, issues));
  if (computer && computer !== "local" && !isLocalComputer(computer)) {
    const peer = peers.find(peer => peer.name === computer);
    if (!peer) throw new BridgeError(404, "That inbox computer is not linked.");
    if (local.action === "list") {
      const view = await peerRead(peer, localList, options);
      return { ...view, items: project(objects(view.items).map(item => placed(item, computer))), unreachable: [] };
    }
    const needsActions = local.command !== undefined || local.pr !== undefined || local.key !== undefined || local.ifUpdatedAt !== undefined;
    const needsIssues = local.issue !== undefined;
    if (needsActions || needsIssues) {
      const health = await peerRequest(peer, "/v1/health", undefined, 5_000);
      const supported = object(health.capabilities);
      if (needsActions && supported.ownerInboxActions !== true) {
        throw new BridgeError(409, `Upgrade the Hook on ${computer} to use inbox commands, PR links, keys or guarded resolves.`, { code: "owner-inbox-actions-unsupported" });
      }
      if (needsIssues && supported.ownerInboxIssues !== true) {
        throw new BridgeError(409, `Upgrade the Hook on ${computer} to link an inbox item to an issue.`, { code: "owner-inbox-issues-unsupported" });
      }
    }
    // `issues` is this Hook's answer shape, not a field an older peer's strict
    // schema accepts; the answer is shaped here instead, and the peer is asked
    // through its query flag (an older peer ignores it).
    const { issues: _issues, ...peerBody } = local;
    const result = await peerRequest(peer, `/v1/owner-inbox${issues ? "?issues=1" : ""}`, peerBody);
    const item = object(result.item);
    const answer = local.action === "add" ? placed(item, computer) : { ...item, inboxComputer: computer };
    return { ...result, item: inboxWire(answer, issues) };
  }
  const result = await inbox.run(local);
  if (data.action !== "list") return result;
  if (localOnly) return compact ? { ...result, items: project(objects(result.items), reconcile) } : result;
  const items: Json[] = objects(result.items).map(item => placed(item, "local")), unreachable: Json[] = [];
  await Promise.all(peers.map(async peer => {
    try {
      // No kept answer: the owner resolves a row and reads the list straight back.
      const view = await peerRead(peer, peerList, options);
      items.push(...objects(view.items).map(item => placed(item, peer.name)));
    } catch (error) { unreachable.push({ computer: peer.name, error: error instanceof Error ? error.message : "Unreachable." }); }
  }));
  // Older peers can still send stale automatic rows during a rolling upgrade.
  // A dispatching Hook and the worker's Hook may also describe the same ask.
  const seen = new Set<string>();
  const current = items.filter(item => {
    if (data.includeResolved || item.kind === "manual") return true;
    if (item.live !== true || item.state !== "open") return false;
    const computer = String(item.computer ?? item.inboxComputer);
    const key = ownerInboxKey(item, item.target && isLocalComputer(computer) ? hostname() : computer);
    if (key === undefined) return true;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  return { ok: true, items: project(current), unreachable };
}

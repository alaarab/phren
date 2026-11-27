import { BridgeError, type Json, object, objects } from "./protocol.js";
import { peerRead } from "./peer-reads.js";
import { hookPeers, peerRequest } from "./peers.js";
import { ownerInboxSchema, pasteCommand, type OwnerInbox } from "./owner-inbox.js";
import { isLocalComputer } from "./dispatch-hosts.js";

/** What the phone's list and a notification need. Everything else a Hook
 * computes for its own screen (commands, paste, dispatch links, live
 * bookkeeping, history) stays on the Hook. */
const COMPACT_FIELDS = ["id", "title", "kind", "state", "createdAt", "updatedAt", "inboxComputer", "project", "computer", "target"] as const;

/** A compact item: the fields above, and nothing an older or newer peer added. */
export function compactInboxItem(item: Json): Json {
  const compact: Json = {};
  for (const field of COMPACT_FIELDS) if (item[field] !== undefined) compact[field] = item[field];
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
 * and a newer peer may add fields this build does not know. */
export async function ownerInboxView(inbox: OwnerInbox, input: unknown, localOnly = false, compact = false): Promise<Json> {
  const data = ownerInboxSchema.parse(input);
  const { computer, ...local } = data;
  const peers = await hookPeers().catch(() => []);
  const localList = `/v1/owner-inbox?local=1${data.includeResolved ? "&includeResolved=true" : ""}${compact ? "&compact=1" : ""}`;
  const project = (items: Json[]) => compact ? items.map(compactInboxItem) : items;
  if (computer && computer !== "local" && !isLocalComputer(computer)) {
    const peer = peers.find(peer => peer.name === computer);
    if (!peer) throw new BridgeError(404, "That inbox computer is not linked.");
    if (local.action === "list") {
      const view = await peerRead(peer, localList);
      return { ...view, items: project(objects(view.items).map(item => placed(item, computer))), unreachable: [] };
    }
    if (local.command !== undefined || local.task !== undefined || local.pr !== undefined || local.key !== undefined || local.ifUpdatedAt !== undefined) {
      const health = await peerRequest(peer, "/v1/health", undefined, 5_000);
      if (object(health.capabilities).ownerInboxActions !== true) {
        throw new BridgeError(409, `Upgrade the Hook on ${computer} to use inbox commands, task or PR links, keys or guarded resolves.`, { code: "owner-inbox-actions-unsupported" });
      }
    }
    const result = await peerRequest(peer, "/v1/owner-inbox", local);
    const item = object(result.item);
    return { ...result, item: local.action === "add" ? placed(item, computer) : { ...item, inboxComputer: computer } };
  }
  const result = await inbox.run(local);
  if (data.action !== "list") return result;
  if (localOnly) return compact ? { ...result, items: project(objects(result.items)) } : result;
  const items: Json[] = objects(result.items).map(item => placed(item, "local")), unreachable: Json[] = [];
  await Promise.all(peers.map(async peer => {
    try {
      // No kept answer: the owner resolves a row and reads the list straight back.
      const view = await peerRead(peer, localList);
      items.push(...objects(view.items).map(item => placed(item, peer.name)));
    } catch (error) { unreachable.push({ computer: peer.name, error: error instanceof Error ? error.message : "Unreachable." }); }
  }));
  // Older peers can still send stale automatic rows during a rolling upgrade.
  // A dispatching Hook and the worker's Hook may also describe the same ask.
  const seen = new Set<string>();
  const current = items.filter(item => {
    if (data.includeResolved || item.kind === "manual") return true;
    if (item.live !== true || item.state !== "open") return false;
    const t = item.target as Json | undefined;
    if (!t) {
      // Computers share the synced store, so two Hooks can list the same unclaimed stale task.
      if (typeof item.source === "string" && item.source.startsWith("task-stale:")) {
        if (seen.has(item.source)) return false;
        seen.add(item.source);
      }
      return true;
    }
    const computer = String(item.computer ?? item.inboxComputer);
    const key = JSON.stringify([isLocalComputer(computer) ? "local" : computer, t.server, t.workspace, t.tab, t.pane,
      t.source, t.session ?? t.startingToken, item.actionId ?? "waiting"]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  return { ok: true, items: project(current), unreachable };
}

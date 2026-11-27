import type { Json } from "./protocol.js";

/** The identity shared by independently materialized rows in the open Inbox. */
export function ownerInboxKey(item: Json, computer: string): string | undefined {
  if (item.kind === "manual") return undefined;
  const target = item.target as Json | undefined;
  if (target) {
    return JSON.stringify([computer.toLowerCase(), target.server, target.workspace, target.tab, target.pane,
      target.source, target.session ?? target.startingToken, item.actionId ?? "waiting"]);
  }
  if (typeof item.source === "string" && item.source.startsWith("task-stale:")) return item.source;
}

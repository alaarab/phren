import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { BridgeError, type Json } from "./protocol.js";
import { intervalFromEnv } from "./limits.js";

/**
 * The terminal's way through owner proof (owner-proof.ts). Once a phone has
 * signed, an unsigned owner-only request is refused, and the owner's own
 * terminal cannot sign. A terminal command that sends
 * `X-Phren-Owner-Confirm: wait` is held instead: the request appears on the
 * phone (`GET /v1/owner-confirms`, or the overview socket's `ownerConfirms`
 * frame when it asks with `confirms=1`) and goes ahead only when the phone
 * answers `POST /v1/owner-confirms/answer` with approve, a request the phone
 * signs like any owner action. An agent can ask the same way, but only the
 * owner's phone can say yes, and the card names the exact action.
 */

export const OWNER_CONFIRM_HEADER = "x-phren-owner-confirm";
export const OWNER_CONFIRM_HOLD_MS = intervalFromEnv("PHREN_OWNER_CONFIRM_TIMEOUT_MS", 120_000, 1_000, 600_000);
/** Held requests at once; more are refused, so an agent cannot flood the phone. */
export const MAX_OWNER_CONFIRMS = 4;

export interface OwnerConfirmView {
  id: string; kind: "owner-confirm"; computer: string;
  /** One plain sentence: what goes ahead on approve. */
  title: string;
  detail?: string;
  /** `METHOD /path` of the held request. */
  route: string;
  askedAt: string; expiresAt: string;
}

const text = (value: unknown, max = 120) => typeof value === "string" && value.trim() ? value.trim().replace(/[\x00-\x1f\x7f]/g, " ").slice(0, max) : undefined;
const count = (value: unknown) => Array.isArray(value) ? value.length : 0;

/** What the phone shows for a held request; undefined for routes the terminal may not confirm this way. */
export function describeOwnerAction(method: string, pathname: string, data: Json): { title: string; detail?: string } | undefined {
  const project = text(data.project);
  switch (`${method} ${pathname}`) {
    case "POST /v1/conductor/make": return { title: "Make a conductor on this computer", ...(text(data.paneId) ? { detail: `Pane ${text(data.paneId)}` } : {}) };
    case "POST /v1/conductor/stop": return { title: "Stop the conductor on this computer", ...(text(data.paneId) ? { detail: `Pane ${text(data.paneId)}` } : {}) };
    case "POST /v1/housekeeping/approve": return { title: `Apply ${count(data.ids)} housekeeping action${count(data.ids) === 1 ? "" : "s"}`, detail: (Array.isArray(data.ids) ? data.ids : []).slice(0, 5).map(id => String(id)).join("\n").slice(0, 600) };
    case "POST /v1/housekeeping/dismiss": return { title: `Hide ${count(data.ids)} housekeeping item${count(data.ids) === 1 ? "" : "s"}` };
    case "POST /v1/housekeeping/restore": return { title: `Show ${count(data.ids)} hidden housekeeping item${count(data.ids) === 1 ? "" : "s"} again` };
    case "POST /v1/housekeeping/scan": return { title: "Start a housekeeping scan" };
    case "POST /v1/authority": return { title: `Change release authority${project ? ` for ${project}` : ""}` };
    case "POST /v1/authority/confirm": return { title: `Allow ask-first release actions${project ? ` for ${project}` : ""}`, ...(Array.isArray(data.actions) ? { detail: data.actions.map(String).join(", ").slice(0, 200) } : {}) };
    case "DELETE /v1/authority": return { title: `Remove the release authority entry${project ? ` for ${project}` : ""}` };
    case "POST /v1/agents/permission-mode": return { title: `Change a session's permission mode${text(data.mode, 40) ? ` to ${text(data.mode, 40)}` : ""}` };
    case "POST /v1/sets/link": return { title: `Link this computer${text(data.name) ? ` with ${text(data.name)}` : ""}` };
    // Push registration is the phone's own; housekeeping-free routes added later stay refused until described here.
    default: return undefined;
  }
}

interface Pending { view: OwnerConfirmView; settle: (approved: boolean | "timeout") => void; timer: NodeJS.Timeout }

export interface OwnerConfirmOptions { computer: () => string; holdMs?: number; now?: () => number }

export class OwnerConfirmBroker {
  private pending = new Map<string, Pending>();
  private events = new EventEmitter();
  constructor(private options: OwnerConfirmOptions) { this.events.setMaxListeners(64); }

  list(): OwnerConfirmView[] { return [...this.pending.values()].map(entry => entry.view); }
  subscribe(listener: (requests: OwnerConfirmView[]) => void): () => void {
    const handler = () => listener(this.list());
    this.events.on("change", handler);
    let open = true;
    return () => { if (!open) return; open = false; this.events.off("change", handler); };
  }
  private changed() { this.events.emit("change"); }

  /** Hold a request until the phone answers. Resolves on approve; throws 403
   * on deny, 408 when no answer came in time, 429 when too many are waiting. */
  async confirm(method: string, pathname: string, data: Json, closed?: Promise<void>): Promise<void> {
    const described = describeOwnerAction(method, pathname, data);
    if (!described) throw new BridgeError(403, "Confirm this on your paired phone: this action needs its signature.", { code: "owner-proof-required" });
    if (this.pending.size >= MAX_OWNER_CONFIRMS) throw new BridgeError(429, "Too many actions are waiting for the phone. Answer or let them expire first.");
    const at = (this.options.now ?? Date.now)(), hold = this.options.holdMs ?? OWNER_CONFIRM_HOLD_MS;
    const view: OwnerConfirmView = { id: randomUUID(), kind: "owner-confirm", computer: this.options.computer(), title: described.title,
      ...(described.detail ? { detail: described.detail } : {}), route: `${method} ${pathname}`,
      askedAt: new Date(at).toISOString(), expiresAt: new Date(at + hold).toISOString() };
    const outcome = await new Promise<boolean | "timeout">(resolve => {
      const settle = (value: boolean | "timeout") => {
        const entry = this.pending.get(view.id);
        if (!entry) return;
        clearTimeout(entry.timer); this.pending.delete(view.id); this.changed();
        resolve(value);
      };
      this.pending.set(view.id, { view, settle, timer: setTimeout(() => settle("timeout"), hold) });
      this.changed();
      // The terminal gave up (Ctrl-C): take the card off the phone.
      void closed?.then(() => settle(false));
    });
    if (outcome === "timeout") throw new BridgeError(408, "No answer from the phone in time; nothing changed.", { code: "owner-confirm-timeout" });
    if (!outcome) throw new BridgeError(403, "Not confirmed on the phone; nothing changed.", { code: "owner-confirm-denied" });
  }

  /** The phone's signed answer. False when the request is no longer waiting. */
  answer(id: string, approve: boolean): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    entry.settle(approve);
    return true;
  }
}

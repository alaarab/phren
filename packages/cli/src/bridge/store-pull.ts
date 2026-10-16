import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { resolveAllStores } from "../store-registry.js";
import { ImmediatePulls } from "../sync/pull-now.js";
import { BridgeError } from "./protocol.js";
import { ownerRequest } from "./request-origin.js";

export class StorePulls {
  constructor(private readonly primary: string, private readonly pulls = new ImmediatePulls()) {}

  request(storeId: string): boolean {
    const store = resolveAllStores(this.primary).find(entry => entry.id === storeId && entry.available !== false);
    if (!store) return false;
    this.pulls.request(store.path);
    return true;
  }

  route(request: Pick<IncomingMessage, "headers">, data: Record<string, unknown>): { ok: true } {
    if (!(ownerRequest(request, data) || (request.headers["x-phren-origin"] === "peer" && data.origin === undefined))) {
      throw new BridgeError(403, "Only the owner or a peer Hook can request a pull.");
    }
    const { storeId } = z.object({ storeId: z.string().min(1).max(128) }).strict().parse(data);
    if (!this.request(storeId)) throw new BridgeError(404, "Not found.");
    return { ok: true };
  }

  stop(): void { this.pulls.stop(); }
}

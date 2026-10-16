import type { IncomingMessage } from "node:http";
import path from "node:path";
import { z } from "zod";
import { registeredStoreIdentity, resolveAllStores, storePathExists } from "../store-registry.js";
import { ImmediatePulls } from "../sync/pull-now.js";
import { runGitWithin } from "../sync/pull.js";
import { parseRemoteUrl } from "./git-hosts.js";
import { BridgeError } from "./protocol.js";
import { ownerRequest } from "./request-origin.js";

const identitySchema = z.object({
  storeId: z.string().min(1).max(128),
  repository: z.string().max(513).regex(/^[^/\s]+\/[^/\s]+$/).transform(value => value.toLowerCase()),
  branch: z.string().min(1).max(1024),
}).strict();
export type StorePullIdentity = z.infer<typeof identitySchema>;

export class StorePulls {
  constructor(private readonly primary: string, private readonly pulls = new ImmediatePulls()) {}

  private localStores() {
    // A synced primary entry can carry another computer's path. The Hook's configured root wins.
    return resolveAllStores(this.primary).slice(0, 64).map(entry => {
      const local = entry.role === "primary" ? path.resolve(this.primary) : entry.path;
      return { ...entry, path: local, available: storePathExists(local) };
    }).filter(entry => entry.available);
  }

  /** A receiver's trusted local config may name an attachment ID; return the store's portable ID. */
  request(storeId: string): string | undefined {
    const store = this.localStores().find(entry => entry.id === storeId || registeredStoreIdentity(entry.path) === storeId);
    if (!store) return undefined;
    this.pulls.request(store.path);
    return registeredStoreIdentity(store.path);
  }

  async route(request: Pick<IncomingMessage, "headers">, data: Record<string, unknown>): Promise<{ ok: true }> {
    if (!(ownerRequest(request, data) || (request.headers["x-phren-origin"] === "peer" && data.origin === undefined))) {
      throw new BridgeError(403, "Only the owner or a peer Hook can request a pull.");
    }
    const identity = identitySchema.parse(data);
    // Attachment IDs never cross computers. Only inspect checkouts carrying the requested identity.
    const candidates = this.localStores().filter(entry => registeredStoreIdentity(entry.path) === identity.storeId);
    for (const store of candidates) {
      // Local Git metadata only, bounded; follow the same tracking branch pollStore will pull.
      const refs = await runGitWithin(1000, store.path, ["for-each-ref", "--format=%(HEAD)%09%(upstream:remotename)%09%(upstream:remoteref)", "refs/heads/"]);
      if (!refs.ok) continue;
      const current = refs.output.split("\n").find(line => line.startsWith("*\t"));
      const [, remote, branch] = current?.split("\t") ?? [];
      if (!remote || remote === "." || branch !== `refs/heads/${identity.branch}`) continue;
      const url = await runGitWithin(1000, store.path, ["remote", "get-url", "--", remote]);
      const repository = url.ok ? parseRemoteUrl(url.output)?.path.toLowerCase() : undefined;
      if (repository !== identity.repository) continue;
      this.pulls.request(store.path);
      return { ok: true };
    }
    throw new BridgeError(404, "Not found.");
  }

  stop(): void { this.pulls.stop(); }
}

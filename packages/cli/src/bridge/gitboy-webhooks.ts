import { lstat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import path from "node:path";
import { z } from "zod";
import { DeliveryLog, parseGitboyPush, storePushMatches, verifyGitboySignature } from "../sync/gitboy-webhook.js";
import { optionalHookPeers, peerRequest } from "./peers.js";
import type { StorePullIdentity } from "./store-pull.js";

const storeSchema = z.object({
  storeId: z.string().min(1).max(128), owner: z.string().min(1).max(256), name: z.string().min(1).max(256),
  branch: z.string().min(1).max(1024), secret: z.string().min(1).max(4096).optional(), secretFile: z.string().min(1).optional(),
}).strict().refine(store => Boolean(store.secret) !== Boolean(store.secretFile));
const configSchema = z.object({ listenPort: z.number().int().min(1).max(65535), stores: z.array(storeSchema).min(1).max(64) }).strict();

async function privateText(file: string, cap: number): Promise<string> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > cap || (info.mode & 0o077)
    || (process.getuid && info.uid !== process.getuid())) throw new Error("Unsafe private webhook file.");
  return readFile(file, "utf8");
}

const BODY_CAP = 1024 * 1024;
function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => { clearTimeout(timer); request.off("data", data); request.off("end", end); request.off("error", error); request.off("aborted", aborted); };
    const fail = (status: number) => { cleanup(); request.resume(); reject(status); };
    const data = (chunk: Buffer) => { size += chunk.length; if (size > BODY_CAP) fail(413); else chunks.push(chunk); };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const error = () => fail(400);
    const aborted = () => fail(400);
    const timer = setTimeout(() => fail(408), 5000);
    request.on("data", data); request.once("end", end); request.once("error", error); request.once("aborted", aborted);
    if (Number(request.headers["content-length"]) > BODY_CAP) fail(413);
  });
}

/** All peers come from the private, verified directory; peerRequest pins SSH host keys. */
async function nudgePeers(identity: StorePullIdentity): Promise<void> {
  const { peers } = await optionalHookPeers();
  await Promise.allSettled(peers.map(peer => peerRequest(peer, "/v1/store/pull-now", { ...identity }, 15_000)));
}

export interface WebhookStatus {
  configured: boolean; listening: boolean; listenPort?: number; problem?: string;
  lastDeliveryAt?: string; lastOutcome?: string;
}

/** Optional private HTTP ingress. Invalid config disables only this listener, never the Hook. */
export class GitboyWebhooks {
  readonly status: WebhookStatus = { configured: false, listening: false };
  private server?: Server;
  private readonly deliveries = new DeliveryLog();
  private readonly bodies = new DeliveryLog();
  private readonly nudges = new Map<string, { running: boolean; pending: boolean; last: number; identity: StorePullIdentity; timer?: ReturnType<typeof setTimeout> }>();
  private closed = false;

  constructor(private readonly root: string, private readonly pull: (storeId: string) => string | undefined,
    private readonly nudge: (identity: StorePullIdentity) => Promise<void> = nudgePeers) {}

  private notify(store: z.infer<typeof storeSchema>): void {
    // Configuration may name a local attachment. Only the ID carried by that store is portable.
    let storeId = store.storeId;
    try { storeId = this.pull(storeId) ?? storeId; } catch { /* Peers may still have the configured portable ID. */ }
    const identity = { storeId, repository: `${store.owner}/${store.name}`.toLowerCase(), branch: store.branch };
    let state = this.nudges.get(storeId);
    if (!state) { state = { running: false, pending: false, last: -Infinity, identity }; this.nudges.set(storeId, state); }
    state.identity = identity;
    state.pending = true;
    const schedule = () => {
      if (state.running || state.timer || this.closed) return;
      state.timer = setTimeout(() => {
        state.timer = undefined;
        if (this.closed) return;
        state.pending = false; state.running = true; state.last = Date.now();
        void this.nudge(state.identity).catch(() => { /* Polling remains the fallback. */ }).finally(() => {
          state.running = false;
          if (state.pending) schedule();
        });
      }, Math.max(0, state.last + 10_000 - Date.now()));
      state.timer.unref();
    };
    schedule();
  }

  async start(): Promise<void> {
    const file = path.join(this.root, "gitboy-webhooks.json");
    try { await lstat(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      this.status.problem = "Webhook config unavailable."; return;
    }
    this.status.configured = true;
    try {
      const config = configSchema.parse(JSON.parse(await privateText(file, 65_536)));
      const stores = await Promise.all(config.stores.map(async store => ({ ...store,
        secret: store.secret ?? (await privateText(path.resolve(this.root, store.secretFile!), 4096)).trim(),
      })));
      if (stores.some(store => !store.secret)) throw new Error("Empty secret.");
      const server = createServer({ maxHeaderSize: 16_384 }, (request, response) => {
        const reply = (status: number, outcome: string) => {
          this.status.lastDeliveryAt = new Date().toISOString(); this.status.lastOutcome = outcome;
          response.writeHead(status, { "Connection": "close", "Cache-Control": "no-store" }); response.end();
        };
        void (async () => {
          if (request.method !== "POST" || request.url !== "/gitboy/push") { reply(404, "not-found"); return; }
          if (![ `127.0.0.1:${config.listenPort}`, `localhost:${config.listenPort}` ].includes(request.headers.host ?? "")
            || request.headers.origin !== undefined || Object.keys(request.headers).some(name => name.startsWith("sec-fetch-"))) {
            reply(403, "browser-refused"); return;
          }
          if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers["content-type"] ?? "")) { reply(415, "content-type-refused"); return; }
          const raw = await readBody(request);
          const signature = request.headers["x-hub-signature-256"];
          // Authenticate the raw bytes against EVERY secret before parsing or traversing the payload.
          const verified = stores.filter(store => verifyGitboySignature(store.secret, raw, typeof signature === "string" ? signature : undefined));
          if (!verified.length) { reply(401, "unauthorized"); return; }
          const push = parseGitboyPush(raw, request.headers);
          if (!push?.repository) { reply(400, "malformed"); return; }
          const candidates = verified.filter(store => store.owner.toLowerCase() === push.repository!.owner.toLowerCase()
            && store.name.toLowerCase() === push.repository!.name.toLowerCase());
          if (!candidates.length) { reply(401, "unauthorized"); return; }
          const repo = push.repository;
          const duplicateId = this.deliveries.seen(JSON.stringify([repo.owner.toLowerCase(), repo.name.toLowerCase(), push.deliveryId]));
          // Per verified store set: the same body signed with another stores secret is that stores delivery.
          const storeKey = candidates.map(store => store.storeId).sort().join("\u0000");
          const duplicateBody = this.bodies.seen(`${storeKey}\u0000${createHash("sha256").update(raw).digest("hex")}`);
          if (duplicateId || duplicateBody) { reply(200, "duplicate"); return; }
          const matching = candidates.filter(store => storePushMatches(push, store));
          if (!matching.length) { reply(200, "non-matching"); return; }
          reply(202, "accepted");
          setImmediate(() => { if (!this.closed) for (const store of matching) this.notify(store); });
        })().catch(error => reply(typeof error === "number" ? error : 400, typeof error === "number" && error === 413 ? "too-large" : "malformed"));
      });
      this.server = server;
      server.requestTimeout = 6000; server.headersTimeout = 5000; server.maxHeadersCount = 32;
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.listenPort, "127.0.0.1", resolve); });
      server.on("error", () => { this.status.listening = false; this.status.problem = "Webhook listener failed."; });
      this.status.listening = true; this.status.listenPort = config.listenPort;
    } catch { this.status.problem = "Webhook config invalid, unsafe, or port unavailable."; }
  }

  stop(): void {
    this.closed = true; this.status.listening = false;
    for (const state of this.nudges.values()) clearTimeout(state.timer);
    this.server?.close(); this.server?.closeAllConnections();
  }
}

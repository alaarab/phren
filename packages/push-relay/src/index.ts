import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ApnsSend } from "./apns.js";
import { apnsPayload, parseSend, RateLimiter, Relay, RelayError, ReplayGuard, type Environment } from "./relay.js";

export * from "./relay.js";
export { apnsSender, type ApnsConfig, type ApnsSend } from "./apns.js";

const MAX_BODY = 8_192;

export interface RelayServerOptions {
  relay: Relay;
  send: ApnsSend;
  /** Sends per relay id per minute. */
  sendLimit?: RateLimiter;
  /** Registrations per client address per minute. */
  registerLimit?: RateLimiter;
  now?: () => number;
}

async function readBody(request: IncomingMessage): Promise<string> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new RelayError(413, "The request is too large.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function reply(response: ServerResponse, status: number, value: Record<string, unknown>) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

/** The relay's HTTP API. It logs nothing about devices or content. */
export function createRelayServer(options: RelayServerOptions): Server {
  const now = options.now ?? Date.now;
  const sendLimit = options.sendLimit ?? new RateLimiter(60, 60_000);
  const registerLimit = options.registerLimit ?? new RateLimiter(20, 60_000);
  const replay = new ReplayGuard();
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://relay.local");
      if (request.method === "GET" && url.pathname === "/health") return reply(response, 200, { ok: true });
      if (request.method !== "POST") throw new RelayError(404, "Not found.");
      if (url.pathname === "/v1/register") {
        // Behind a proxy, its forwarded address; directly, the socket's.
        const client = String(request.headers["x-forwarded-for"] ?? request.socket.remoteAddress ?? "").split(",")[0].trim();
        if (!registerLimit.allow(`register:${client}`, now())) throw new RelayError(429, "Too many registrations; try again shortly.");
        const body = JSON.parse(await readBody(request) || "{}") as { deviceToken?: unknown; environment?: unknown };
        const environment: Environment = body.environment === "sandbox" ? "sandbox" : "production";
        return reply(response, 200, { ok: true, ...options.relay.register(String(body.deviceToken ?? "").toLowerCase(), environment) });
      }
      if (url.pathname === "/v1/send") {
        const relayId = String(request.headers["x-phren-relay"] ?? "");
        const timestamp = String(request.headers["x-phren-timestamp"] ?? "");
        const signature = String(request.headers["x-phren-signature"] ?? "");
        const target = options.relay.resolve(relayId);
        const body = await readBody(request);
        options.relay.verify(relayId, timestamp, body, signature, now());
        if (!sendLimit.allow(relayId, now())) throw new RelayError(429, "Too many notifications for this phone; slow down.");
        replay.check(signature, now());
        const send = parseSend(body);
        const result = await options.send(target.deviceToken, target.environment, apnsPayload(send),
          { collapseId: send.collapseId, expiration: send.expiration });
        // Apple says the phone is gone: the Hook should stop sending and re-register.
        if (!result.ok && (result.status === 410 || result.reason === "BadDeviceToken" || result.reason === "Unregistered")) {
          return reply(response, 410, { ok: false, error: "This phone is no longer registered.", code: "unregistered" });
        }
        return result.ok ? reply(response, 200, { ok: true })
          : reply(response, 502, { ok: false, error: "Apple didn't accept the notification.", code: result.reason ?? "apns" });
      }
      throw new RelayError(404, "Not found.");
    } catch (error) {
      if (error instanceof RelayError) return reply(response, error.status, { ok: false, error: error.message });
      if (error instanceof SyntaxError) return reply(response, 400, { ok: false, error: "The body isn't JSON." });
      return reply(response, 500, { ok: false, error: "The relay failed." });
    }
  });
}

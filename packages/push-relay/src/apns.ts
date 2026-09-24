import { createPrivateKey, sign } from "node:crypto";
import { connect, type ClientHttp2Session } from "node:http2";
import type { Environment } from "./relay.js";

export interface ApnsConfig { keyId: string; teamId: string; topic: string; privateKey: string }
export interface ApnsResult { ok: boolean; status: number; reason?: string }
export type ApnsSend = (deviceToken: string, environment: Environment, payload: Record<string, unknown>,
  headers: { collapseId?: string; expiration?: number }) => Promise<ApnsResult>;

const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** Token-based APNs over one HTTP/2 connection per environment, reused. */
export function apnsSender(config: ApnsConfig, now = Date.now): ApnsSend {
  const key = createPrivateKey(config.privateKey);
  let jwt: { value: string; created: number } | undefined;
  const sessions = new Map<Environment, ClientHttp2Session>();
  const token = () => {
    const created = Math.floor(now() / 1000);
    if (jwt && created - jwt.created < 50 * 60) return jwt.value;
    const input = `${base64url(JSON.stringify({ alg: "ES256", kid: config.keyId }))}.${base64url(JSON.stringify({ iss: config.teamId, iat: created }))}`;
    const signature = sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
    jwt = { value: `${input}.${base64url(signature)}`, created };
    return jwt.value;
  };
  const session = (environment: Environment) => {
    const existing = sessions.get(environment);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const client = connect(environment === "production" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com");
    client.on("error", () => sessions.delete(environment));
    client.on("close", () => sessions.delete(environment));
    client.unref();
    sessions.set(environment, client);
    return client;
  };
  return (deviceToken, environment, payload, headers) => new Promise(resolve => {
    let settled = false;
    const finish = (result: ApnsResult) => { if (!settled) { settled = true; resolve(result); } };
    try {
      const request = session(environment).request({
        ":method": "POST", ":path": `/3/device/${deviceToken}`, authorization: `bearer ${token()}`,
        "apns-topic": config.topic, "apns-push-type": "alert", "apns-priority": "10",
        "apns-expiration": String(headers.expiration ?? 0),
        ...(headers.collapseId ? { "apns-collapse-id": headers.collapseId } : {}),
      });
      let status = 0, body = "";
      request.on("response", response => { status = Number(response[":status"]); });
      request.setEncoding("utf8");
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        let reason: string | undefined;
        try { reason = body ? String((JSON.parse(body) as { reason?: unknown }).reason ?? "") || undefined : undefined; } catch { /* no body */ }
        finish({ ok: status === 200, status, reason });
      });
      request.once("error", () => finish({ ok: false, status: 0, reason: "connection" }));
      request.setTimeout(10_000, () => { request.close(); finish({ ok: false, status: 0, reason: "timeout" }); });
      request.end(JSON.stringify(payload));
    } catch {
      finish({ ok: false, status: 0, reason: "connection" });
    }
  });
}

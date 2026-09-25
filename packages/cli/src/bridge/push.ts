import { createCipheriv, createHmac, createPrivateKey, randomBytes, sign } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { connect } from "node:http2";
import path from "node:path";
import { z } from "zod";
import { atomic, bridgeRoot } from "./protocol.js";

/** A phone registered through the phren push relay: the relay knows where to
 * deliver, and `key` (32 bytes, base64url) encrypts what the notification says
 * so only the phone reads it. The phone made the key and sent it over SSH. */
const relaySchema = z.object({
  url: z.string().url().refine(value => /^https:\/\//.test(value) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(`${value}/`),
    "The relay must use https."),
  relayId: z.string().regex(/^[A-Za-z0-9_-]{40,400}$/),
  secret: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/),
  key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

const deviceSchema = z.object({
  deviceID: z.string().uuid(),
  hostID: z.string().uuid(),
  /** The APNs token, for a Hook with its own key (apns.json). */
  token: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  relay: relaySchema.optional(),
  environment: z.enum(["development", "production"]),
  kinds: z.array(z.enum(["approval", "scheduleStarted", "scheduleFinished", "scheduleFailed", "scheduleBlocked"])).max(5).default(["approval"]),
}).refine(device => device.token !== undefined || device.relay !== undefined, "A phone needs an APNs token or a relay registration.");
export type PushDevice = z.infer<typeof deviceSchema>;

const configSchema = z.object({
  keyId: z.string().regex(/^[A-Z0-9]{10}$/),
  teamId: z.string().regex(/^[A-Z0-9]{10}$/),
  topic: z.string().regex(/^[A-Za-z0-9.-]{1,255}$/).default("com.phren.ios"),
  privateKeyPath: z.string().min(1),
});
type APNsConfig = z.infer<typeof configSchema>;

export interface ApprovalPush { binding: string; provider: string; question: boolean; expiresAt: string;
  /** What the request is, when the provider names it (an opencode permission
   * ask): shown in the alert so the phone can answer without opening Phren. */
  title?: string; message?: string }
export interface FanoutBlockedPush { job: string; label: string; provider: string; reason: string }
export type SchedulePushKind = "scheduleStarted" | "scheduleFinished" | "scheduleFailed" | "scheduleBlocked";
export interface SchedulePush {
  kind: SchedulePushKind;
  scheduleId: string;
  project: string;
  name: string;
  computer: string;
  runId: string;
  status: "running" | "finished" | "needs-you" | "failed" | "blocked";
  reason?: string;
  route?: string;
}
export interface SchedulePushResult { notified: boolean; reason?: string }

export function scheduleCollapseId(kind: SchedulePushKind, runId: string): string {
  return `${runId.slice(0, 63 - kind.length)}-${kind}`;
}

export function approvalPushPayload(value: ApprovalPush, host?: string): Record<string, unknown> {
  const label = value.provider === "claude" ? "Claude" : value.provider === "codex" ? "Codex" : value.provider === "opencode" ? "opencode" : "Your agent";
  return {
    aps: {
      alert: { title: value.title ?? (value.question ? `${label} has a question` : `${label} needs approval`),
        body: value.message ?? "Open Phren to review the request." },
      sound: "default", category: value.question ? "PHREN_AGENT_QUESTION" : "PHREN_AGENT_APPROVAL",
      "interruption-level": "time-sensitive",
    },
    phren: { version: 1, binding: value.binding, expiresAt: value.expiresAt, ...(host ? { host } : {}) },
  };
}

export function fanoutBlockedPushPayload(value: FanoutBlockedPush): Record<string, unknown> {
  return {
    aps: { alert: { title: `${value.label} blocked`, body: value.reason }, sound: "default", category: "PHREN_FANOUT" },
    phren: { kind: "fanoutBlocked", job: value.job, provider: value.provider, label: value.label, reason: value.reason },
  };
}

export function schedulePushPayload(value: SchedulePush): Record<string, unknown> {
  const state = value.kind === "scheduleStarted" ? "started" : value.kind === "scheduleFinished" ? (value.status === "needs-you" ? "needs you" : "finished")
    : value.kind === "scheduleBlocked" ? "blocked" : "failed";
  return {
    aps: {
      alert: { title: `${value.name} ${state}`, body: `${value.project} on ${value.computer}${value.reason ? `. ${value.reason}` : ""}` },
      sound: "default", category: "PHREN_SCHEDULE",
    },
    phren: { kind: value.kind, scheduleId: value.scheduleId, project: value.project, name: value.name,
      computer: value.computer, runId: value.runId, status: value.status, ...(value.reason ? { reason: value.reason } : {}),
      ...(value.route ? { route: value.route } : {}) },
  };
}

async function secureJSON<T>(file: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    const metadata = await stat(file);
    if ((metadata.mode & 0o077) !== 0 || (process.getuid && metadata.uid !== process.getuid())) return undefined;
    return schema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch { return undefined; }
}

async function secureFile(file: string): Promise<string | undefined> {
  try {
    const metadata = await stat(file);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || (process.getuid && metadata.uid !== process.getuid())) return undefined;
    return await readFile(file, "utf8");
  } catch { return undefined; }
}

/** What `phren bridge doctor` prints when the Hook has no APNs sender. */
export function apnsSetupSteps(configFile = process.env.PHREN_APNS_CONFIG || path.join(bridgeRoot(), "apns.json")): string {
  return [
    "Approval push is not configured: the phone only alerts while Phren runs, and a registered phone gets nothing while suspended.",
    "1. In your Apple developer account, create an APNs key (Keys, Apple Push Notifications service) and download AuthKey_<KEYID>.p8.",
    `2. Save it next to ${configFile} with mode 600.`,
    `3. Write ${configFile} with mode 600: {"keyId":"<KEYID>","teamId":"<TEAMID>","topic":"com.phren.ios","privateKeyPath":"AuthKey_<KEYID>.p8"}`,
    "4. Restart the Hook (phren bridge install), then run phren bridge doctor again.",
  ].join("\n");
}

/** The capability a phone reads: a Hook with its own APNs key sends direct;
 * one whose phones registered through the relay sends through it. */
export function approvalPushCapability(status: { configured: boolean; direct?: boolean }): "direct-apns" | "relay" | undefined {
  if (!status.configured) return undefined;
  return status.direct === false ? "relay" : "direct-apns";
}

export function upsertPushDevice(devices: PushDevice[], value: unknown): PushDevice[] {
  const device = deviceSchema.parse(value);
  return [...devices.filter(item => item.deviceID !== device.deviceID), device].slice(-16);
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** The relay refuses ciphertext longer than this (it keeps the APNs payload under 4 KB). */
export const RELAY_MAX_CIPHERTEXT = 2_800;

/** What the phone's notification extension shows, encrypted with the phone's
 * key: ChaCha20-Poly1305, base64url of nonce (12) + ciphertext + tag (16), the
 * layout CryptoKit's `ChaChaPoly.SealedBox(combined:)` reads. A long body is
 * shortened until it fits the relay's limit. */
export function relayCiphertext(key: string, payload: Record<string, unknown>, nonce = randomBytes(12)): string {
  const aps = (payload.aps ?? {}) as { alert?: { title?: string; body?: string }; category?: string; "interruption-level"?: string };
  let body = aps.alert?.body ?? "";
  for (;;) {
    const content = JSON.stringify({ t: aps.alert?.title ?? "phren", b: body, ...(aps.category ? { c: aps.category } : {}),
      ...(aps["interruption-level"] ? { i: aps["interruption-level"] } : {}), ...(payload.phren ? { p: payload.phren } : {}) });
    const cipher = createCipheriv("chacha20-poly1305", Buffer.from(key, "base64url"), nonce, { authTagLength: 16 });
    const sealed = Buffer.concat([nonce, cipher.update(content, "utf8"), cipher.final(), cipher.getAuthTag()]).toString("base64url");
    if (sealed.length <= RELAY_MAX_CIPHERTEXT || !body) return sealed;
    body = body.length > 40 ? `${body.slice(0, Math.floor(body.length * 0.8))}…` : "";
  }
}

/** Signs a relay send: base64url HMAC-SHA256 of `${timestamp}.${body}` under the phone's send secret. */
export function relaySignature(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("base64url");
}

type RelayRegistration = z.infer<typeof relaySchema>;
/** "gone" means the relay (Apple) no longer knows the phone: stop sending until it registers again. */
export type RelayResult = "sent" | "failed" | "gone";

export async function sendThroughRelay(relay: RelayRegistration, payload: Record<string, unknown>,
  headers: { expiration: string; collapseId: string }, fetcher: typeof fetch = fetch, now = Date.now): Promise<RelayResult> {
  const aps = (payload.aps ?? {}) as { category?: string };
  const body = JSON.stringify({ kind: "alert", ciphertext: relayCiphertext(relay.key, payload),
    collapseId: headers.collapseId.slice(0, 64), expiration: Number(headers.expiration) || 0,
    ...(aps.category ? { category: aps.category } : {}) });
  const timestamp = String(Math.floor(now() / 1000));
  try {
    const response = await fetcher(`${relay.url.replace(/\/+$/, "")}/v1/send`, {
      method: "POST", body, signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json", "x-phren-relay": relay.relayId, "x-phren-timestamp": timestamp,
        "x-phren-signature": relaySignature(relay.secret, timestamp, body) },
    });
    return response.status === 410 ? "gone" : response.ok ? "sent" : "failed";
  } catch { return "failed"; }
}

class APNsSender {
  private jwt?: { value: string; created: number };
  constructor(private config: APNsConfig, private key: string, private now = Date.now) {}
  private token(): string {
    const created = Math.floor(this.now() / 1000);
    if (this.jwt && created - this.jwt.created < 50 * 60) return this.jwt.value;
    const header = base64url(JSON.stringify({ alg: "ES256", kid: this.config.keyId }));
    const claims = base64url(JSON.stringify({ iss: this.config.teamId, iat: created }));
    const input = `${header}.${claims}`;
    const signature = sign("sha256", Buffer.from(input), { key: createPrivateKey(this.key), dsaEncoding: "ieee-p1363" });
    const value = `${input}.${base64url(signature)}`;
    this.jwt = { value, created };
    return value;
  }
  send(device: PushDevice, payload: Record<string, unknown>, headers: { expiration: string; collapseId: string }): Promise<boolean> {
    const authority = device.environment === "production" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
    return new Promise(resolve => {
      const client = connect(authority); let settled = false;
      const finish = (ok: boolean) => { if (settled) return; settled = true; client.close(); resolve(ok); };
      client.once("error", () => finish(false));
      const request = client.request({ ":method": "POST", ":path": `/3/device/${device.token}`,
        authorization: `bearer ${this.token()}`, "apns-topic": this.config.topic, "apns-push-type": "alert",
        "apns-priority": "10", "apns-expiration": headers.expiration, "apns-collapse-id": headers.collapseId });
      request.on("response", headers => finish(Number(headers[":status"]) === 200));
      request.once("error", () => finish(false)); request.setTimeout(10_000, () => { request.close(); finish(false); });
      request.end(JSON.stringify(payload));
    });
  }
}

/** Direct Hook -> APNs delivery. Apple receives only a short-lived opaque
 * binding; conversation identity, action id, command and SSH key stay local. */
export class ApprovalPushService {
  private devices: PushDevice[] = [];
  private sender?: APNsSender;
  private readonly devicesFile = path.join(bridgeRoot(), "push-devices.json");
  async start() {
    this.devices = await secureJSON(this.devicesFile, z.array(deviceSchema).max(16)) ?? [];
    const configFile = process.env.PHREN_APNS_CONFIG || path.join(bridgeRoot(), "apns.json");
    const config = await secureJSON(configFile, configSchema);
    if (!config) return;
    const keyPath = path.isAbsolute(config.privateKeyPath) ? config.privateKeyPath : path.resolve(path.dirname(configFile), config.privateKeyPath);
    const key = await secureFile(keyPath);
    if (key) this.sender = new APNsSender(config, key);
  }
  /** Phones this Hook can reach: through the relay, or direct with its own key. */
  private get reachable() { return this.devices.filter(device => device.relay || (this.sender && device.token)); }
  get available() { return this.reachable.length > 0; }
  get status() {
    const relay = this.devices.filter(device => device.relay).length;
    return { supported: true, configured: this.sender !== undefined || relay > 0, direct: this.sender !== undefined,
      devices: this.devices.length, relay };
  }
  async register(value: unknown) {
    this.devices = upsertPushDevice(this.devices, value);
    await atomic(this.devicesFile, JSON.stringify(this.devices));
  }
  /** One phone: the relay when it registered through one, otherwise direct. */
  private async send(device: PushDevice, payload: Record<string, unknown>, headers: { expiration: string; collapseId: string }): Promise<boolean> {
    if (device.relay) {
      const result = await sendThroughRelay(device.relay, payload, headers);
      if (result === "gone") {
        this.devices = this.devices.filter(item => item.deviceID !== device.deviceID);
        await atomic(this.devicesFile, JSON.stringify(this.devices)).catch(() => {});
      }
      return result === "sent";
    }
    return this.sender && device.token ? this.sender.send(device, payload, headers) : false;
  }
  async notify(value: ApprovalPush): Promise<boolean> {
    const devices = this.reachable.filter(device => device.kinds.includes("approval"));
    if (!devices.length) return false;
    return (await Promise.all(devices.map(device => this.send(device, approvalPushPayload(value, device.hostID), {
      expiration: String(Math.floor(Date.parse(value.expiresAt) / 1000)), collapseId: value.binding,
    })))).some(Boolean);
  }
  /** A headless worker whose permission the plugin refused. Approval-registered
   * phones already accept agent alerts; the payload carries the reason so the
   * notification is actionable on its own. */
  async notifyFanoutBlocked(value: FanoutBlockedPush): Promise<boolean> {
    const devices = this.reachable.filter(device => device.kinds.includes("approval"));
    if (!devices.length) return false;
    return (await Promise.all(devices.map(device => this.send(device, fanoutBlockedPushPayload(value), {
      expiration: "0", collapseId: `fanout-${value.job}`,
    })))).some(Boolean);
  }
  async notifySchedule(value: SchedulePush): Promise<SchedulePushResult> {
    const reachable = this.reachable;
    if (!reachable.length) return { notified: false, reason: this.sender || this.devices.length ? "no registered devices" : "no push config" };
    let devices = reachable.filter(device => device.kinds.includes(value.kind));
    if (!devices.length && value.kind === "scheduleBlocked") devices = reachable.filter(device => device.kinds.includes("scheduleFailed"));
    if (!devices.length) return { notified: false, reason: "no registered devices" };
    try {
      const notified = (await Promise.all(devices.map(device => this.send(device, schedulePushPayload(value), {
        expiration: "0", collapseId: scheduleCollapseId(value.kind, value.runId),
      })))).some(Boolean);
      return notified ? { notified: true } : { notified: false, reason: "push delivery failed" };
    } catch {
      return { notified: false, reason: "push delivery failed" };
    }
  }
}

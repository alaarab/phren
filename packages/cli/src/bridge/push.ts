import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { connect } from "node:http2";
import path from "node:path";
import { z } from "zod";
import { bridgeRoot } from "./protocol.js";

const deviceSchema = z.object({
  deviceID: z.string().uuid(),
  hostID: z.string().uuid(),
  token: z.string().regex(/^[0-9a-f]{64}$/),
  environment: z.enum(["development", "production"]),
});
export type PushDevice = z.infer<typeof deviceSchema>;

const configSchema = z.object({
  keyId: z.string().regex(/^[A-Z0-9]{10}$/),
  teamId: z.string().regex(/^[A-Z0-9]{10}$/),
  topic: z.string().regex(/^[A-Za-z0-9.-]{1,255}$/).default("com.phren.ios"),
  privateKeyPath: z.string().min(1),
});
type APNsConfig = z.infer<typeof configSchema>;

export interface ApprovalPush { binding: string; provider: string; question: boolean; expiresAt: string }

export function approvalPushPayload(value: ApprovalPush, host?: string): Record<string, unknown> {
  const label = value.provider === "claude" ? "Claude" : value.provider === "codex" ? "Codex" : "Your agent";
  return {
    aps: {
      alert: { title: value.question ? `${label} has a question` : `${label} needs approval`, body: "Open Phren to review the request." },
      sound: "default", category: value.question ? "PHREN_AGENT_QUESTION" : "PHREN_AGENT_APPROVAL",
      "interruption-level": "time-sensitive",
    },
    phren: { version: 1, binding: value.binding, expiresAt: value.expiresAt, ...(host ? { host } : {}) },
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

export function upsertPushDevice(devices: PushDevice[], value: unknown): PushDevice[] {
  const device = deviceSchema.parse(value);
  return [...devices.filter(item => item.deviceID !== device.deviceID), device].slice(-16);
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

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
  send(device: PushDevice, payload: Record<string, unknown>): Promise<boolean> {
    const authority = device.environment === "production" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
    return new Promise(resolve => {
      const client = connect(authority); let settled = false;
      const finish = (ok: boolean) => { if (settled) return; settled = true; client.close(); resolve(ok); };
      client.once("error", () => finish(false));
      const phren = payload.phren as { binding: string; expiresAt: string };
      const request = client.request({ ":method": "POST", ":path": `/3/device/${device.token}`,
        authorization: `bearer ${this.token()}`, "apns-topic": this.config.topic, "apns-push-type": "alert",
        "apns-priority": "10", "apns-expiration": String(Math.floor(Date.parse(phren.expiresAt) / 1000)), "apns-collapse-id": phren.binding });
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
  get available() { return this.sender !== undefined && this.devices.length > 0; }
  get status() { return { supported: true, configured: this.sender !== undefined, devices: this.devices.length }; }
  async register(value: unknown) {
    this.devices = upsertPushDevice(this.devices, value);
    const temporary = `${this.devicesFile}.${randomUUID()}`;
    await writeFile(temporary, JSON.stringify(this.devices), { mode: 0o600, flag: "wx" });
    await rename(temporary, this.devicesFile);
  }
  async notify(value: ApprovalPush): Promise<boolean> {
    if (!this.sender || !this.devices.length) return false;
    return (await Promise.all(this.devices.map(device => this.sender!.send(device, approvalPushPayload(value, device.hostID))))).some(Boolean);
  }
}

import { createDecipheriv, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approvalPushCapability, approvalPushPayload, ApprovalPushService, RELAY_MAX_CIPHERTEXT, relayCiphertext, relaySignature, scheduleCollapseId,
  schedulePushPayload, sendThroughRelay, upsertPushDevice } from "./push.js";
import { PushBindingStore } from "./agent-hooks.js";
import { approvalPushCheck } from "./command.js";

describe("approval push payload", () => {
  it("contains only a generic alert and opaque expiring binding", () => {
    const value = approvalPushPayload({
      binding: "6fd8c056-032d-4219-97d7-a506d672ccf2", provider: "codex", question: false,
      expiresAt: "2026-09-19T20:00:55.000Z",
    }, "73d445d1-4b31-43fc-9185-65b60c6f7125");
    expect(value).toEqual({
      aps: { alert: { title: "Codex needs approval", body: "Open Phren to review the request." }, sound: "default",
        category: "PHREN_AGENT_APPROVAL", "interruption-level": "time-sensitive" },
      phren: { version: 1, binding: "6fd8c056-032d-4219-97d7-a506d672ccf2", expiresAt: "2026-09-19T20:00:55.000Z",
        host: "73d445d1-4b31-43fc-9185-65b60c6f7125" },
    });
    const encoded = JSON.stringify(value);
    expect(encoded).not.toContain("workspace"); expect(encoded).not.toContain("session");
    expect(encoded).not.toContain("actionId"); expect(encoded).not.toContain("command");
  });

  it("requires questions to open Phren instead of offering blind approval", () => {
    const value = approvalPushPayload({ binding: "a", provider: "claude", question: true, expiresAt: "2026-09-19T20:00:55.000Z" });
    expect((value.aps as any).category).toBe("PHREN_AGENT_QUESTION");
    expect(JSON.stringify(value)).not.toContain("Approve");
  });

  it("keeps separate phones registered and rotates only the matching phone token", () => {
    const one = { deviceID: "11111111-1111-4111-8111-111111111111", hostID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", token: "a".repeat(64), environment: "production" };
    const two = { deviceID: "22222222-2222-4222-8222-222222222222", hostID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", token: "b".repeat(64), environment: "production" };
    let devices = upsertPushDevice([], one);
    devices = upsertPushDevice(devices, two);
    devices = upsertPushDevice(devices, { ...one, token: "c".repeat(64) });
    expect(devices).toHaveLength(2);
    expect(devices.find(device => device.deviceID === one.deviceID)?.token).toBe("c".repeat(64));
    expect(devices.every(device => device.kinds.includes("approval"))).toBe(true);
  });
});

describe("schedule push payload", () => {
  it("includes the lifecycle alert and run route", () => {
    expect(schedulePushPayload({ kind: "scheduleFailed", scheduleId: "7f3a2c1d", project: "demo",
      name: "Nightly test sweep", computer: "Desk", runId: "run-1", status: "failed", reason: "Tests failed",
      route: "phren://session?route=opaque" })).toEqual({
      aps: { alert: { title: "Nightly test sweep failed", body: "demo on Desk. Tests failed" }, sound: "default", category: "PHREN_SCHEDULE" },
      phren: { kind: "scheduleFailed", scheduleId: "7f3a2c1d", project: "demo", name: "Nightly test sweep",
        computer: "Desk", runId: "run-1", status: "failed", reason: "Tests failed", route: "phren://session?route=opaque" },
    });
  });

  it("labels a live blocked run as blocked, not failed", () => {
    expect(schedulePushPayload({ kind: "scheduleBlocked", scheduleId: "7f3a2c1d", project: "demo",
      name: "Nightly test sweep", computer: "Desk", runId: "run-1", status: "blocked",
      reason: "Blocked at startup: Allow external CLAUDE.md file imports?" })).toEqual({
      aps: { alert: { title: "Nightly test sweep blocked",
        body: "demo on Desk. Blocked at startup: Allow external CLAUDE.md file imports?" },
        sound: "default", category: "PHREN_SCHEDULE" },
      phren: { kind: "scheduleBlocked", scheduleId: "7f3a2c1d", project: "demo", name: "Nightly test sweep",
        computer: "Desk", runId: "run-1", status: "blocked",
        reason: "Blocked at startup: Allow external CLAUDE.md file imports?" },
    });
  });

  it("gives each notification kind its own collapse id so a later push cannot replace the blocked alert", () => {
    expect(scheduleCollapseId("scheduleBlocked", "run-1")).toBe("run-1-scheduleBlocked");
    expect(scheduleCollapseId("scheduleFinished", "run-1")).toBe("run-1-scheduleFinished");
    expect(scheduleCollapseId("scheduleBlocked", "run-1")).not.toBe(scheduleCollapseId("scheduleFinished", "run-1"));
    expect(scheduleCollapseId("scheduleBlocked", "a".repeat(64))).toHaveLength(64);
    expect(scheduleCollapseId("scheduleBlocked", "a".repeat(64))).not.toBe(scheduleCollapseId("scheduleFinished", "a".repeat(64)));
  });
});

describe("push bindings", () => {
  it("is one-time and rejects expired bindings", () => {
    let now = 100;
    const bindings = new PushBindingStore(() => now, 2);
    bindings.add("first", { action: "a", expiresAt: 200 });
    expect(bindings.consume("first")?.action).toBe("a");
    expect(bindings.consume("first")).toBeUndefined();
    bindings.add("expired", { action: "b", expiresAt: 150 }); now = 151;
    expect(bindings.consume("expired")).toBeUndefined();
  });

  it("drops response bindings and remains bounded", () => {
    const bindings = new PushBindingStore(() => 100, 2);
    bindings.add("one", { action: "a", expiresAt: 200 }); bindings.add("two", { action: "a", expiresAt: 200 });
    bindings.dropAction("a"); expect(bindings.size).toBe(0);
    bindings.add("one", { action: "a", expiresAt: 200 }); bindings.add("two", { action: "b", expiresAt: 200 });
    bindings.add("three", { action: "c", expiresAt: 200 });
    expect(bindings.size).toBe(2); expect(bindings.consume("one")).toBeUndefined();
  });
});

describe("push honesty", () => {
  const scratchRoots: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(scratchRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });
  async function bridgeHome() {
    const root = await mkdtemp(path.join(tmpdir(), "phren-push-"));
    scratchRoots.push(root);
    vi.stubEnv("PHREN_BRIDGE_HOME", root);
    vi.stubEnv("PHREN_APNS_CONFIG", "");
    return root;
  }
  const device = { deviceID: "6fd8c056-032d-4219-97d7-a506d672ccf2", hostID: "73d445d1-4b31-43fc-9185-65b60c6f7125",
    token: "a".repeat(64), environment: "production", kinds: ["approval"] };

  it("accepts a phone without apns.json but reports push as not configured", async () => {
    const root = await bridgeHome();
    const push = new ApprovalPushService();
    await push.start();
    await push.register(device);
    expect(push.status).toEqual({ supported: true, configured: false, direct: false, devices: 1, relay: 0 });
    expect(push.available).toBe(false);
    expect(approvalPushCapability(push.status)).toBeUndefined();
    const check = approvalPushCheck({ capabilities: { approvals: true } });
    expect(check.configured).toBe(false);
    for (const part of [path.join(root, "apns.json"), '"keyId"', '"teamId"', '"topic":"com.phren.ios"', '"privateKeyPath"', "phren bridge install"]) {
      expect(check.warning).toContain(part);
    }
  });

  // The APNs key and apns.json must be mode 0600; Windows files carry no POSIX mode bits.
  // The Hook that sends pushes supports macOS and Linux only.
  it.skipIf(process.platform === "win32")("offers direct-apns once apns.json and its key load", async () => {
    const root = await bridgeHome();
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    await writeFile(path.join(root, "AuthKey_ABCDE12345.p8"), privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    await writeFile(path.join(root, "apns.json"), JSON.stringify({ keyId: "ABCDE12345", teamId: "TEAM123456", topic: "com.phren.ios",
      privateKeyPath: "AuthKey_ABCDE12345.p8" }), { mode: 0o600 });
    const push = new ApprovalPushService();
    await push.start();
    expect(push.status.configured).toBe(true);
    expect(approvalPushCapability(push.status)).toBe("direct-apns");
    expect(approvalPushCheck({ capabilities: { approvalPush: "direct-apns" } })).toEqual({ configured: true });
  });

  it("sends a relay-registered phone's alert encrypted, signed, and drops it when the relay says it's gone", async () => {
    await bridgeHome();
    const key = randomBytes(32).toString("base64url");
    const relay = { url: "https://push.example.com", relayId: "r".repeat(48), secret: "s".repeat(43), key };
    const push = new ApprovalPushService();
    await push.start();
    await push.register({ ...device, token: undefined, relay });
    expect(push.available).toBe(true);
    expect(approvalPushCapability(push.status)).toBe("relay");

    const payload = approvalPushPayload({ binding: device.deviceID, provider: "claude", question: false,
      expiresAt: "2026-09-19T20:00:55.000Z", message: "x".repeat(5_000) }, device.hostID);
    let sent: { url: string; headers: Record<string, string>; body: string } | undefined;
    const fetcher = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      sent = { url, headers: init.headers, body: init.body };
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await sendThroughRelay(relay, payload, { expiration: "0", collapseId: "c" }, fetcher, () => 1_000_000)).toBe("sent");
    expect(sent!.url).toBe("https://push.example.com/v1/send");
    expect(sent!.headers["x-phren-signature"]).toBe(relaySignature(relay.secret, "1000", sent!.body));
    const request = JSON.parse(sent!.body) as { ciphertext: string; category: string };
    expect(request.category).toBe("PHREN_AGENT_APPROVAL");
    expect(request.ciphertext.length).toBeLessThanOrEqual(RELAY_MAX_CIPHERTEXT);
    const sealed = Buffer.from(request.ciphertext, "base64url");
    const decipher = createDecipheriv("chacha20-poly1305", Buffer.from(key, "base64url"), sealed.subarray(0, 12), { authTagLength: 16 });
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    const content = JSON.parse(Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()]).toString("utf8"));
    expect(content).toMatchObject({ t: "Claude needs approval", c: "PHREN_AGENT_APPROVAL", p: { binding: device.deviceID, host: device.hostID } });

    const gone = (async () => new Response("{}", { status: 410 })) as unknown as typeof fetch;
    expect(await sendThroughRelay(relay, payload, { expiration: "0", collapseId: "c" }, gone)).toBe("gone");
    expect(relayCiphertext(key, { aps: { alert: { title: "t", body: "b" } } })).not.toBe(relayCiphertext(key, { aps: { alert: { title: "t", body: "b" } } }));
  });
});

import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { apnsPayload, clientAddress, createRelayServer, MAX_SKEW_SECONDS, parseSend, RateLimiter, Relay, RelayError, ReplayGuard, signRequest } from "./index.js";
import type { ApnsSend } from "./apns.js";

const token = "a".repeat(64);
const relay = new Relay(randomBytes(32));

describe("relay ids and signatures", () => {
  it("recovers the device token and environment from its own relay id, and nothing from another relay's", () => {
    const { relayId, secret } = relay.register(token, "production");
    expect(relay.resolve(relayId)).toEqual({ deviceToken: token, environment: "production" });
    expect(relay.resolve(relay.register(token, "sandbox").relayId).environment).toBe("sandbox");
    expect(secret).toBe(relay.secretFor(relayId));
    expect(() => new Relay(randomBytes(32)).resolve(relayId)).toThrow(RelayError);
    expect(() => relay.resolve("not-a-relay-id")).toThrow(RelayError);
    expect(() => relay.register("not a token", "production")).toThrow(RelayError);
  });

  it("accepts a fresh signature and refuses a wrong one, a stale one and a replay", () => {
    const { relayId, secret } = relay.register(token, "production");
    const now = Date.now(), timestamp = String(Math.floor(now / 1000)), body = '{"kind":"alert"}';
    const signature = signRequest(secret, timestamp, body);
    expect(() => relay.verify(relayId, timestamp, body, signature, now)).not.toThrow();
    expect(() => relay.verify(relayId, timestamp, body + " ", signature, now)).toThrow("Bad signature.");
    const old = String(Math.floor(now / 1000) - MAX_SKEW_SECONDS - 1);
    expect(() => relay.verify(relayId, old, body, signRequest(secret, old, body), now)).toThrow(/too old/);
    const guard = new ReplayGuard();
    guard.check(signature, now);
    expect(() => guard.check(signature, now + 1000)).toThrow(/already delivered/);
  });

  it("limits sends per phone per window", () => {
    const limit = new RateLimiter(2, 60_000);
    expect([limit.allow("x", 0), limit.allow("x", 1), limit.allow("x", 2)]).toEqual([true, true, false]);
    expect(limit.allow("x", 60_001)).toBe(true);
  });

  it("sends Apple only a placeholder and the ciphertext", () => {
    const request = parseSend(JSON.stringify({ kind: "alert", ciphertext: "Q2lwaGVydGV4dC1ibG9iLTEy", collapseId: "approval-1", category: "PHREN_APPROVAL" }));
    expect(apnsPayload(request)).toEqual({
      aps: { alert: { title: "phren", body: "New activity" }, sound: "default", "mutable-content": 1, category: "PHREN_APPROVAL" },
      e: "Q2lwaGVydGV4dC1ibG9iLTEy",
    });
    expect(() => parseSend(JSON.stringify({ kind: "alert", ciphertext: "x".repeat(3000) }))).toThrow(/too long/);
    expect(() => parseSend(JSON.stringify({ kind: "liveactivity", ciphertext: "Q2lwaGVydGV4dC1ibG9iLTEy" }))).toThrow(/Unsupported/);
  });
});

describe("relay server", () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  async function start(send: ApnsSend) {
    const server = createRelayServer({ relay, send });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    close = () => server.close();
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("registers a phone, then delivers a Hook's signed notification to Apple once", async () => {
    const delivered: unknown[] = [];
    const base = await start(async (deviceToken, environment, payload, headers) => {
      delivered.push({ deviceToken, environment, payload, headers });
      return { ok: true, status: 200 };
    });
    const registered = await (await fetch(`${base}/v1/register`, { method: "POST", body: JSON.stringify({ deviceToken: token.toUpperCase(), environment: "sandbox" }) })).json() as { relayId: string; secret: string };
    const body = JSON.stringify({ kind: "alert", ciphertext: "Q2lwaGVydGV4dC1ibG9iLTEy", collapseId: "approval-7", expiration: 0 });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = { "x-phren-relay": registered.relayId, "x-phren-timestamp": timestamp,
      "x-phren-signature": signRequest(registered.secret, timestamp, body) };
    const sent = await fetch(`${base}/v1/send`, { method: "POST", headers, body });
    expect(sent.status).toBe(200);
    expect(delivered).toEqual([{ deviceToken: token, environment: "sandbox", headers: { collapseId: "approval-7", expiration: 0 },
      payload: { aps: { alert: { title: "phren", body: "New activity" }, sound: "default", "mutable-content": 1 }, e: "Q2lwaGVydGV4dC1ibG9iLTEy" } }]);
    expect((await fetch(`${base}/v1/send`, { method: "POST", headers, body })).status).toBe(409);
    const forged = await fetch(`${base}/v1/send`, { method: "POST", headers: { ...headers, "x-phren-signature": "x".repeat(43) }, body });
    expect(forged.status).toBe(401);
    expect(delivered).toHaveLength(1);
  });

  it("tells the Hook when Apple no longer knows the phone", async () => {
    const base = await start(async () => ({ ok: false, status: 410, reason: "Unregistered" }));
    const { relayId, secret } = relay.register(token, "production");
    const body = JSON.stringify({ kind: "alert", ciphertext: "Q2lwaGVydGV4dC1ibG9iLTEy" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await fetch(`${base}/v1/send`, { method: "POST", body,
      headers: { "x-phren-relay": relayId, "x-phren-timestamp": timestamp, "x-phren-signature": signRequest(secret, timestamp, body) } });
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ code: "unregistered" });
  });

  it("refuses an oversized body and answers health", async () => {
    const base = await start(async () => ({ ok: true, status: 200 }));
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const big = await fetch(`${base}/v1/register`, { method: "POST", body: "x".repeat(9000) });
    expect(big.status).toBe(413);
  });

  it("limits registrations by the address the proxy saw, not one the client wrote", async () => {
    const server = createRelayServer({ relay, send: async () => ({ ok: true, status: 200 }), registerLimit: new RateLimiter(2, 60_000) });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    close = () => server.close();
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const register = (spoof: string) => fetch(`${base}/v1/register`, { method: "POST",
      headers: { "x-forwarded-for": `${spoof}, 203.0.113.9` }, body: JSON.stringify({ deviceToken: token }) });
    expect((await register("1.1.1.1")).status).toBe(200);
    expect((await register("2.2.2.2")).status).toBe(200);
    expect((await register("3.3.3.3")).status).toBe(429);
    expect(clientAddress({ headers: {}, socket: { remoteAddress: "127.0.0.1" } } as never)).toBe("127.0.0.1");
  });

  it("caps notifications to Apple across all phones, and refuses rather than forget a replay when full", async () => {
    const delivered: string[] = [];
    const server = createRelayServer({ relay, sendBudget: new RateLimiter(1, 60_000),
      send: async deviceToken => { delivered.push(deviceToken); return { ok: true, status: 200 }; } });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    close = () => server.close();
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const sendTo = (deviceToken: string) => {
      const { relayId, secret } = relay.register(deviceToken, "production");
      const body = JSON.stringify({ kind: "alert", ciphertext: "Q2lwaGVydGV4dC1ibG9iLTEy" });
      const timestamp = String(Math.floor(Date.now() / 1000));
      return fetch(`${base}/v1/send`, { method: "POST", body,
        headers: { "x-phren-relay": relayId, "x-phren-timestamp": timestamp, "x-phren-signature": signRequest(secret, timestamp, body) } });
    };
    expect((await sendTo("b".repeat(64))).status).toBe(200);
    expect((await sendTo("c".repeat(64))).status).toBe(503);
    expect(delivered).toHaveLength(1);
    const guard = new ReplayGuard(1);
    guard.check("one");
    expect(() => guard.check("two")).toThrow(RelayError);
  });
});

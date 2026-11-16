import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bodyDigest, deviceKeys, OWNER_PROOF_HEADER, OwnerProof } from "./owner-proof.js";

function phone() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  return { privateKey, raw: raw.toString("base64") };
}
type Phone = ReturnType<typeof phone>;
function signed(device: Phone, fields: Partial<{ method: string; path: string; body: string; at: string; nonce: string }> = {}) {
  const payload = Buffer.from(JSON.stringify({
    domain: "phren-owner-request-v1", nonce: fields.nonce ?? randomUUID(), at: fields.at ?? new Date(NOW).toISOString(),
    method: fields.method ?? "POST", path: fields.path ?? "/v1/authority", body: fields.body ?? bodyDigest(Buffer.from(BODY)),
  }));
  return Buffer.from(JSON.stringify({ payload: payload.toString("base64"), signature: sign(null, payload, device.privateKey).toString("base64"), publicKey: device.raw })).toString("base64url");
}
const NOW = Date.parse("2026-11-14T12:00:00Z");
const BODY = '{"project":"phren","release":"go"}';
const request = (proof?: string, method = "POST") => ({ method, headers: proof ? { [OWNER_PROOF_HEADER]: proof } : {} });

describe("owner proof", () => {
  let root: string, owner: Phone, proof: OwnerProof;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "owner-proof-"));
    owner = phone();
    proof = new OwnerProof({ root, keys: async () => new Set([owner.raw]), now: () => NOW });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));
  const check = (proofHeader: string | undefined, data: Record<string, unknown> = {}, pathname = "/v1/authority", digest = bodyDigest(Buffer.from(BODY))) =>
    proof.check(request(proofHeader), pathname, data, digest);

  it("lets unsigned owner actions through until the phone first signs, then refuses them", async () => {
    await expect(check(undefined)).resolves.toBeUndefined();
    await expect(check(signed(owner))).resolves.toBeUndefined();
    // Windows has no POSIX mode bits.
    if (process.platform !== "win32") expect((await stat(path.join(root, "owner-proof.json"))).mode & 0o077).toBe(0);
    await expect(check(undefined)).rejects.toMatchObject({ status: 403, details: { code: "owner-proof-required" } });
    // A new Hook process reads the same state.
    const restarted = new OwnerProof({ root, keys: async () => new Set([owner.raw]), now: () => NOW });
    await expect(restarted.check(request(undefined), "/v1/agents/permission-mode", {}, "x")).rejects.toMatchObject({ status: 403 });
  });

  it("refuses a signature from another key, for another request, stale, or replayed", async () => {
    const stranger = phone();
    await expect(check(signed(stranger))).rejects.toMatchObject({ details: { code: "owner-proof-invalid" } });
    await expect(check(signed(owner, { path: "/v1/conductor/make" }))).rejects.toMatchObject({ status: 403 });
    await expect(check(signed(owner, { method: "DELETE" }))).rejects.toMatchObject({ status: 403 });
    await expect(check(signed(owner), {}, "/v1/authority", bodyDigest(Buffer.from('{"project":"other"}')))).rejects.toMatchObject({ status: 403 });
    await expect(check(signed(owner, { at: new Date(NOW - 301_000).toISOString() }))).rejects.toMatchObject({ status: 403 });
    await expect(check("not-a-proof")).rejects.toMatchObject({ status: 403 });
    const once = signed(owner);
    await expect(check(once)).resolves.toBeUndefined();
    await expect(check(once)).rejects.toMatchObject({ status: 403 });
  });

  it("leaves other routes and agent or peer requests to the route's own rules", async () => {
    await check(signed(owner));
    await expect(check(undefined, {}, "/v1/prompt")).resolves.toBeUndefined();
    await expect(check(undefined, { origin: { pane: "1" } })).resolves.toBeUndefined();
    await expect(proof.check({ method: "POST", headers: { "x-phren-origin": "peer" } }, "/v1/authority", {}, "x")).resolves.toBeUndefined();
    // Removing a phone's notifications stays possible from `phren unpair`.
    await expect(check(undefined, {}, "/v1/push/forget")).resolves.toBeUndefined();
  });

  it("only paired phone keys on the restricted dispatch command can sign", () => {
    const key = (comment: string, options = 'restrict,pty,command="sh ~/.local/share/phren/bridge/dispatch"') => {
      const wire = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.from(owner.raw, "base64")]);
      return `${options} ssh-ed25519 ${wire.toString("base64")} ${comment}`;
    };
    expect([...deviceKeys(key("phren-iphone"))]).toEqual([owner.raw]);
    expect([...deviceKeys(key("phren-android"))]).toEqual([owner.raw]);
    expect(deviceKeys([key("phren-computer"), key("phren-gitboy"), key("phren-iphone", "restrict"), key("me@laptop", "")].join("\n")).size).toBe(0);
  });

  it("holds an unsigned terminal request for the phone once signing is on, but never the phone's own answer", async () => {
    let asked = 0;
    const confirm = async () => { asked++; };
    const waiting = (pathname: string) => proof.check({ method: "POST", headers: { "x-phren-owner-confirm": "wait" } }, pathname, {}, "x", confirm);
    // Before any phone signs, nothing is held.
    await expect(waiting("/v1/conductor/make")).resolves.toBeUndefined();
    expect(asked).toBe(0);
    await check(signed(owner));
    await expect(waiting("/v1/conductor/make")).resolves.toBeUndefined();
    expect(asked).toBe(1);
    await expect(waiting("/v1/owner-confirms/answer")).rejects.toMatchObject({ status: 403, details: { code: "owner-proof-required" } });
    // Without the header the old refusal stands.
    await expect(proof.check(request(undefined), "/v1/conductor/make", {}, "x", confirm)).rejects.toMatchObject({ status: 403 });
    // An agent's origin is the route's to refuse, never held.
    await expect(proof.check({ method: "POST", headers: { "x-phren-owner-confirm": "wait" } }, "/v1/conductor/make", { origin: "agent" }, "x", confirm)).resolves.toBeUndefined();
    expect(asked).toBe(1);
  });
});

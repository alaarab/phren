// Consolidated RC regression source. UNRUN under the owner's source-only policy.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { grantAdmin, makeTempDir } from "../test-helpers.js";
import { writeStoreRegistry } from "../store-registry.js";
import { configureConductorLease, conductorLeaseAuthority, requireAvailableConductorAuthority, revokeConductorLease, takeoverConductorLease } from "./conductor-lease.js";
import { paneIdentity, snapshot } from "./herdr.js";
import { recordConductor, readRoleState, resetRoleState } from "./conductor-role.js";
import { stopConductor } from "./server-launch.js";
import type { Json } from "./protocol.js";

vi.mock("./herdr.js", async original => ({ ...await original<object>(), snapshot: vi.fn(), paneIdentity: vi.fn() }));
vi.mock("./peers.js", async original => ({ ...await original<object>(), optionalHookPeers: async () => ({ peers: [] }) }));

const authority = "40000000-0000-4000-8000-000000000001";
let store: string, cleanup: () => void;
let ownerKey: { publicKey: KeyObject; privateKey: KeyObject }, ownerWire: string;
const place = { server: "default", pane: "p1", terminal: "terminal-1", source: "codex" as const, session: "40000000-0000-4000-8000-000000000005" };
const livePane = { pane_id: place.pane, terminal_id: place.terminal, agent: place.source, agent_status: "idle" };
function signed(route: string, body: Json) {
  // Independent wire encoding via JSON's sorted property whitelist, not the production signing helper.
  const keys = new Set<string>();
  const visit = (value: unknown) => { if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) { keys.add(key); visit(child); } };
  visit(body);
  const time = String(Date.now()), nonce = randomUUID();
  const digest = createHash("sha256").update(JSON.stringify(body, [...keys].sort())).digest("hex");
  return { "x-phren-owner-time": time, "x-phren-owner-nonce": nonce, "x-phren-owner-key": ownerWire,
    "x-phren-owner-signature": sign(null, Buffer.from(["phren-owner-v1", time, nonce, "POST", route, digest].join("\n")), ownerKey.privateKey).toString("base64") };
}
beforeEach(async () => {
  ({ path: store, cleanup } = makeTempDir("conductor-lease-")); grantAdmin(store);
  const root = path.join(store, "hook"); fs.mkdirSync(root); fs.writeFileSync(path.join(root, "computer-id"), authority);
  vi.stubEnv("PHREN_BRIDGE_HOME", root);
  vi.stubEnv("PHREN_PATH", store); vi.stubEnv("HOME", store); vi.stubEnv("USERPROFILE", store);
  fs.mkdirSync(path.join(store, ".ssh"), { mode: 0o700 });
  ownerKey = generateKeyPairSync("ed25519");
  ownerWire = Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"), ownerKey.publicKey.export({ type: "spki", format: "der" }).subarray(-32)]).toString("base64");
  fs.writeFileSync(path.join(store, ".ssh/authorized_keys"), `restrict,pty,command="sh ~/.local/share/phren/bridge/dispatch" ssh-ed25519 ${ownerWire} phren-iphone\n`, { mode: 0o600 });
  vi.mocked(snapshot).mockResolvedValue({ panes: [livePane] }); vi.mocked(paneIdentity).mockResolvedValue(place.session); resetRoleState();
  writeStoreRegistry(store, { version: 1, stores: [{ id: "11111111", name: "Personal", path: store, role: "primary", sync: "managed-git" }] });
  await configureConductorLease(store, { authorityComputerId: authority, confirm: true });
});
afterEach(() => { resetRoleState(); vi.unstubAllEnvs(); cleanup(); });

describe("store conductor ownership", () => {
  const claim = (id: string) => ({ computerId: "40000000-0000-4000-8000-000000000002", claimId: id, since: "2000-01-01T00:00:00.000Z" });
  const read = () => conductorLeaseAuthority(store, { storeId: "11111111", operation: "read" });
  it("accepts only one racing claimant and never expires an old offline holder", async () => {
    const contenders = [claim("40000000-0000-4000-8000-000000000003"), claim("40000000-0000-4000-8000-000000000004")];
    const results = await Promise.allSettled(contenders.map(candidate => conductorLeaseAuthority(store, { storeId: "11111111", operation: "claim", claim: candidate })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const state = (await read()).state;
    expect(state.holder?.since).toBe("2000-01-01T00:00:00.000Z");
    const loser = contenders.find(candidate => candidate.claimId !== state.holder?.claimId)!;
    await expect(conductorLeaseAuthority(store, { storeId: "11111111", operation: "claim", claim: loser })).rejects.toThrow("already has a conductor");
    expect((await read()).state.holder).toEqual(state.holder);
  });
  it("requires the exact reviewed holder and generation before owner revocation", async () => {
    const held = (await conductorLeaseAuthority(store, { storeId: "11111111", operation: "claim", claim: claim("40000000-0000-4000-8000-000000000003") })).state;
    await expect(revokeConductorLease(store, { confirm: true, expectedGeneration: held.generation - 1, holder: held.holder })).rejects.toThrow("changed since review");
    expect((await read()).state.holder).toEqual(held.holder);
    const body = { confirm: true, expectedGeneration: held.generation, holder: held.holder };
    const revoked = await revokeConductorLease(store, body, signed("/v1/conductor/lease/revoke", body));
    expect(revoked).toMatchObject({ existingWorkPreserved: true, state: { holder: null, generation: held.generation + 1 } });
    await expect(revokeConductorLease(store, { confirm: true, expectedGeneration: held.generation, holder: held.holder })).rejects.toThrow("changed since review");
  });
  it("atomically replaces the complete reviewed holder once, without freeing a launch slot", async () => {
    const held = (await conductorLeaseAuthority(store, { storeId: "11111111", operation: "claim", claim: claim("40000000-0000-4000-8000-000000000003") })).state;
    const body = { confirm: true, expectedGeneration: held.generation, holder: held.holder, computerId: authority, place };
    const results = await Promise.allSettled([1, 2].map(() => takeoverConductorLease(store, body, signed("/v1/conductor/lease/takeover", body))));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const replaced = (await read()).state;
    expect(replaced).toMatchObject({ generation: held.generation + 1, holder: { computerId: authority, place } });
    expect(replaced.holder!.claimId).not.toBe(held.holder!.claimId);
    expect((await readRoleState())?.conductor).toMatchObject({ pane: place.pane, session: place.session, by: "owner" });
    await expect(takeoverConductorLease(store, body, signed("/v1/conductor/lease/takeover", body))).rejects.toThrow("changed since it was reviewed");
    await expect(conductorLeaseAuthority(store, { storeId: "11111111", operation: "claim", claim: claim(randomUUID()) })).rejects.toThrow("already has a conductor");
  });
  it("rejects a changed full holder with the same claim ID and generation", async () => {
    const held = (await conductorLeaseAuthority(store, { storeId: "11111111", operation: "claim", claim: claim(randomUUID()) })).state;
    const body = { confirm: true, expectedGeneration: held.generation, holder: { ...held.holder!, since: "2001-01-01T00:00:00.000Z" }, computerId: authority, place };
    await expect(takeoverConductorLease(store, body, signed("/v1/conductor/lease/takeover", body))).rejects.toThrow("exact conductor identity changed");
    expect((await read()).state).toEqual(held);
  });
  it("rejects unsigned internal release and takeover rather than trusting a computer's boolean", async () => {
    const held = (await conductorLeaseAuthority(store, { storeId: "11111111", operation: "claim", claim: claim(randomUUID()) })).state;
    await expect(conductorLeaseAuthority(store, { storeId: "11111111", operation: "release", claim: held.holder, expectedGeneration: held.generation })).rejects.toMatchObject({ status: 403 });
    await expect(conductorLeaseAuthority(store, { storeId: "11111111", operation: "takeover", claim: { computerId: authority, claimId: randomUUID(), since: "2026-10-03T00:00:00.000Z", place }, holder: held.holder, expectedGeneration: held.generation })).rejects.toMatchObject({ status: 403 });
    expect((await read()).state).toEqual(held);
  });
  it("rejects a stale session before replacing the holder", async () => {
    const held = (await conductorLeaseAuthority(store, { storeId: "11111111", operation: "claim", claim: claim(randomUUID()) })).state;
    const body = { confirm: true, expectedGeneration: held.generation, holder: held.holder, computerId: authority, place };
    vi.mocked(paneIdentity).mockResolvedValue(randomUUID());
    await expect(takeoverConductorLease(store, body, signed("/v1/conductor/lease/takeover", body))).rejects.toMatchObject({ status: 409, details: { code: "lease-target-changed" } });
    expect((await read()).state).toEqual(held);
  });
  it("rejects owner-signed body tampering at the authority before a lease mutation", async () => {
    const held = (await conductorLeaseAuthority(store, { storeId: "11111111", operation: "claim", claim: claim(randomUUID()) })).state;
    const body = { confirm: true, expectedGeneration: held.generation, holder: held.holder };
    const headers = signed("/v1/conductor/lease/revoke", { ...body, expectedGeneration: held.generation + 1 });
    await expect(revokeConductorLease(store, body, headers)).rejects.toMatchObject({ status: 403 });
    expect((await read()).state).toEqual(held);
  });
  it("preserves the lease when the owner stops the role while the authority is offline", async () => {
    const localClaim = { ...claim(randomUUID()), computerId: authority, place };
    await conductorLeaseAuthority(store, { storeId: "11111111", operation: "claim", claim: localClaim });
    fs.writeFileSync(path.join(store, ".runtime/conductor-claim.json"), JSON.stringify(localClaim));
    await recordConductor(place.server, livePane, "owner", place.session);
    const leaseBytes = fs.readFileSync(path.join(store, ".runtime/conductor-lease.json"), "utf8");
    fs.writeFileSync(path.join(store, ".config/conductor-authority.json"), JSON.stringify({ version: 1, storeId: "11111111", authorityComputerId: "40000000-0000-4000-8000-000000000099" }));
    await expect(requireAvailableConductorAuthority(store)).rejects.toThrow("offline, unlinked or ambiguous");
    expect(await stopConductor({ paneId: place.pane })).toMatchObject({ ok: true, stopped: true, leasePreserved: true });
    expect((await readRoleState())?.conductor).toBeNull();
    expect(fs.readFileSync(path.join(store, ".runtime/conductor-lease.json"), "utf8")).toBe(leaseBytes);
  });
  it("retains the new reservation and reports partial adoption when the local claim cannot be saved", async () => {
    const held = (await conductorLeaseAuthority(store, { storeId: "11111111", operation: "claim", claim: claim(randomUUID()) })).state;
    fs.mkdirSync(path.join(store, ".runtime/conductor-claim.json"));
    const body = { confirm: true, expectedGeneration: held.generation, holder: held.holder, computerId: authority, place };
    await expect(takeoverConductorLease(store, body, signed("/v1/conductor/lease/takeover", body))).rejects.toMatchObject({ status: 409, details: { code: "lease-adoption-incomplete", existingWorkPreserved: true } });
    expect((await read()).state).toMatchObject({ generation: held.generation + 1, holder: { computerId: authority, place } });
    expect((await readRoleState())?.conductor).toBeUndefined();
  });
  it("refuses damaged durable lease state instead of silently freeing the store", async () => {
    fs.mkdirSync(path.join(store, ".runtime"), { recursive: true });
    fs.writeFileSync(path.join(store, ".runtime/conductor-lease.json"), '{"holder":');
    await expect(read()).rejects.toThrow();
    await expect(conductorLeaseAuthority(store, { storeId: "11111111", operation: "claim", claim: claim("40000000-0000-4000-8000-000000000003") })).rejects.toThrow();
  });
});

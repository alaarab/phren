// Consolidated RC regression source. UNRUN under the owner's development policy.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import path from "node:path";
import { grantAdmin, makeTempDir } from "../test-helpers.js";
import { writeStoreRegistry } from "../store-registry.js";
import { configureConductorLease, conductorLeaseAuthority, changeConductorLease, revokeConductorLease, reserveConductorLease } from "./conductor-lease.js";
import { readStoreLease } from "./harness/store-lease.js";
const authority = "40000000-0000-4000-8000-000000000001";
let store: string, cleanup: () => void;
beforeEach(async () => {
  ({ path: store, cleanup } = makeTempDir("conductor-lease-")); grantAdmin(store);
  const root = path.join(store, "hook"); fs.mkdirSync(root); fs.writeFileSync(path.join(root, "computer-id"), authority);
  vi.stubEnv("PHREN_BRIDGE_HOME", root);
  writeStoreRegistry(store, { version: 1, stores: [{ id: "11111111", name: "Personal", path: store, role: "primary", sync: "managed-git" }] });
  await configureConductorLease(store, { authorityComputerId: authority, confirm: true });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); cleanup(); });
describe("one store conductor authority", () => {
  const read = () => conductorLeaseAuthority(store, { storeId: "11111111", operation: "read" });
  const acquire = (launchId = randomUUID()) => changeConductorLease(store, "acquire", { expectedGeneration: 0, computerId: authority, launchId, confirm: true });
  it("accepts one racing owner grant, shares it across API surfaces and never expires it", async () => {
    const results = await Promise.allSettled([acquire(), acquire()]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const state = (await read()).state;
    expect((await readStoreLease(store)).holder).toMatchObject({ leaseId: state.holder!.claimId, launchId: state.holder!.launchId });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 365 * 86400000);
    expect((await read()).state.holder).toEqual(state.holder);
    expect(fs.existsSync(path.join(store, ".runtime/harness-conductor-lease.json"))).toBe(false);
  });
  it("refuses peer acquisition/release and consumes only one launch admission", async () => {
    await expect(conductorLeaseAuthority(store, { storeId: "11111111", operation: "claim" })).rejects.toThrow();
    await expect(conductorLeaseAuthority(store, { storeId: "11111111", operation: "release" })).rejects.toThrow();
    const launchId = randomUUID();
    await expect(reserveConductorLease(store, launchId)).rejects.toThrow("signed owner lease");
    const held = (await acquire(launchId)).state;
    await reserveConductorLease(store, launchId);
    await expect(reserveConductorLease(store, launchId)).rejects.toThrow("already used");
    expect((await read()).state.holder).toMatchObject({ ...held.holder, admitted: true });
  });
  it("requires the exact reviewed holder and generation before owner revocation", async () => {
    const held = (await acquire()).state;
    await expect(revokeConductorLease(store, { confirm: true, expectedGeneration: held.generation - 1, holder: held.holder })).rejects.toThrow("changed since review");
    expect((await read()).state.holder).toEqual(held.holder);
    const revoked = await revokeConductorLease(store, { confirm: true, expectedGeneration: held.generation, holder: held.holder });
    expect(revoked).toMatchObject({ existingWorkPreserved: true, state: { holder: null, generation: held.generation + 1 } });
    await expect(revokeConductorLease(store, { confirm: true, expectedGeneration: held.generation, holder: held.holder })).rejects.toThrow("changed since review");
  });
  it("refuses damaged durable state instead of silently freeing the store", async () => {
    fs.mkdirSync(path.join(store, ".runtime"), { recursive: true });
    fs.writeFileSync(path.join(store, ".runtime/conductor-lease.json"), '{"holder":', { mode: 0o600 });
    await expect(read()).rejects.toThrow();
    await expect(acquire()).rejects.toThrow();
  });
});

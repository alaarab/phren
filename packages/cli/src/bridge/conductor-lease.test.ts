// Consolidated RC regression source. UNRUN under the owner's build-only policy.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import path from "node:path";
import { grantAdmin, makeTempDir } from "../test-helpers.js";
import { writeStoreRegistry } from "../store-registry.js";
import { configureConductorLease, conductorLeaseAuthority, revokeConductorLease } from "./conductor-lease.js";

const authority = "40000000-0000-4000-8000-000000000001";
let store: string, cleanup: () => void;
beforeEach(async () => {
  ({ path: store, cleanup } = makeTempDir("conductor-lease-")); grantAdmin(store);
  const root = path.join(store, "hook"); fs.mkdirSync(root); fs.writeFileSync(path.join(root, "computer-id"), authority);
  vi.stubEnv("PHREN_BRIDGE_HOME", root);
  writeStoreRegistry(store, { version: 1, stores: [{ id: "11111111", name: "Personal", path: store, role: "primary", sync: "managed-git" }] });
  await configureConductorLease(store, { authorityComputerId: authority, confirm: true });
});
afterEach(() => { vi.unstubAllEnvs(); cleanup(); });

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
    const revoked = await revokeConductorLease(store, { confirm: true, expectedGeneration: held.generation, holder: held.holder });
    expect(revoked).toMatchObject({ existingWorkPreserved: true, state: { holder: null, generation: held.generation + 1 } });
    await expect(revokeConductorLease(store, { confirm: true, expectedGeneration: held.generation, holder: held.holder })).rejects.toThrow("changed since review");
  });
  it("refuses damaged durable lease state instead of silently freeing the store", async () => {
    fs.mkdirSync(path.join(store, ".runtime"), { recursive: true });
    fs.writeFileSync(path.join(store, ".runtime/conductor-lease.json"), '{"holder":');
    await expect(read()).rejects.toThrow();
    await expect(conductorLeaseAuthority(store, { storeId: "11111111", operation: "claim", claim: claim("40000000-0000-4000-8000-000000000003") })).rejects.toThrow();
  });
  it("checks the complete old holder at the authority and permits only one reviewed takeover", async () => {
    const held = (await conductorLeaseAuthority(store, { storeId: "11111111", operation: "claim", claim: claim("40000000-0000-4000-8000-000000000003") })).state;
    const replacement = (claimId: string) => ({ ...claim(claimId), computerId: authority,
      place: { server: "default", pane: "w2:p1", terminal: "terminal
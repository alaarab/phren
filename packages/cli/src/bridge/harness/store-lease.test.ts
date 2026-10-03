// RC regression source only. UNRUN: pinned-peer transport doubles; no network/service/process.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { grantAdmin } from "../../test-helpers.js";
import { writeStoreRegistry } from "../../store-registry.js";
const transport = vi.hoisted(() => ({ peers: vi.fn(), request: vi.fn() }));
vi.mock("../peers.js", () => ({ optionalHookPeers: transport.peers, peerRequest: transport.request }));
import { configureStoreLease, readStoreLease, requireLaunchLease } from "./store-lease.js";
let root: string, computerId: string;
beforeEach(async () => {
  root = await mkdtemp("/tmp/phren-store-lease-"); computerId = randomUUID(); vi.stubEnv("PHREN_BRIDGE_HOME", root);
  await writeFile(path.join(root, "computer-id"), computerId); transport.peers.mockReset(); transport.request.mockReset();
  grantAdmin(root);
  writeStoreRegistry(root, { version: 1, stores: [{ id: "12345678", name: "Personal", path: root, role: "primary", sync: "managed-git" }] });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
it("refuses a client-supplied store identity that is not the registered store", async () => {
  await expect(configureStoreLease(root, { storeId: "87654321", computerId })).rejects.toThrow("registered store identity");
  expect((await readStoreLease(root)).configured).toBe(false);
});
it("blocks every new launch when the fixed authority is offline and never selects another", async () => {
  const remoteId = randomUUID();
  await mkdir(path.join(root, ".config"), { recursive: true });
  await writeFile(path.join(root, ".config", "conductor-authority.json"), JSON.stringify({ version: 1, storeId: "12345678", authorityComputerId: remoteId }), { mode: 0o600 });
  transport.peers.mockResolvedValue({ peers: [{ name: "authority", hostKey: "unchanged-owner-pin" }] }); transport.request.mockRejectedValue(new Error("peer offline"));
  await expect(requireLaunchLease(root)).rejects.toThrow("offline, unlinked or ambiguous");
  await expect(readStoreLease(root, "12345678", true)).rejects.toThrow("not the store's lease authority");
  expect(transport.request).toHaveBeenCalledTimes(1);
});

// RC regression source only. UNRUN: pinned-peer requests are transport doubles; no network/service/process.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const transport = vi.hoisted(() => ({ peers: vi.fn(), request: vi.fn() }));
vi.mock("../peers.js", () => ({ hookPeers: transport.peers, peerRequest: transport.request }));
import { changeStoreLease, configureStoreLease, readStoreLease, requireLaunchLease } from "./store-lease.js";
let root: string, computerId: string;
beforeEach(async () => {
  root = await mkdtemp("/tmp/phren-store-lease-"); computerId = randomUUID(); vi.stubEnv("PHREN_BRIDGE_HOME", root);
  await writeFile(path.join(root, "computer-id"), computerId); transport.peers.mockReset(); transport.request.mockReset();
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
it("requires explicit owner acquisition, consumes one conductor admission and never expires its holder", async () => {
  await configureStoreLease(root, { storeId: "12345678", computerId });
  const launchId = randomUUID();
  await expect(requireLaunchLease(root, true, launchId)).rejects.toThrow("signed owner lease");
  const acquired = await changeStoreLease(root, "acquire", { computerId, launchId });
  await requireLaunchLease(root, true, launchId);
  await expect(requireLaunchLease(root, true, launchId)).rejects.toThrow("already used");
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 365 * 86400000);
  expect((await readStoreLease(root)).holder).toEqual(acquired.holder);
  await expect(changeStoreLease(root, "revoke", { expectedLeaseId: randomUUID() })).rejects.toThrow("lease changed");
  await changeStoreLease(root, "revoke", { expectedLeaseId: acquired.holder!.leaseId });
  expect((await readStoreLease(root)).holder).toBeNull(); vi.restoreAllMocks();
});
it("blocks every new launch when the fixed authority is offline and leaves authority selection intact", async () => {
  const remoteId = randomUUID(), pin = "ssh-ed25519 owner-verified-fixture";
  await mkdir(path.join(root, ".config"));
  await writeFile(path.join(root, ".config", "harness-lease-authority.json"), JSON.stringify({ version: 1, storeId: "12345678", computerId: remoteId, peerName: "authority", expectedHostKey: pin }), { mode: 0o600 });
  transport.peers.mockResolvedValue([{ name: "authority", hostKey: pin }]); transport.request.mockRejectedValue(new Error("peer offline"));
  await expect(requireLaunchLease(root)).rejects.toThrow("peer offline");
  await expect(readStoreLease(root, "12345678", true)).rejects.toThrow("not the store's lease authority");
  expect(transport.request).toHaveBeenCalledTimes(1);
});

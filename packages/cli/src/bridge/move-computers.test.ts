import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as dispatchHosts from "./dispatch-hosts.js";
import * as harnesses from "./harnesses.js";
import { checkMovePeer, localMoveAvailability, moveComputers } from "./move-computers.js";
import * as peers from "./peers.js";

let home = "";
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "phren-move-computers-"));
  vi.stubEnv("HOME", home); vi.stubEnv("CLAUDE_CONFIG_DIR", ""); vi.stubEnv("PHREN_BRIDGE_HOME", path.join(home, "bridge"));
  vi.spyOn(harnesses, "harnessInventoryWithin").mockResolvedValue({ harnesses: [{ source: "claude", installed: true, usable: true,
    accounts: [{ id: "default", label: "Personal", key: "private-identity", usable: true, signedIn: true }] }] });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });

/** A usage read that never answers, as a forced read stuck on a slow network. */
const hanging = () => new Promise<never>(() => undefined);

it("answers without the Claude room when this computer's usage read is slow", async () => {
  const started = Date.now();
  const facts = await localMoveAvailability(null, hanging, false, 50);
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(facts.usagePending).toBe(true);
  const claude = facts.harnesses.find(row => row.source === "claude");
  expect(claude?.accounts?.[0]).toMatchObject({ id: "default", usable: true });
  expect(claude?.accounts?.[0]).not.toHaveProperty("fiveHourLeft");
});

it("says the usage read failed rather than leaving the room silently empty", async () => {
  const facts = await localMoveAvailability(null, async () => { throw new Error("offline"); }, false, 50);
  expect(facts).toMatchObject({ usageError: "Claude usage could not be read on this computer." });
  expect(facts).not.toHaveProperty("usagePending");
});

it("does not move a Claude chat to a peer whose usage is still being read", async () => {
  // Without its room an exhausted login would look usable and win the choice.
  const peer = (usagePending?: true) => ({ name: "buildbox", request: async () => ({ computerId: "6f0c8a8e-2b7d-4c1e-9a55-1d2e3f4a5b6c", hasCheckout: true,
    ...(usagePending ? { usagePending } : {}), harnesses: [{ source: "claude", usable: true, accounts: [{ id: "default", label: "Personal", usable: true, signedIn: true }] }] }) });
  const host = (usagePending?: true) => peer(usagePending) as unknown as Parameters<typeof checkMovePeer>[0];
  await expect(checkMovePeer(host(true), "repo", { harness: "claude" } as Parameters<typeof checkMovePeer>[2])).rejects.toMatchObject({ status: 409, message: expect.stringContaining("still being read") });
  await expect(checkMovePeer(host(), "repo", { harness: "claude" } as Parameters<typeof checkMovePeer>[2])).resolves.toMatchObject({ account: "default" });
});

it("lists every computer while this one's usage is still pending", async () => {
  vi.spyOn(peers, "optionalHookPeers").mockResolvedValue({ peers: [{ name: "buildbox" }] } as Awaited<ReturnType<typeof peers.optionalHookPeers>>);
  let peerAsked = 0;
  vi.spyOn(dispatchHosts, "peerHost").mockImplementation(peer => ({ name: peer.name, request: async () => {
    peerAsked = Date.now();
    return { hasCheckout: true, harnesses: [{ source: "claude", usable: true, accounts: [{ id: "work", label: "Work", usable: true, signedIn: true, fiveHourLeft: 40 }] }] };
  } }) as unknown as ReturnType<typeof dispatchHosts.peerHost>);
  let localDone = 0;
  const answer = await moveComputers(null, "self", () => localMoveAvailability(null, hanging, false, 300).finally(() => { localDone = Date.now(); })) as { computers: Record<string, unknown>[] };
  // The peer is asked while this computer's read is still waiting, not after it.
  expect(peerAsked).toBeGreaterThan(0);
  expect(peerAsked).toBeLessThan(localDone);
  expect(answer.computers.map(row => [row.name, row.online, row.usagePending])).toEqual([["self", true, true], ["buildbox", true, undefined]]);
  expect(answer.computers[1]).toMatchObject({ harnesses: [{ source: "claude", accounts: [{ id: "work", fiveHourLeft: 40 }] }] });
});
